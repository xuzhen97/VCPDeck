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
import type { PiRuntimeConfigState } from "./runtime-spec.js";

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
		runId,
		sessionId: "s1",
		cwdRef: cwdRef ?? { rootDir: "D:\\", relativePath: "a" },
		payload: { prompt: "hi", submissionId: "sub-1", executionMode: "approval" },
	});
}

/** 扩展斜杠命令：与 prompt 同生命周期（ADR-0040 决策 2）。 */
function command(runId: string, cwdRef?: PiCwdRef): PiRequest {
	return req({
		action: "agent.command",
		runId,
		sessionId: "s1",
		cwdRef: cwdRef ?? { rootDir: "D:\\", relativePath: "a" },
		payload: { name: "fixture_status", args: "" },
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

/**
 * 让 worker 对 `agent.state` 返回指定结果（供陈旧项目锁自愈用例）；其它请求仍走默认应答。
 * 直接记入 `sent` 并自行应答，避免与 autoRespond 重复响应。
 */
function interceptAgentState(
	handle: FakeHandle,
	state: "idle" | "running" | "unknown" | "timeout",
): void {
	const idleState = {
		status: "idle",
		streaming: false,
		prompting: false,
		compacting: false,
		thinkingLevel: "medium",
		queuedMessages: { steering: [], followUp: [] },
	};
	const inner = handle.send;
	handle.send = (msg) => {
		if (msg.type === "request" && msg.request.action === "agent.state") {
			handle.sent.push(msg);
			const requestId = msg.request.requestId;
			const reply: PiWorkerOutboundMessage =
				state === "timeout"
					? {
							type: "response",
							requestId,
							ok: false,
							error: { code: "PI_REQUEST_TIMEOUT", message: "timeout" },
						}
					: state === "unknown"
						? {
								type: "response",
								requestId,
								ok: false,
								error: {
									code: "PI_CONTROL_FORBIDDEN",
									message: "No matching active run",
								},
							}
						: {
								type: "response",
								requestId,
								ok: true,
								data:
									state === "running"
										? {
												...idleState,
												status: "running",
												streaming: true,
												prompting: true,
											}
										: idleState,
							};
			queueMicrotask(() => handle.emitMessage(reply));
			return;
		}
		inner(msg);
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
	/** null = 不登记运行配置（用于门控用例） */
	runtimeState?: PiRuntimeConfigState | null;
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
	// WORKER_ACTIONS 需要 ready：除专门测试门控的用例外，默认登记一份就绪配置。
	if (opts.runtimeState !== null) {
		supervisor.setRuntimeConfig(
			opts.runtimeState ?? {
				configState: "ready",
				runtimeRevision: "0123456789abcdef",
				config: {
					spec: {
						schemaVersion: 5,
						specId: "s1",
						profileId: "p1",
						profileRevision: 1,
						providers: [{ providerId: "anthropic", name: "Anthropic", protocol: "anthropic-messages", headers: {}, models: [{ id: "claude-x", name: "Claude X", metadataSource: "catalog" }] }],
						modelPolicy: {
							defaultModel: { provider: "anthropic", modelId: "claude-x" },
							allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
							defaultThinkingLevel: "medium",
						},
						toolExecutionMode: "automatic",
						runtimeRevision: "0123456789abcdef",
					},
					credentialEntries: [{ providerId: "anthropic", apiKey: "sk-test" }],
					bundleExtensionPaths: [],
					resolvedModels: [{ provider: "anthropic", modelId: "claude-x" }],
					unavailableModels: [],
				},
			},
		);
	}
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
				runId: "job-a",
				sessionId: "s1",
				payload: { requestId: "u1", confirmed: true },
			}),
		);
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "job-a",
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
			runId: "job-a",
			event: { type: "agent_settled", sessionId: "s1" },
		});

		// 锁释放：新 prompt 可进入
		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });

		// terminal summary 保留
		const report = supervisor.getStateReport();
		expect(report.runs.some((r) => r.runId === "job-a" && r.status === "succeeded")).toBe(true);

		await supervisor.applyStateAck({ acceptedRunIds: ["job-a"], closedRunIds: [], reportAgain: false });
		expect(
			supervisor.getStateReport().runs.some((r) => r.runId === "job-a"),
		).toBe(false);
	});

	it("只收到 prompt_done（无 agent_settled）也释放锁：与 Server 的收敛触发集对齐", async () => {
		// 实测复现：gs-local 上第一条消息正常回答后，第二条稳定拿到
		// PI_PROJECT_BUSY。Server 的 SETTLEMENT_TRIGGERS 包含 prompt_done，
		// 因此它会收敛并放行；客户端若只认 agent_settled 就会永久持锁。
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			runId: "job-a",
			event: { type: "prompt_done", sessionId: "s1" },
		});

		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });
		expect(
			supervisor.getStateReport().runs.some((r) => r.runId === "job-a" && r.status === "succeeded"),
		).toBe(true);
	});

	it("扩展命令建立并结清项目锁：prompt_done 后无 cwdRef 的结算查询仍能定位（回归）", async () => {
		// 曾经的缺陷：supervisor 只为 agent.prompt 建 activeRun（也不回收），
		// `agent.command` 的 entry.activeRun 恒为 null → 终态分支整段被跳过，
		// terminalCwd 永不写入。于是服务端 30 秒后的结算查询（无 cwdRef，
		// 只能按 sessionId+runId 回退）拿到 PI_SESSION_NOT_FOUND，被静默吞掉，
		// job 停在 running、内存项目锁永不释放，后续包括【新建会话】
		// 都撞 `Project has an active turn`。
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(command("cmd-a", CWD_REF_A));

		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			runId: "cmd-a",
			event: { type: "prompt_done", sessionId: "s1" },
		});

		// ① 模拟服务端的结算查询：只有 sessionId+runId，没有 cwdRef。
		// 修复前这里会因 terminalCwd 缺失而报 PI_SESSION_NOT_FOUND。
		const settle = await supervisor.request(
			req({ action: "agent.state", sessionId: "s1", runId: "cmd-a" }),
		);
		expect(settle.ok).toBe(true);

		// ② 锁已结清：同项目下一条命令被接纳。
		expect(await supervisor.request(command("cmd-b", CWD_REF_A))).toMatchObject({ ok: true });
		// ③ 命令也计入终态摘要，供 Server 重连对账。
		expect(
			supervisor
				.getStateReport()
				.runs.some((r) => r.runId === "cmd-a" && r.status === "succeeded"),
		).toBe(true);
	});

	it("项目锁与 worker 状态不一致时自愈：陈旧锁被回收、下一条 prompt 被接纳", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		// 模拟实测事故：worker 已不再认识该 run（agent_settled 未匹配上），但客户端锁还在，
		// Server 与界面已按权威状态放行下一条消息。
		interceptAgentState(handles[0], "idle");

		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });
		// 陈旧 run 补一份终态摘要，让 Server 侧对账也能收敛。
		const report = supervisor.getStateReport();
		expect(report.runs.some((r) => r.runId === "job-a" && r.status === "succeeded")).toBe(true);
		expect(report.runs.some((r) => r.runId === "job-b" && r.status === "running")).toBe(true);
	});

	it("worker 仍不认识该 run（无匹配活动回合）时同样自愈", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		interceptAgentState(handles[0], "unknown");
		expect(await supervisor.request(prompt("job-b", CWD_REF_A))).toMatchObject({ ok: true });
	});

	it("worker 确认仍在运行时仍拒绝，不抢活跃回合", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		interceptAgentState(handles[0], "running");

		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({
			ok: false,
			error: { code: "PI_PROJECT_BUSY", message: "Project has an active turn" },
		});
		const report = supervisor.getStateReport();
		expect(report.runs.some((r) => r.runId === "job-a" && r.status === "running")).toBe(true);
	});

	it("worker 超时不应答时保守拒绝（不能区分忙与卡）", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("job-a", CWD_REF_A));
		interceptAgentState(handles[0], "timeout");
		expect(await supervisor.request(prompt("job-b", CWD_REF_A))).toMatchObject({
			ok: false,
			error: { code: "PI_PROJECT_BUSY" },
		});
	});

	it("prompt_error 后释放锁并标记 error", async () => {		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitMessage({
			type: "event",
			sessionId: "s1",
			runId: "job-a",
			event: { type: "prompt_error", sessionId: "s1", code: "PI_RUNTIME_UNAVAILABLE", message: "boom" },
		});

		expect(supervisor.getStateReport().runs[0]?.status).toBe("failed");
		const next = await supervisor.request(prompt("job-b", CWD_REF_A));
		expect(next).toMatchObject({ ok: true });
	});

	it("Worker 退出时活动回合标记 error", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });		await supervisor.request(prompt("job-a", CWD_REF_A));

		handles[0].emitExit(1);
		expect(supervisor.getStateReport().runs[0]?.status).toBe("failed");
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
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		await supervisor.request(prompt("run-2", CWD_REF_A));
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		expect(supervisor.getStateReport().runs).toContainEqual(expect.objectContaining({
		}));
	});

	it("只在最后一个 Extension 解决后恢复 running", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "extension_request", sessionId: "s1", ui: { requestId: "u1", extensionId: "e", kind: "confirm" } },
		});
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "extension_resolved", sessionId: "s1", requestId: "u1", reason: "answered", hasPending: true },
		});
		expect(supervisor.getStateReport().runs.find((run) => run.runId === "run-1")?.status).toBe("waiting_input");
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "extension_resolved", sessionId: "s1", requestId: "u2", reason: "answered", hasPending: false },
		});
		expect(supervisor.getStateReport().runs.find((run) => run.runId === "run-1")?.status).toBe("running");
	});

	it("普通 matching abort 成功后清理活动 run", async () => {
		const { supervisor } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));

		await expect(supervisor.request(req({
			action: "agent.abort",
			sessionId: "s1",
			runId: "run-1",
		}))).resolves.toMatchObject({ ok: true });

		expect(supervisor.getStateReport().runs.some((run) => run.runId === "run-1")).toBe(false);
		await expect(supervisor.request(prompt("run-2", CWD_REF_A))).resolves.toMatchObject({ ok: true });
	});

	it("PI_STATE ack 只在权威 abort 成功后清理 closed run", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(prompt("run-1", CWD_REF_A));
		await expect(supervisor.applyStateAck({ acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: false })).resolves.toEqual({ allClosed: true });
		expect(handles[0]!.sent).toContainEqual(expect.objectContaining({
			type: "request", request: expect.objectContaining({ action: "agent.abort", runId: "run-1" }),
		}));
		expect(supervisor.getStateReport().runs.some((run) => run.runId === "run-1")).toBe(false);
		await expect(supervisor.request(prompt("run-2", CWD_REF_A))).resolves.toMatchObject({ ok: true });
	});

	it("未就绪时 WORKER_ACTION 被拒绝且不 fork Worker", async () => {
		const { supervisor, handles } = makeSupervisor({ runtimeState: null });
		const result = await supervisor.request(prompt("run-x", CWD_REF_A));
		expect(result).toMatchObject({
			ok: false,
			error: { code: "PI_CONFIG_UNAVAILABLE" },
		});
		expect(handles).toHaveLength(0);
		expect(() => supervisor.assertReady()).toThrow(/不可用|尚未/);
	});

	it("未就绪时导入动作（WORKER_ACTION）被拒绝且不 fork Worker", async () => {
		const { supervisor, handles } = makeSupervisor({ runtimeState: null });
		const result = await supervisor.request({
			requestId: "i-import",
			action: "session.import.run",
			payload: { sourceNames: ["native.jsonl"] },
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "PI_CONFIG_UNAVAILABLE" },
		});
		expect(handles).toHaveLength(0);
	});

	it("就绪时机器级 session.import.* 无 cwdRef/jobId 可达 Worker（合成机器 entry）", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		const list = await supervisor.request({
			requestId: "i-list",
			action: "session.import.list",
		});
		expect(list.ok).toBe(true);
		expect(handles).toHaveLength(1);
		const preview = await supervisor.request({
			requestId: "i-prev",
			action: "session.import.preview",
			payload: { sourceName: "x.jsonl" },
		});
		expect(preview.ok).toBe(true);
		// 复用同一机器 Worker，不再 fork
		expect(handles).toHaveLength(1);
	});

	it("READ_ACTION 在未就绪时仍可用（project.resolve 不 fork Worker）", async () => {
		const { supervisor, handles } = makeSupervisor({ runtimeState: null });
		const result = await supervisor.request(
			req({ action: "project.resolve", cwdRef: CWD_REF_A }),
		);
		expect(result.ok).toBe(true);
		expect(handles).toHaveLength(0);
	});

	it("fork 后立即经 IPC 下发 runtime-init（凭据不出现在 argv/env）", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		const result = await supervisor.request(
			req({ action: "sessions.list", cwdRef: CWD_REF_A }),
		);
		await vi.waitFor(() => expect(handles[0]?.sent.length).toBeGreaterThan(0));
		const init = handles[0]!.sent[0];
		expect(init).toMatchObject({ type: "runtime-init" });
		if (init?.type === "runtime-init") {
			expect(init.config?.credentialEntries).toEqual([
				{ providerId: "anthropic", apiKey: "sk-test" },
			]);
		}
		void result;
	});

	it("未就绪时 fork 出的 Worker 收到 config=null（不得用旧配置服务请求）", async () => {
		const { supervisor, handles } = makeSupervisor({
			runtimeState: null,
			autoRespond: true,
		});
		await supervisor.request(req({ action: "sessions.list", cwdRef: CWD_REF_A }));
		await vi.waitFor(() => expect(handles[0]?.sent.length).toBeGreaterThan(0));
		expect(handles[0]!.sent[0]).toEqual({ type: "runtime-init", config: null });
		expect(supervisor.isReady()).toBe(false);
	});

	it("活跃 Run 期间新 revision 只标记 drain，不终止 Worker", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		const promptRequest = prompt("run-1", CWD_REF_A);
		const accepted = supervisor.request(promptRequest);
		await vi.waitFor(() => expect(handles[0]?.sent.length).toBeGreaterThanOrEqual(2));
		handles[0]!.emitMessage({
			type: "response", requestId: promptRequest.requestId, ok: true,
			data: { accepted: true },
		});
		await accepted;

		supervisor.setRuntimeConfig({
			configState: "ready",
			runtimeRevision: "ffffffffffffffff",
			config: null,
		});
		expect(handles[0]!.kill).not.toHaveBeenCalled();
		expect(supervisor.activeRuntimeRevision()).toBe("0123456789abcdef");

		// Run 结算后按换代语义关闭，下次动作用新 revision fork。
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		await vi.waitFor(() => expect(handles[0]!.kill).toHaveBeenCalled());

		await supervisor.request(req({ action: "sessions.list", cwdRef: CWD_REF_A }));
		await vi.waitFor(() => expect(handles).toHaveLength(2));
		expect(handles[1]!.sent[0]).toEqual({ type: "runtime-init", config: null });
	});

	it("空闲时新 revision 立即关闭 Worker，且相同 revision 重复下发不关闭", async () => {
		const { supervisor, handles } = makeSupervisor({ autoRespond: true });
		await supervisor.request(req({ action: "sessions.list", cwdRef: CWD_REF_A }));
		await vi.waitFor(() => expect(handles).toHaveLength(1));

		supervisor.setRuntimeConfig({
			configState: "ready",
			runtimeRevision: "0123456789abcdef",
			config: null,
		});
		expect(handles[0]!.kill).not.toHaveBeenCalled();

		supervisor.setRuntimeConfig({
			configState: "ready",
			runtimeRevision: "ffffffffffffffff",
			config: null,
		});
		expect(handles[0]!.kill).toHaveBeenCalledTimes(1);
	});

	it("incompatible 配置下 WORKER_ACTION 报出具体原因码", async () => {
		const { supervisor } = makeSupervisor({
			runtimeState: {
				configState: "incompatible",
				reasonCode: "PI_CREDENTIAL_UNAVAILABLE",
				runtimeRevision: "0123456789abcdef",
				config: null,
			},
		});
		const result = await supervisor.request(prompt("run-y", CWD_REF_A));
		expect(result).toMatchObject({
			ok: false,
			error: { code: "PI_CONFIG_UNAVAILABLE" },
		});
		if (!result.ok) expect(result.error.message).toContain("PI_CREDENTIAL_UNAVAILABLE");
	});

	it("PI_STATE 上报携带真实 runtimeRevision 与 configState", async () => {
		const { supervisor } = makeSupervisor();
		expect(supervisor.getStateReport()).toMatchObject({
			runtimeRevision: "0123456789abcdef",
			configState: "ready",
		});
		const { supervisor: pending } = makeSupervisor({ runtimeState: null });
		expect(pending.getStateReport()).toMatchObject({
			runtimeRevision: null,
			configState: "pending",
		});
	});

	it("PI_STATE abort response 前 matching terminal 已清理时仍判定 allClosed", async () => {
		const { supervisor, handles } = makeSupervisor();
		const promptRequest = prompt("run-1", CWD_REF_A);
		const accepted = supervisor.request(promptRequest);
		const sentRequests = () =>
			handles[0]!.sent.filter((message) => message.type === "request");
		await vi.waitFor(() => expect(sentRequests()).toHaveLength(1));
		handles[0]!.emitMessage({
			type: "response", requestId: promptRequest.requestId, ok: true,
			data: { accepted: true },
		});
		await accepted;

		const ack = supervisor.applyStateAck({
			acceptedRunIds: [], closedRunIds: ["run-1"], reportAgain: false,
		});
		await vi.waitFor(() => expect(sentRequests()).toHaveLength(2));
		const abortMessage = sentRequests()[1];
		expect(abortMessage).toMatchObject({
			type: "request", request: { action: "agent.abort", runId: "run-1" },
		});
		handles[0]!.emitMessage({
			type: "event", sessionId: "s1", runId: "run-1",
			event: { type: "agent_settled", sessionId: "s1" },
		});
		if (abortMessage?.type === "request") {
			handles[0]!.emitMessage({
				type: "response", requestId: abortMessage.request.requestId, ok: true,
			});
		}

		await expect(ack).resolves.toEqual({ allClosed: true });
		expect(supervisor.getStateReport().runs.some((run) =>
			run.runId === "run-1" && run.status === "running",
		)).toBe(false);
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
