import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiSupervisor, type PiWorkerHandle } from "./supervisor.js";
import type { PiRequest, PiCwdRef } from "@vcpdeck/shared";
import type {
	PiWorkerOutboundMessage,
	PiWorkerRequestMessage as WorkerReq,
} from "./worker-protocol.js";

function req(overrides: Partial<PiRequest>): PiRequest {
	return {
		requestId: `r-${Math.random().toString(36).slice(2, 8)}`,
		action: "agent.prompt",
		...overrides,
	} as PiRequest;
}

function prompt(runId: string, cwdRef?: PiCwdRef): PiRequest {
	return req({
		action: "agent.prompt",
		jobId: "s1",
		runId,
		sessionId: "s1",
		cwdRef: cwdRef ?? { rootDir: "D:\\", relativePath: "a" },
		payload: { prompt: "hi" },
	});
}

interface FakeHandle extends PiWorkerHandle {
	sent: WorkerReq[];
	emitMessage: (msg: PiWorkerOutboundMessage) => void;
	emitExit: (code: number) => void;
}

function makeHandle(): FakeHandle {
	const sent: WorkerReq[] = [];
	const msgListeners: ((msg: PiWorkerOutboundMessage) => void)[] = [];
	const exitListeners: ((code: number) => void)[] = [];
	return {
		sent,
		send: (msg) => sent.push(msg),
		onMessage: (l) => {
			msgListeners.push(l);
			return () => {
				const i = msgListeners.indexOf(l);
				if (i !== -1) msgListeners.splice(i, 1);
			};
		},
		onExit: (l) => {
			exitListeners.push(l);
			return () => {
				const i = exitListeners.indexOf(l);
				if (i !== -1) exitListeners.splice(i, 1);
			};
		},
		kill: vi.fn(),
		emitMessage: (msg) => {
			for (const l of msgListeners) l(msg);
		},
		emitExit: (code) => {
			for (const l of exitListeners) l(code);
		},
	};
}

/** 应答 worker：收到 request 后立即 ok */
function autoRespond(handle: FakeHandle): void {
	const origSend = handle.send;
	handle.send = (msg) => {
		origSend(msg);
		if (msg.type === "request") {
			queueMicrotask(() => {
				handle.emitMessage({
					type: "response",
					requestId: msg.request.requestId,
					ok: true,
					data: { accepted: true },
				});
			});
		}
	};
}

let CWD_REF_A: PiCwdRef;
let CWD_REF_B: PiCwdRef;
let roots: string[] = [];
let seq = 0;

async function makeCwdRef(relative: string): Promise<PiCwdRef> {
	const base = await mkdtemp(join(tmpdir(), `pi-sup-${++seq}-`));
	await mkdir(join(base, relative), { recursive: true });
	roots.push(base);
	return { rootDir: base, relativePath: relative };
}

function makeSupervisor(opts: {
	autoRespond?: boolean;
	roots?: string[];
	requestOutcomes?: Partial<Record<PiRequest["action"], "timeout">>;
} = {}) {
	const handles: FakeHandle[] = [];
	const supervisor = createPiSupervisor({
		clientId: "c1",
		rootsProvider: async () => opts.roots ?? [CWD_REF_A.rootDir, CWD_REF_B.rootDir],
		forkWorker: (cwd: string) => {
			const h = makeHandle();
			if (opts.autoRespond) autoRespond(h);
			if (opts.requestOutcomes) {
				const send = h.send;
				h.send = (message) => {
					send(message);
					if (message.type === "request") {
						queueMicrotask(() => h.emitMessage(
							opts.requestOutcomes?.[message.request.action] === "timeout"
								? { type: "response", requestId: message.request.requestId, ok: false, error: { code: "PI_REQUEST_TIMEOUT", message: "timeout" } }
								: { type: "response", requestId: message.request.requestId, ok: true, data: { accepted: true } },
						));
					}
				};
			}
			handles.push(h);
			void cwd;
			return h;
		},
	});
	return { supervisor, handles };
}

beforeEach(async () => {
	CWD_REF_A = await makeCwdRef("a");
	CWD_REF_B = await makeCwdRef("b");
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
	roots = [];
});

describe("PiSupervisor", () => {
	it("同一 canonical cwd 拒绝第二个活动 prompt，不同 cwd 可并行", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		const second = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(second).toMatchObject({ ok: false, error: { code: "PI_PROJECT_BUSY" } });

		// 不同 cwd：spawn 第二个 worker 并接受
		const third = await supervisor.request(prompt("job-c", CWD_REF_B));
		expect(third).toMatchObject({ ok: true });
		expect(handles).toHaveLength(2);
	});

	it("project.resolve 返回不透明 projectKey 且不取活动锁", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		const result = await supervisor.request(
			req({ action: "project.resolve", cwdRef: CWD_REF_A }),
		);
		expect(result).toMatchObject({ ok: true });
		const key = (result as { ok: true; data: { projectKey: string } }).data.projectKey;
		expect(key).toMatch(/^[0-9a-f]{64}$/);

		// 未占用 worker：project.resolve 不 spawn
		expect(handles).toHaveLength(1);
	});

	it("只读 Session request 不获取活动锁", async () => {
		const { supervisor } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));

		const read = await supervisor.request(
			req({ action: "sessions.list", cwdRef: CWD_REF_A }),
		);
		expect(read).toMatchObject({ ok: true });
	});

	it("Extension dialog 期间保持项目锁，Owner 响应后恢复", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		// 活动回合中收到 dialog 事件 → waiting_input
		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			jobId: "s1",
			runId: "job-a",
			event: {
				type: "extension_request",
				sessionId: "s1",
				ui: { requestId: "u1", extensionId: "e", kind: "confirm" },
			},
		});
		expect(supervisor.getStateReport().runs[0]?.status).toBe("waiting_input");

		// 仍持有锁
		const busy = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(busy).toMatchObject({ ok: false, error: { code: "PI_PROJECT_BUSY" } });

		// Owner 响应本身不乐观解锁；只由 Worker 的 resolved 事件恢复
		await supervisor.request(
			req({
				action: "extension.respond",
				cwdRef: undefined,
				jobId: "s1",
				runId: "job-a",
				sessionId: "s1",
				payload: { requestId: "u1", confirmed: true },
			}),
		);
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "job-a",
			event: { type: "extension_resolved", sessionId: "s1", requestId: "u1", reason: "answered", hasPending: false },
		});
		expect(supervisor.getStateReport().runs[0]?.status).toBe("running");
	});

	it("活动回合拒绝 rename/delete/fork/clone/navigate/model/thinking", async () => {
		const { supervisor } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));

		for (const action of [
			"session.rename",
			"session.delete",
			"session.fork",
			"session.clone",
			"session.navigate",
			"model.set",
			"thinking.set",
		] as const) {
			const result = await supervisor.request(
				req({ action, cwdRef: CWD_REF_A } as unknown as Partial<PiRequest>),
			);
			expect(result).toMatchObject({ ok: false, error: { code: "PI_PROJECT_BUSY" } });
		}
	});

	it("agent.compact 在活动回合允许（Owner 由 Server 校验）", async () => {
		const { supervisor } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		const result = await supervisor.request(
			req({
				action: "agent.compact",
				cwdRef: undefined,
				jobId: "s1",
				runId: "job-a",
				sessionId: "s1",
			}),
		);
		expect(result).toMatchObject({ ok: true });
	});

	it("agent_settled 后释放锁并保留 terminal summary 直到 ack", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			jobId: "s1",
			runId: "job-a",
			event: { type: "agent_settled", sessionId: "s1" },
		});

		// 锁释放：新 prompt 可进入
		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });

		// terminal summary 保留
		const report = supervisor.getStateReport();
		expect(report.runs.some((r) => r.runId === "job-a" && r.status === "done")).toBe(true);

		await supervisor.applyStateAck({ acceptedRunIds: ["job-a"], closedRunIds: [], reportAgain: false });
		expect(
			supervisor.getStateReport().runs.some((r) => r.runId === "job-a"),
		).toBe(false);
	});

	it("prompt_error 后释放锁并标记 error", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			jobId: "s1",
			runId: "job-a",
			event: { type: "prompt_error", sessionId: "s1", code: "PI_RUNTIME_UNAVAILABLE", message: "boom" },
		});

		expect(supervisor.getStateReport().runs[0]?.status).toBe("error");
		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });
	});

	it("Worker 退出时活动回合标记 error", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitExit(1);
		expect(supervisor.getStateReport().runs[0]?.status).toBe("error");
	});

	it("Worker 无响应时 request 超时", async () => {
		const { supervisor } = makeSupervisor();
		const started = Date.now();
		const result = await supervisor.request(prompt("job-a", CWD_REF_A), 50);
		expect(result).toMatchObject({ ok: false, error: { code: "PI_REQUEST_TIMEOUT" } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(40);
	});

	it("同一 Session 后续 Prompt 使用新 runId，旧 run 事件不清理新 run", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		await supervisor.request(prompt("run-2", CWD_REF_A));
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		expect(supervisor.getStateReport().runs).toContainEqual(expect.objectContaining({
			jobId: "s1", sessionId: "s1", runId: "run-2", status: "running",
		}));
	});

	it("只在最后一个 Extension 解决后恢复 running", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "run-1",
			event: { type: "extension_request", sessionId: "s1", ui: { requestId: "u1", extensionId: "e", kind: "confirm" } },
		});
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "run-1",
			event: { type: "extension_resolved", sessionId: "s1", requestId: "u1", reason: "answered", hasPending: true },
		});
		expect(supervisor.getStateReport().runs.find((run) => run.runId === "run-1")?.status).toBe("waiting_input");
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", jobId: "s1", runId: "run-1",
			event: { type: "extension_resolved", sessionId: "s1", requestId: "u2", reason: "answered", hasPending: false },
		});
		expect(supervisor.getStateReport().runs.find((run) => run.runId === "run-1")?.status).toBe("running");
	});

	it("PI_STATE ack 只在权威 abort 成功后清理 closed run", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));
		await expect(supervisor.applyStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: false })).resolves.toEqual({ allClosed: true });
		expect(handles[0]!.sent).toContainEqual(expect.objectContaining({
			type: "request", request: expect.objectContaining({ action: "agent.abort", runId: "run-1" }),
		}));
		expect(supervisor.getStateReport().runs.some((run) => run.runId === "run-1")).toBe(false);
	});

	it("closed run abort 失败时保留并在下一次 PI_STATE 重报", async () => {
		const { supervisor } = makeSupervisor({ requestOutcomes: { "agent.abort": "timeout" } });
		await supervisor.request(prompt("run-1", CWD_REF_A), 5);
		const ack = await supervisor.applyStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: true });
		expect(ack).toEqual({ allClosed: false });
		expect(supervisor.getStateReport().runs).toContainEqual(expect.objectContaining({ runId: "run-1" }));
	});

	it("shutdown 通知所有 Worker", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));
		await supervisor.shutdown();
		expect(handles[0]?.sent.some((m) => m.type === "shutdown")).toBe(true);
	});
});
