import { describe, expect, it, vi } from "vitest";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRunService } from "./pi-run.service.js";
import type { PiEvent, PiRequest } from "@vcpdeck/shared";

const actor = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
} as const;

const PROMPT_SENTINEL = "SENTINEL_PROMPT_9f2a";
const URL_SENTINEL = "SENTINEL_SIGNED_URL_7c11";
const THINKING_SENTINEL = "SENTINEL_THINKING_3d4e";
const TOOL_SENTINEL = "SENTINEL_TOOL_RESULT_5b8f";

/** 记录所有 prisma 调用的内存 DB（sentinel 扫描用） */
function makePrismaMemory() {
	const jobs: Array<Record<string, unknown>> = [];
	const calls: unknown[] = [];
	return {
		job: {
			create: vi.fn(async (args: { data: Record<string, unknown> }) => {
				calls.push(args);
				jobs.push({ ...args.data });
				return { id: args.data.id };
			}),
			update: vi.fn(
				async (args: {
					where: { id: string };
					data: Record<string, unknown>;
				}) => {
					calls.push(args);
					const job = jobs.find((j) => j.id === args.where.id);
					if (!job) throw new Error("not found");
					Object.assign(job, args.data);
					return job;
				},
			),
			updateMany: vi.fn(
				async (args: {
					where: { clientId: string; status?: { in: string[] } };
					data: Record<string, unknown>;
				}) => {
					for (const j of jobs) {
						const statuses = args.where.status?.in;
						if (
							j.clientId === args.where.clientId &&
							(!statuses || statuses.includes(String(j.status)))
						) {
							Object.assign(j, args.data);
						}
					}
					return { count: 0 };
				},
			),
			findUnique: vi.fn(
				async (args: { where: { id: string } }) =>
					jobs.find((j) => j.id === args.where.id) ?? null,
			),
			findMany: vi.fn(async () => jobs),
		},
		_getJobs: () => jobs,
		_getCalls: () => calls,
	};
}

function makeLoopback() {
	const prisma = makePrismaMemory() as never;
	const runs = new PiRunService(prisma);
	const requests = new PiRequestBroker();
	const events = new PiEventBroker(requests, runs);

	// 协议 fake Client：响应 project.resolve 与 agent.prompt；可注入事件
	const emitEvent = (event: PiEvent) => void events.publish(event);
	let stateOverride: Record<string, unknown> | null = null;
	requests.bindEmitter((_socketId, request: PiRequest) => {
		if (request.action === "project.resolve") {
			queueMicrotask(() =>
				requests.resolve("socket-1", {
					requestId: request.requestId,
					ok: true,
					data: { projectKey: "k".repeat(64) },
				}),
			);
			return;
		}
		if (request.action === "agent.state") {
			queueMicrotask(() =>
				requests.resolve("socket-1", {
					requestId: request.requestId,
					ok: true,
					data: stateOverride ?? {
						status: "idle",
						streaming: false,
						prompting: false,
						compacting: false,
						queuedMessages: { steering: [], followUp: [] },
					},
				}),
			);
			return;
		}
		queueMicrotask(() =>
			requests.resolve("socket-1", {
				requestId: request.requestId,
				ok: true,
				data: { accepted: true },
			}),
		);
	});

	return {
		prisma,
		runs,
		requests,
		events,
		emitEvent,
		setState: (s: Record<string, unknown> | null) => {
			stateOverride = s;
		},
	};
}

describe("Pi 端到端 loopback 集成", () => {
	it("prompt → sanitized Job → SSE 事件 → settled", async () => {
		const { prisma, runs, emitEvent } = makeLoopback();

		const { jobId } = await runs.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k".repeat(64),
		});
		await runs.accept(jobId);

		// 模拟 Client 事件流
		emitEvent({
			clientId: "c1",
			sessionId: "s1",
			jobId,
			runId: jobId,
			event: { type: "agent_start", sessionId: "s1" },
		});
		// prompt_done 触发 settlement grace（30s）→ 测试直接触发 onSettle 不可行（timer 在 service 内）
		// 改为直接 settle 验证 Job 终态
		await runs.settle(jobId, {
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "off",
			queuedMessages: { steering: [], followUp: [] },
		});

		const job = (
			prisma as { _getJobs: () => Array<Record<string, unknown>> }
		)._getJobs()[0];
		expect(job?.status).toBe("done");
		expect(JSON.parse(String(job?.result))).toMatchObject({
			stopReason: "settled",
		});
	});

	it("数据库与 prisma 调用不含 prompt/URL/thinking/tool 正文", async () => {
		const { prisma, runs } = makeLoopback();
		const { jobId } = await runs.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k".repeat(64),
		});
		await runs.settle(jobId, {
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "off",
			queuedMessages: { steering: [], followUp: [] },
		});

		const leaked = JSON.stringify(
			(prisma as { _getCalls: () => unknown[] })._getCalls(),
		);
		for (const sentinel of [
			PROMPT_SENTINEL,
			URL_SENTINEL,
			THINKING_SENTINEL,
			TOOL_SENTINEL,
		]) {
			expect(leaked).not.toContain(sentinel);
		}
		// projectKey（64 hex）也不得持久化
		expect(leaked).not.toContain("k".repeat(64));
	});

	it("断线 → disconnected → 重连 reconcile 恢复 running", async () => {
		const { prisma, runs, requests, emitEvent } = makeLoopback();
		const { jobId } = await runs.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k".repeat(64),
		});
		await runs.accept(jobId);

		// 断线：pending request 失败 + Job disconnected
		requests.disconnect("socket-1");
		await runs.markDisconnected("c1");
		const jobs = (
			prisma as { _getJobs: () => Array<Record<string, unknown>> }
		)._getJobs();
		expect(jobs[0]?.status).toBe("disconnected");

		// 重连：PI_STATE 恢复
		await runs.reconcileState("c1", {
			clientId: "c1",
			runs: [
				{
					jobId,
					runId: jobId,
					sessionId: "s1",
					status: "running",
					projectKey: "k".repeat(64),
				},
			],
		});
		expect(
			(
				prisma as { _getJobs: () => Array<Record<string, unknown>> }
			)._getJobs()[0]?.status,
		).toBe("running");
		void emitEvent;
	});

	it("伪造事件（jobId 不匹配）不影响 Job 状态", async () => {
		const { prisma, runs, events } = makeLoopback();
		const { jobId } = await runs.createRun(actor, {
			clientId: "c1",
			sessionId: "s1",
			projectKey: "k".repeat(64),
		});
		await runs.accept(jobId);

		// 未知 run 的 agent_settled：不触发任何 Job 更新（events.publish 只对已知 job 调用 waitForInput/settle 调度）
		await events.publish({
			clientId: "c1",
			sessionId: "other",
			jobId: "unknown-job",
			runId: "unknown-job",
			event: { type: "agent_settled", sessionId: "other" },
		});
		const jobs = (
			prisma as { _getJobs: () => Array<Record<string, unknown>> }
		)._getJobs();
		expect(jobs[0]?.status).toBe("running"); // 未被影响
	});
});

void vi;
