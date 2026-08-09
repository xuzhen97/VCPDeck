import { describe, expect, it, vi } from "vitest";
import {
	PI_ERROR_CODES,
	type ActorContext,
	type PiStateReport,
} from "@vcpdeck/shared";
import { PiRunService } from "./pi-run.service.js";

const actor: ActorContext = {
	identityId: "user-1",
	displayName: "User",
	isAdmin: false,
	credentialId: null,
	sessionId: null,
	source: "web",
	requestId: "req-1",
};
const otherActor = { ...actor, identityId: "user-2", displayName: "Other" };
const input = { clientId: "c1", sessionId: "s1", projectKey: "k1" };
const activeStatuses = ["pending", "running", "waiting_input", "disconnected"];

function matches(value: unknown, condition: unknown): boolean {
	if (condition && typeof condition === "object" && !Array.isArray(condition)) {
		const where = condition as { in?: unknown[] };
		if (where.in) return where.in.includes(value);
	}
	return value === condition;
}

function prismaMock() {
	const jobs: Array<Record<string, unknown>> = [];
	const job = {
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			if (jobs.some((candidate) => candidate.id === args.data.id)) {
				throw { code: "P2002" };
			}
			const created = {
				payload: "{}",
				progress: null,
				result: null,
				errorCode: null,
				errorMessage: null,
				startedAt: null,
				finishedAt: null,
				createdAt: new Date(),
				...args.data,
			};
			jobs.push(created);
			return created;
		}),
		findUnique: vi.fn(
			async (args: { where: { id: string } }) =>
				jobs.find((candidate) => candidate.id === args.where.id) ?? null,
		),
		findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) =>
			jobs.filter((candidate) =>
				Object.entries(args?.where ?? {}).every(([key, value]) =>
					matches(candidate[key], value),
				),
			),
		),
		update: vi.fn(
			async (args: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const candidate = jobs.find((item) => item.id === args.where.id);
				if (!candidate) throw new Error("not found");
				Object.assign(candidate, args.data);
				return candidate;
			},
		),
		updateMany: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const candidate of jobs) {
					if (
						Object.entries(args.where).every(([key, value]) =>
							matches(candidate[key], value),
						)
					) {
						Object.assign(candidate, args.data);
						count += 1;
					}
				}
				return { count };
			},
		),
	};
	return { job, _jobs: jobs };
}

function setup() {
	const prisma = prismaMock();
	const service = new PiRunService(prisma as never);
	const current = () => prisma._jobs.find((job) => job.id === "s1")!;
	const ensure = () =>
		service.ensureSession(actor, { clientId: "c1", sessionId: "s1" });
	const start = async () => {
		await ensure();
		return service.startRun(actor, input);
	};
	const running = async () => {
		const run = await start();
		expect(await service.accept(run.jobId, run.runId)).toBe(true);
		return run;
	};
	return { prisma, service, current, ensure, start, running };
}

function report(runs: PiStateReport["runs"]): PiStateReport {
	return { clientId: "c1", runs };
}

function activeReport(
	runId: string,
	status: "running" | "waiting_input" = "running",
	projectKey = "k1",
) {
	return { jobId: "s1", runId, sessionId: "s1", status, projectKey } as const;
}

describe("PiRunService session CAS", () => {
	it("ensureSession 以 sessionId 幂等创建 idle agent.session", async () => {
		const { prisma, ensure } = setup();
		await ensure();
		await ensure();
		expect(prisma._jobs).toHaveLength(1);
		expect(prisma._jobs[0]).toMatchObject({
			id: "s1",
			clientId: "c1",
			type: "agent.session",
			status: "idle",
			payload: "{}",
			progress: null,
			createdByIdentityId: "user-1",
		});
	});

	it("并发唯一键冲突后校验 winner，不覆盖 Owner", async () => {
		const { prisma, service } = setup();
		prisma._jobs.push({
			id: "s1",
			clientId: "c1",
			type: "agent.session",
			status: "idle",
			payload: "{}",
			createdByIdentityId: "user-1",
			createdByName: "User",
		});
		prisma.job.findUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(prisma._jobs[0]);
		prisma.job.create.mockRejectedValueOnce({ code: "P2002" });
		await expect(
			service.ensureSession(otherActor, { clientId: "c1", sessionId: "s1" }),
		).resolves.toBeUndefined();
		expect(prisma.job.update).not.toHaveBeenCalled();
	});

	it("每次 startRun 保持 jobId 并生成新 runId", async () => {
		const { service, start } = setup();
		const first = await start();
		await service.finishRun(first.jobId, first.runId);
		const second = await service.startRun(actor, input);
		expect(first.jobId).toBe("s1");
		expect(second.jobId).toBe("s1");
		expect(second.runId).not.toBe(first.runId);
	});

	it("snapshot 只返回安全字段与 Owner 视图", async () => {
		const { service, start } = setup();
		const { runId } = await start();
		expect(await service.snapshot("s1", "user-2")).toEqual({
			jobId: "s1",
			sessionId: "s1",
			status: "pending",
			runId,
			ownerName: "User",
			isOwner: false,
		});
	});

	it("执行完整 run 状态矩阵并保持 progress=null", async () => {
		const { service, current, running } = setup();
		const run = await running();
		expect(await service.waitForInput(run.jobId, run.runId)).toBe(true);
		expect(await service.resume(run.jobId, run.runId)).toBe(true);
		expect(await service.finishRun(run.jobId, run.runId)).toBe(true);
		expect(current()).toMatchObject({
			status: "idle",
			payload: "{}",
			progress: null,
		});
		const next = await service.startRun(actor, input);
		expect(current()).toMatchObject({
			status: "pending",
			payload: JSON.stringify({ runId: next.runId }),
			progress: null,
			result: null,
			finishedAt: null,
			errorCode: null,
			errorMessage: null,
		});
	});

	it("done 可重开；error 不可自动重开", async () => {
		const { service, current, ensure } = setup();
		await ensure();
		expect(await service.completeSession("s1")).toBe(true);
		expect(await service.completeSession("s1")).toBe(true);
		await expect(service.startRun(actor, input)).resolves.toBeDefined();
		const runId = JSON.parse(String(current().payload)).runId as string;
		await service.failSession("s1", runId, "PI_WORKER_EXITED");
		await expect(service.startRun(actor, input)).rejects.toMatchObject({
			code: "PI_PROJECT_BUSY",
		});
	});

	it("无 runId complete 将 error 原子完成为 done", async () => {
		const { service, current, running } = setup();
		const run = await running();
		await service.failSession(run.jobId, run.runId, "PI_WORKER_EXITED");
		expect(await service.completeSession(run.jobId)).toBe(true);
		expect(current()).toMatchObject({ status: "done", payload: "{}" });
	});

	it("complete 处理 pending/active/disconnected 且 active 必须匹配 runId", async () => {
		for (const status of activeStatuses) {
			const { service, current, start } = setup();
			const run = await start();
			current().status = status;
			expect(await service.completeSession(run.jobId, "wrong")).toBe(false);
			expect(await service.completeSession(run.jobId, run.runId)).toBe(true);
			expect(current()).toMatchObject({
				status: "done",
				payload: "{}",
				progress: null,
			});
		}
	});

	it("提前到达的 Extension 不被 accept 覆盖", async () => {
		const { service, current, start } = setup();
		const run = await start();
		expect(await service.waitForInput(run.jobId, run.runId)).toBe(true);
		expect(await service.accept(run.jobId, run.runId)).toBe(false);
		expect(current().status).toBe("waiting_input");
	});

	it("complete 与 settlement 并发时 done 不回退 idle", async () => {
		const { service, current, running } = setup();
		const run = await running();
		await service.completeSession(run.jobId, run.runId);
		expect(await service.finishRun(run.jobId, run.runId)).toBe(false);
		expect(current().status).toBe("done");
	});

	it("旧 run 不能修改新 run 或释放新锁", async () => {
		const { service, current, running } = setup();
		const first = await running();
		await service.finishRun(first.jobId, first.runId);
		const second = await service.startRun(actor, input);
		expect(await service.waitForInput(first.jobId, first.runId)).toBe(false);
		expect(
			await service.failSession(first.jobId, first.runId, "PI_WORKER_EXITED"),
		).toBe(false);
		expect(current()).toMatchObject({
			status: "pending",
			payload: JSON.stringify({ runId: second.runId }),
		});
		expect(service.hasLock(second.jobId, second.runId)).toBe(true);
	});

	it("settlement timer 由 jobId+runId 精确隔离", async () => {
		vi.useFakeTimers();
		try {
			const { service, running } = setup();
			const first = await running();
			await service.scheduleSettlement(first.jobId, first.runId, vi.fn());
			await service.finishRun(first.jobId, first.runId);
			const second = await service.startRun(actor, input);
			const onSecond = vi.fn();
			await service.scheduleSettlement(second.jobId, second.runId, onSecond);
			service.cancelSettlement(first.jobId, first.runId);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(onSecond).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("旧 settlement callback 在新 run 后不得执行", async () => {
		vi.useFakeTimers();
		try {
			const { service, running } = setup();
			const first = await running();
			const onFirst = vi.fn();
			await service.scheduleSettlement(first.jobId, first.runId, onFirst);
			await service.finishRun(first.jobId, first.runId);
			await service.startRun(actor, input);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(onFirst).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("删除 reservation 仅允许静态状态并按 token rollback/commit", async () => {
		for (const status of ["idle", "done", "error"] as const) {
			const { service, current, ensure } = setup();
			await ensure();
			current().status = status;
			const reservation = await service.beginDelete("s1", actor.identityId);
			expect(reservation).toMatchObject({
				previousStatus: status,
				existingReservation: false,
			});
			expect(current()).toMatchObject({ status: "cancelled" });
			expect(await service.rollbackDelete("s1", reservation.deleteToken)).toBe(
				true,
			);
			expect(current()).toMatchObject({ status, payload: "{}" });
			const next = await service.beginDelete("s1", actor.identityId);
			expect(await service.commitDelete("s1", next.deleteToken)).toBe(true);
			expect(current()).toMatchObject({ status: "cancelled", payload: "{}" });
		}
	});

	it("delete 与 startRun 竞争时只有 reservation 取得 CAS", async () => {
		const { service, ensure } = setup();
		await ensure();
		const reservation = await service.beginDelete("s1", actor.identityId);
		await expect(service.startRun(actor, input)).rejects.toMatchObject({
			code: "PI_PROJECT_BUSY",
		});
		expect(await service.commitDelete("s1", reservation.deleteToken)).toBe(
			true,
		);
	});

	it("活动状态禁止删除，reservation 可幂等读取且不泄露 token", async () => {
		const { service, start } = setup();
		await start();
		await expect(
			service.beginDelete("s1", actor.identityId),
		).rejects.toMatchObject({ code: "PI_PROJECT_BUSY" });
		await service.finishRun(
			"s1",
			JSON.parse(
				JSON.stringify((await service.snapshot("s1", actor.identityId)).runId),
			),
		);
		const first = await service.beginDelete("s1", actor.identityId);
		expect(await service.beginDelete("s1", actor.identityId)).toEqual({
			...first,
			existingReservation: true,
		});
		expect(
			JSON.stringify(await service.snapshot("s1", actor.identityId)),
		).not.toContain(first.deleteToken);
	});

	it("畸形 run/delete payload 不得被识别或参与 CAS", async () => {
		const { service, current, running } = setup();
		const run = await running();
		current().payload = JSON.stringify({ runId: run.runId, extra: true });
		expect((await service.snapshot("s1", actor.identityId)).runId).toBeNull();
		expect(await service.listActiveByClient("c1")).toEqual([]);
		expect(await service.finishRun("s1", run.runId)).toBe(false);

		current().status = "cancelled";
		current().payload = JSON.stringify({
			deleteToken: "token",
			previousStatus: "running",
		});
		await expect(
			service.beginDelete("s1", actor.identityId),
		).rejects.toMatchObject({
			code: "PI_PROJECT_BUSY",
		});
		expect(await service.rollbackDelete("s1", "token")).toBe(false);
		expect(await service.commitDelete("s1", "token")).toBe(false);
	});

	it("所有新状态写均使用 updateMany CAS", async () => {
		const { prisma, service, running } = setup();
		const run = await running();
		await service.waitForInput(run.jobId, run.runId);
		await service.resume(run.jobId, run.runId);
		await service.finishRun(run.jobId, run.runId);
		expect(prisma.job.update).not.toHaveBeenCalled();
		for (const call of prisma.job.updateMany.mock.calls) {
			const where = call[0].where;
			expect(where).toHaveProperty("id", "s1");
			expect(where).toHaveProperty("payload");
			expect(where).toHaveProperty("status");
		}
	});
});

describe("PiRunService generation reconcile", () => {
	it("未 ready 或旧 socket 的 operation 抛 PI_STATE_PENDING", async () => {
		const { service } = setup();
		await service.markReconcilePending("c1", "socket-1");
		await expect(
			service.withReconciledClient("c1", async (lease) => lease.socketId),
		).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
		await expect(
			service.withReconciledSocket("c1", "old", async () => 1),
		).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("operation lease 跨 await 时新 REGISTER 排队", async () => {
		const { service } = setup();
		await service.markReconcilePending("c1", "socket-1");
		await service.reconcileGeneration("c1", "socket-1", report([]));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const operation = service.withReconciledClient("c1", async (lease) => {
			expect(lease.socketId).toBe("socket-1");
			await gate;
		});
		const pending = service.markReconcilePending("c1", "socket-2");
		await Promise.resolve();
		expect(
			await Promise.race([
				pending.then(() => "switched"),
				Promise.resolve("blocked"),
			]),
		).toBe("blocked");
		release();
		await operation;
		await pending;
		await expect(
			service.withReconciledClient("c1", async () => 1),
		).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("旧 generation reconcile/disconnect 在任何写入前退出", async () => {
		const { prisma, service, running, current } = setup();
		const run = await running();
		await service.markReconcilePending("c1", "new");
		prisma.job.updateMany.mockClear();
		await expect(
			service.reconcileGeneration(
				"c1",
				"old",
				report([activeReport(run.runId)]),
			),
		).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
		expect(await service.disconnectGeneration("c1", "old")).toBe(false);
		expect(prisma.job.updateMany).not.toHaveBeenCalled();
		expect(current().status).toBe("running");
	});

	it("markRunDisconnected 只 CAS matching active run", async () => {
		const { service, current, running } = setup();
		const run = await running();
		expect(await service.markRunDisconnected(run.jobId, "wrong")).toBe(false);
		expect(current().status).toBe("running");
		expect(await service.markRunDisconnected(run.jobId, run.runId)).toBe(true);
		expect(current()).toMatchObject({
			status: "disconnected",
			payload: JSON.stringify({ runId: run.runId }),
		});
	});

	it("当前 generation 断线 CAS disconnected，matching report 恢复", async () => {
		const { service, running, current } = setup();
		const run = await running();
		await service.markReconcilePending("c1", "socket-1");
		await service.reconcileGeneration(
			"c1",
			"socket-1",
			report([activeReport(run.runId)]),
		);
		expect(await service.disconnectGeneration("c1", "socket-1")).toBe(true);
		expect(current()).toMatchObject({
			status: "disconnected",
			payload: JSON.stringify({ runId: run.runId }),
		});
		await service.markReconcilePending("c1", "socket-2");
		const ack = await service.reconcileGeneration(
			"c1",
			"socket-2",
			report([activeReport(run.runId, "waiting_input")]),
		);
		expect(ack).toEqual({
			acceptedRunIds: [run.runId],
			closedRunIds: [],
			reportAgain: false,
		});
		expect(current().status).toBe("waiting_input");
	});

	it("matching idle/done summary 收敛 idle 并释放锁", async () => {
		for (const status of ["idle", "done"] as const) {
			const { service, running, current } = setup();
			const run = await running();
			await service.markReconcilePending("c1", "socket-1");
			const ack = await service.reconcileGeneration(
				"c1",
				"socket-1",
				report([{ jobId: "s1", runId: run.runId, sessionId: "s1", status }]),
			);
			expect(ack.acceptedRunIds).toEqual([run.runId]);
			expect(current()).toMatchObject({
				status: "idle",
				payload: "{}",
				progress: null,
			});
			expect(service.hasLock("s1", run.runId)).toBe(false);
		}
	});

	it("matching error summary 收敛安全 error 并释放锁", async () => {
		const { service, running, current } = setup();
		const run = await running();
		await service.markReconcilePending("c1", "socket-1");
		const ack = await service.reconcileGeneration(
			"c1",
			"socket-1",
			report([
				{ jobId: "s1", runId: run.runId, sessionId: "s1", status: "error" },
			]),
		);
		expect(ack.acceptedRunIds).toEqual([run.runId]);
		expect(current()).toMatchObject({
			status: "error",
			payload: "{}",
			progress: null,
			errorCode: "PI_WORKER_EXITED",
			errorMessage: "Pi worker exited unexpectedly",
		});
		expect(service.hasLock("s1", run.runId)).toBe(false);
	});

	it("DB 活动 run 未上报时安全失败，终态旧 active 要求 Client close", async () => {
		const { service, running, current } = setup();
		const run = await running();
		await service.markReconcilePending("c1", "socket-1");
		await service.reconcileGeneration("c1", "socket-1", report([]));
		expect(current()).toMatchObject({
			status: "error",
			payload: "{}",
			errorCode: "PI_CLIENT_RESTARTED",
			errorMessage: "Client restarted before the Pi run could be recovered",
		});
		current().status = "done";
		current().payload = "{}";
		await service.markReconcilePending("c1", "socket-2");
		const ack = await service.reconcileGeneration(
			"c1",
			"socket-2",
			report([activeReport(run.runId)]),
		);
		expect(ack).toEqual({
			acceptedRunIds: [],
			closedRunIds: [run.runId],
			reportAgain: true,
		});
		await expect(
			service.withReconciledClient("c1", async () => 1),
		).rejects.toMatchObject({ code: "PI_STATE_PENDING" });
	});

	it("同 projectKey 冲突 run 精确失败，Client abort 后二次报告 ready", async () => {
		const { prisma, service, running } = setup();
		const first = await running();
		await service.ensureSession(actor, { clientId: "c1", sessionId: "s2" });
		const second = await service.startRun(actor, {
			clientId: "c1",
			sessionId: "s2",
			projectKey: "k2",
		});
		await service.accept(second.jobId, second.runId);
		await service.markReconcilePending("c1", "socket-1");
		const ack = await service.reconcileGeneration(
			"c1",
			"socket-1",
			report([
				{
					jobId: "s1",
					runId: first.runId,
					sessionId: "s1",
					status: "running",
					projectKey: "same",
				},
				{
					jobId: "s2",
					runId: second.runId,
					sessionId: "s2",
					status: "running",
					projectKey: "same",
				},
			]),
		);
		expect(ack).toEqual({
			acceptedRunIds: [],
			closedRunIds: [first.runId, second.runId],
			reportAgain: true,
		});
		for (const jobId of ["s1", "s2"]) {
			expect(prisma._jobs.find((job) => job.id === jobId)).toMatchObject({
				status: "error",
				payload: "{}",
				errorCode: "PI_PROTOCOL_INVALID",
				errorMessage: "Pi protocol input was invalid",
			});
		}
		expect(service.hasLock(first.jobId, first.runId)).toBe(false);
		expect(service.hasLock(second.jobId, second.runId)).toBe(false);
		expect(
			await service.reconcileGeneration("c1", "socket-1", report([])),
		).toEqual({
			acceptedRunIds: [],
			closedRunIds: [],
			reportAgain: false,
		});
		await expect(
			service.withReconciledClient("c1", async () => "ready"),
		).resolves.toBe("ready");
	});

	it("跨 client 的 duplicate/done/error 报告不收敛他人 Job 或释放锁", async () => {
		for (const status of ["duplicate", "done", "error"] as const) {
			const { prisma, service } = setup();
			await service.ensureSession(actor, {
				clientId: "client-B",
				sessionId: "b-session",
			});
			const run = await service.startRun(actor, {
				clientId: "client-B",
				sessionId: "b-session",
				projectKey: "b-project",
			});
			await service.accept(run.jobId, run.runId);
			await service.markReconcilePending("client-A", "socket-A");
			const reportedRun = {
				jobId: run.jobId,
				runId: run.runId,
				sessionId: "b-session",
			};
			await service.reconcileGeneration("client-A", "socket-A", {
				clientId: "client-A",
				runs:
					status === "duplicate"
						? [
								{ ...reportedRun, status: "running", projectKey: "duplicate" },
								{
									...reportedRun,
									status: "waiting_input",
									projectKey: "duplicate",
								},
							]
						: [{ ...reportedRun, status }],
			});
			expect(prisma._jobs.find((job) => job.id === run.jobId)).toMatchObject({
				clientId: "client-B",
				status: "running",
				payload: JSON.stringify({ runId: run.runId }),
			});
			expect(service.hasLock(run.jobId, run.runId)).toBe(true);
		}
	});

	it("reconcileOpen 根据 agent state 精确收敛", async () => {
		const { service, running, current } = setup();
		const run = await running();
		current().status = "waiting_input";
		expect(
			await service.reconcileOpen("s1", run.runId, {
				status: "running",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				queuedMessages: { steering: [], followUp: [] },
			}),
		).toBe(true);
		expect(current().status).toBe("running");
		expect(
			await service.reconcileOpen("s1", run.runId, {
				status: "idle",
				streaming: false,
				prompting: false,
				compacting: false,
				thinkingLevel: "off",
				queuedMessages: { steering: [], followUp: [] },
			}),
		).toBe(true);
		expect(current().status).toBe("idle");
	});
});

describe("PiRunService safe failures", () => {
	it("safePiErrorMessage 对全部 allowlist 有固定消息，未知 code 固定 fallback", async () => {
		for (const code of PI_ERROR_CODES) {
			const { service, running, current } = setup();
			const run = await running();
			expect(await service.failSession(run.jobId, run.runId, code)).toBe(true);
			expect(current().errorMessage).toEqual(expect.any(String));
			expect(String(current().errorMessage).length).toBeGreaterThan(0);
		}
		const { service, running, current } = setup();
		const run = await running();
		await service.failSession(run.jobId, run.runId, "UNKNOWN" as never);
		expect(current().errorMessage).toBe("Pi session failed");
	});

	it("原始错误 sentinel 永不写入 Job", async () => {
		const { service, running, prisma, current } = setup();
		const run = await running();
		await service.failSession(run.jobId, run.runId, "PI_CLIENT_RESTARTED");
		expect(JSON.stringify(prisma._jobs)).not.toContain("TOKEN=abc123");
		expect(current().errorMessage).toBe(
			"Client restarted before the Pi run could be recovered",
		);
	});
});
