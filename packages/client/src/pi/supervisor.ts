import { randomUUID } from "node:crypto";
import type {
	PiClientEvent,
	PiErrorCode,
	PiEvent,
	PiRequest,
	PiResponse,
	PiRunSummary,
	PiStateAck,
	PiStateReport,
} from "@vcpdeck/shared";
import { isPiWorkerAction } from "@vcpdeck/shared";
import { isPiAgentIdle, parsePiAgentState } from "@vcpdeck/shared";
import { discoverRoots } from "../filesystem-roots.js";
import {
	canonicalPath,
	projectKeyFor,
	resolveProjectCwd,
} from "./project-path.js";
import type {
	PiWorkerOutboundMessage,
	PiWorkerRequestMessage,
} from "./worker-protocol.js";
import {
	pendingRuntimeConfigState,
	type PiRuntimeConfigState,
} from "./runtime-spec.js";

/** 单个请求等待 Worker 响应的上限 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 核实项目锁是否已陈旧时的等待上限：短于普通请求，避免每次重试都拖慢用户消息。 */
const STALE_LOCK_PROBE_TIMEOUT_MS = 5_000;

/** Worker 进程句柄（测试注入） */
export interface PiWorkerHandle {
	send(msg: PiWorkerRequestMessage): void;
	onMessage(listener: (msg: PiWorkerOutboundMessage) => void): () => void;
	onExit(listener: (code: number) => void): () => void;
	kill(): void;
}

interface ActiveRun {
	runId: string;
	sessionId: string;
	projectKey: string;
	status: "running" | "waiting_input";
}

interface ProjectEntry {
	cwd: string;
	handle: PiWorkerHandle;
	activeRun: ActiveRun | null;
	terminals: PiRunSummary[];
	/** 空闲 mutation 串行队列 */
	mutationQueue: Promise<unknown>;
	/** 该 Worker 创建时绑定的 runtimeRevision */
	activeRuntimeRevision: string | null;
	/** 配置换代时若正忙则标记 drain，Run 结算后关闭 */
	drainAfterRun: boolean;
}

function piResponse(requestId: string, data?: unknown): PiResponse {
	return { requestId, ok: true, data };
}

function piError(
	requestId: string,
	code: PiErrorCode,
	message: string,
): PiResponse {
	return { requestId, ok: false, error: { code, message } };
}

const DESTRUCTIVE_ACTIONS = new Set([
	"session.rename",
	"session.delete",
	"session.fork",
	"session.clone",
	"session.navigate",
	"model.set",
	"thinking.set",
]);

/**
 * 会“开启一个回合”的动作：接纳后必须在终态时结清项目锁。
 *
 * 指令与 prompt 共用同一套 Run 生命周期（ADR-0040 决策 2）。若漏掉
 * `agent.command`，它的 `entry.activeRun` 恒为 null，终态分支不会执行，
 * `terminalCwd` 也就永不写入 —— 服务端 30 秒后的结算查询按 sessionId+runId
 * 定不到 cwd，返回 `PI_SESSION_NOT_FOUND`，job 停在 running，
 * 项目锁永不释放，后续（含新建会话）全部撞 `Project has an active turn`。
 */
const RUN_ESTABLISHING_ACTIONS = new Set(["agent.prompt", "agent.command"]);

export interface PiSupervisor {
	request(request: PiRequest, timeoutMs?: number): Promise<PiResponse>;
	getStateReport(): PiStateReport;
	/** 登记 Server 下发的运行配置；revision 变化时按换代语义处理现有 Worker。 */
	setRuntimeConfig(state: PiRuntimeConfigState): void;
	configState(): PiRuntimeConfigState;
	activeRuntimeRevision(): string | null;
	/** 未就绪时抛出 PI_CONFIG_UNAVAILABLE（不 fallback 本机 Pi）。 */
	assertReady(): void;
	/** 是否已就绪（bridge 用于决定是否上报 ready） */
	isReady(): boolean;
	applyStateAck(ack: PiStateAck): Promise<{ allClosed: boolean }>;
	onEvent(listener: (event: PiEvent) => void): () => void;
	shutdown(): Promise<void>;
}

export function createPiSupervisor(options: {
	clientId: string;
	forkWorker: (cwd: string) => PiWorkerHandle;
	/** 允许的根列表提供者（默认 discoverRoots；测试注入） */
	rootsProvider?: () => Promise<string[]>;
}): PiSupervisor {
	const { clientId, forkWorker } = options;
	const rootsProvider = options.rootsProvider ?? discoverRoots;
	const registry = new Map<string, ProjectEntry>();
	/** 已退出 Worker 的终态摘要（registry 清理后仍保留直到 ack） */
	const orphanTerminals: PiRunSummary[] = [];
	/** runId → envelope/cwd（终态后 settlement 查询回退；仅内存，不上报） */
	const terminalCwd = new Map<
		string,
		{ cwd: string; sessionId: string }
	>();
	const eventListeners: ((event: PiEvent) => void)[] = [];
	/** Server 下发的运行配置（含凭据 lease），只存在于内存 */
	let desired: PiRuntimeConfigState = pendingRuntimeConfigState();
	const pending = new Map<
		string,
		{ resolve: (r: PiResponse) => void; timer: ReturnType<typeof setTimeout> }
	>();

	function emitEvent(event: PiEvent): void {
		for (const l of eventListeners) l(event);
	}

	async function resolveKey(
		request: PiRequest,
	): Promise<{ key: string; cwd: string }> {
		if (request.cwdRef) {
			const roots = await rootsProvider();
			const { cwd, key } = await resolveProjectCwd(request.cwdRef, roots);
			return { key, cwd };
		}
		if (request.sessionId) {
			for (const [key, entry] of registry) {
				if (
					entry.activeRun?.sessionId === request.sessionId &&
					(!request.runId || entry.activeRun.runId === request.runId)
				) {
					return { key, cwd: entry.cwd };
				}
			}
			// settlement 在 activeRun 清除后查询:按 runId 回退,避免同 Session 多轮冲突
			const settled = request.runId
				? terminalCwd.get(request.runId)
				: undefined;
			if (settled && settled.sessionId === request.sessionId) {
				return {
					key: projectKeyFor(canonicalPath(settled.cwd)),
					cwd: settled.cwd,
				};
			}
			throw { code: "PI_SESSION_NOT_FOUND", message: "No active run for session" };
		}
		throw {
			code: "PI_PROTOCOL_INVALID",
			message: "Request needs cwdRef or sessionId",
		};
	}

	/**
	 * 机器级 Worker action（ADR-0031 导入链路）：不依赖项目 cwdRef/sessionId，
	 * 走合成机器 entry；runtime paths/源根均在 Worker 内自解，argv cwd 仅需非空。
	 */
	const MACHINE_WORKER_ACTIONS = new Set([
		"session.import.list",
		"session.import.preview",
		"session.import.run",
	]);
	const MACHINE_KEY = "__machine__";

	function machineCwd(): string {
		return process.env.PI_CODING_AGENT_DIR || process.cwd();
	}

	/** 运行结束后按换代语义关闭 Worker（下次请求用新 revision fork）。 */
	function closeIfDraining(entry: ProjectEntry): void {
		if (!entry.drainAfterRun || entry.activeRun) return;
		for (const [key, candidate] of registry) {
			if (candidate === entry) {
				registry.delete(key);
				break;
			}
		}
		entry.handle.kill();
	}

	function revisionMatches(entry: ProjectEntry): boolean {
		return entry.activeRuntimeRevision === desired.runtimeRevision;
	}

	function activeRuntimeRevision(): string | null {
		let drainingRevision: string | null = null;
		for (const entry of registry.values()) {
			if (!entry.drainAfterRun) return entry.activeRuntimeRevision;
			drainingRevision ??= entry.activeRuntimeRevision;
		}
		return drainingRevision ?? (desired.configState === "ready" ? desired.runtimeRevision : null);
	}

	function notReadyFailure(
		request: PiRequest,
	): { code: PiErrorCode; message: string } {
		return {
			code: "PI_CONFIG_UNAVAILABLE",
			message:
				desired.configState === "incompatible"
					? `Pi 运行配置不可用（${desired.reasonCode ?? "unknown"}）`
					: "Pi 运行配置尚未就绪",
		};
	}

	/**
	 * 回收与权威状态不一致的项目锁；返回 true 表示可以继续接纳新 prompt。
	 *
	 * `entry.activeRun` 只是客户端缓存：它只在 Worker 的终态事件（`agent_settled` /
	 * `prompt_done` / `prompt_error`）到达 **且 sessionId+runId 匹配**时才释放，而同一事件是
	 * **无条件**转发给 Server 的。一旦两边不同步，界面按 Server 的权威状态放行下一条消息，
	 * 客户端却回 `PI_PROJECT_BUSY Project has an active turn`，而且 `applyStateAck` 只在
	 * Server 明确 `closedRunIds` 时才清锁 —— 锁会一直留到 Worker 空闲 10 分钟关闭才自愈
	 * （实测事故：gs-local 上第一轮正常回答后，第二条消息被这样拒掉，稳定复现）。
	 *
	 * 因此拒绝之前先向 Worker 求证：
	 * - Worker 仍认识该 run 且并非空闲 → 真忙，继续拒绝；
	 * - Worker 明确空闲，或已不认识该 run（如换代关闭）→ 陈旧锁，回收并补一份终态摘要，
	 *   使 Server 侧对账也能收敛；
	 * - Worker 无响应（超时）→ 保守视为仍在运行，不抢活跃回合。
	 */
	async function reclaimStaleRun(entry: ProjectEntry): Promise<boolean> {
		const run = entry.activeRun;
		if (!run) return true;
		const response = await requestViaWorker(
			entry,
			run.projectKey,
			{
				requestId: randomUUID(),
				action: "agent.state",
				sessionId: run.sessionId,
				runId: run.runId,
			},
			STALE_LOCK_PROBE_TIMEOUT_MS,
		);
		if (response.ok) {
			try {
				if (!isPiAgentIdle(parsePiAgentState(response.data))) return false;
			} catch {
				// 状态不可解析时不得猜：按仍在运行处理，与旧行为一致。
				return false;
			}
		} else if (response.error.code === "PI_REQUEST_TIMEOUT") {
			// Worker 未在时限内应答：不能区分「忙」与「卡」，保守不抢回合。
			return false;
		}
		if (entry.activeRun !== run) return true;
		entry.terminals.push({
			runId: run.runId,
			sessionId: run.sessionId,
			status: "succeeded",
			projectKey: run.projectKey,
		});
		terminalCwd.set(run.runId, {
			cwd: entry.cwd,
			sessionId: run.sessionId,
		});
		entry.activeRun = null;
		closeIfDraining(entry);
		return true;
	}

	function entryFor(key: string, cwd: string): ProjectEntry {
		const existing = registry.get(key);
		if (existing) return existing;
		const handle = forkWorker(cwd);
		const entry: ProjectEntry = {
			cwd,
			handle,
			activeRun: null,
			terminals: [],
			mutationQueue: Promise.resolve(),
			activeRuntimeRevision: desired.runtimeRevision,
			drainAfterRun: false,
		};
		registry.set(key, entry);
		// 凭据与 Spec 只经 IPC 下发；Worker 在此之前不得服务业务请求。
		handle.send({ type: "runtime-init", config: desired.config });

		handle.onMessage((msg) => {
			if (msg.type === "response") {
				const p = pending.get(msg.requestId);
				if (p) {
					clearTimeout(p.timer);
					pending.delete(msg.requestId);
					if (msg.ok) {
						p.resolve({ requestId: msg.requestId, ok: true, data: msg.data });
					} else {
						p.resolve({
							requestId: msg.requestId,
							ok: false,
							error: {
								code: msg.error.code as PiErrorCode,
								message: msg.error.message,
							},
						});
					}
				}
				return;
			}
			if (msg.type === "event") {
				const run = entry.activeRun;
				if (run && msg.sessionId === run.sessionId && msg.runId === run.runId) {
					if (
						msg.event.type === "extension_request" &&
						isDialogKind(msg.event.ui?.kind)
					) {
						run.status = "waiting_input";
					}
					if (
						msg.event.type === "extension_resolved" &&
						msg.event.hasPending === false
					) {
						run.status = "running";
					}
					// 终态集合与 Worker / Server 对齐（见 worker.ts 的说明）：
					// 只认 agent_settled 会在缺该事件的路径上永久持锁。
					if (
						msg.event.type === "agent_settled" ||
						msg.event.type === "prompt_done"
					) {
						entry.terminals.push({
							runId: run.runId,
							sessionId: run.sessionId,
							status: "succeeded",
							projectKey: run.projectKey,
						});
						terminalCwd.set(run.runId, {
							cwd: entry.cwd,
							sessionId: run.sessionId,
						});
						entry.activeRun = null;
						closeIfDraining(entry);
					}
					if (msg.event.type === "prompt_error") {
						// v4:错误是权威失败终局,携带安全错误码供审计摘要。
						const code = msg.event.type === "prompt_error"
							? (msg.event as { code?: unknown }).code
							: undefined;
						entry.terminals.push({
							runId: run.runId,
							sessionId: run.sessionId,
							status: "failed",
							...(typeof code === "string" ? { errorCode: code as PiErrorCode } : {}),
							projectKey: run.projectKey,
						});
						terminalCwd.set(run.runId, {
							cwd: entry.cwd,
							sessionId: run.sessionId,
						});
						entry.activeRun = null;
						closeIfDraining(entry);
					}
				}
				emitEvent({
					clientId,
					sessionId: msg.sessionId,
					runId: msg.runId,
					event: msg.event,
				});
			}
		});

		handle.onExit(() => {
			if (entry.activeRun) {
				const run = entry.activeRun;
				orphanTerminals.push({
					runId: run.runId,
					sessionId: run.sessionId,
					status: "failed",
					errorCode: "PI_WORKER_EXITED" as PiErrorCode,
					projectKey: run.projectKey,
				});
				entry.activeRun = null;
			}
			for (const t of entry.terminals) orphanTerminals.push(t);
			registry.delete(key);
		});

		return entry;
	}

	function requestViaWorker(
		entry: ProjectEntry,
		projectKey: string,
		request: PiRequest,
		timeoutMs: number,
	): Promise<PiResponse> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(request.requestId);
				resolve(
					piError(
						request.requestId,
						"PI_REQUEST_TIMEOUT",
						"Worker did not respond in time",
					),
				);
			}, timeoutMs);
			pending.set(request.requestId, { resolve, timer });
			entry.handle.send({ type: "request", projectKey, request });
		});
	}

	return {
		async request(request, timeoutMs = REQUEST_TIMEOUT_MS) {
			try {
				// WORKER_ACTIONS 必须先 ready：未就绪时不 fork Worker。
				if (
					isPiWorkerAction(request.action) &&
					desired.configState !== "ready"
				) {
					return piError(
						request.requestId,
						notReadyFailure(request).code,
						notReadyFailure(request).message,
					);
				}
				if (request.action === "project.resolve") {
					if (!request.cwdRef) {
						return piError(
							request.requestId,
							"PI_PROTOCOL_INVALID",
							"project.resolve needs cwdRef",
						);
					}
					const { key } = await resolveKey(request);
					return piResponse(request.requestId, { projectKey: key });
				}
				if (MACHINE_WORKER_ACTIONS.has(request.action)) {
					const entry = entryFor(MACHINE_KEY, machineCwd());
					let done!: () => void;
					const previous = entry.mutationQueue;
					entry.mutationQueue = new Promise<void>((res) => {
						done = res;
					});
					await previous;
					try {
						return await requestViaWorker(entry, MACHINE_KEY, request, timeoutMs);
					} finally {
						done();
					}
				}

				const { key, cwd } = await resolveKey(request);
				let entry = entryFor(key, cwd);
				if (!revisionMatches(entry)) {
					if (entry.activeRun) {
						entry.drainAfterRun = true;
						return piError(
							request.requestId,
							"PI_PROJECT_BUSY",
							"Project has an active turn on an older runtime revision",
						);
					}
					entry.drainAfterRun = true;
					closeIfDraining(entry);
					entry = entryFor(key, cwd);
				}

				if (RUN_ESTABLISHING_ACTIONS.has(request.action)) {
					if (entry.activeRun && !(await reclaimStaleRun(entry))) {
						return piError(
							request.requestId,
							"PI_PROJECT_BUSY",
							"Project has an active turn",
						);
					}
					if (typeof request.runId !== "string" || request.runId.length === 0) {
						return piError(
							request.requestId,
							"PI_PROTOCOL_INVALID",
							"run-scoped action requires runId",
						);
					}
					entry.activeRun = {
						runId: request.runId,
						sessionId: request.sessionId ?? "",
						projectKey: key,
						status: "running",
					};
				} else if (DESTRUCTIVE_ACTIONS.has(request.action)) {
					if (entry.activeRun) {
						return piError(
							request.requestId,
							"PI_PROJECT_BUSY",
							"Project has an active turn",
						);
					}
					// 空闲 mutation 串行：等前一个完成
					const previous = entry.mutationQueue;
					let done!: () => void;
					entry.mutationQueue = new Promise<void>((res) => {
						done = res;
					});
					await previous;
					const result = await requestViaWorker(entry, key, request, timeoutMs);
					done();
					return result;
				}

				const run = entry.activeRun;
				const result = await requestViaWorker(entry, key, request, timeoutMs);
				if (
					((RUN_ESTABLISHING_ACTIONS.has(request.action) && !result.ok) ||
						(request.action === "agent.abort" && result.ok)) &&
					run?.sessionId === request.sessionId &&
					run?.runId === request.runId &&
					entry.activeRun === run
				) {
					entry.activeRun = null;
				}
				return result;
			} catch (err) {
				const code =
					typeof err === "object" && err !== null && "code" in err
						? (String((err as { code: unknown }).code) as PiErrorCode)
						: "PI_PROTOCOL_INVALID";
				// 普通对象抛出（如 resolveKey 的 {code,message}）不丢 message：非 Error 也要读 .message
				const message =
					err instanceof Error
						? err.message
						: typeof err === "object" &&
								err !== null &&
								typeof (err as { message?: unknown }).message === "string"
							? (err as { message: string }).message
							: "Request failed";
				return piError(request.requestId, code, message);
			}
		},

		getStateReport(): PiStateReport {
			const runs: PiRunSummary[] = [...orphanTerminals];
			for (const entry of registry.values()) {
				if (entry.activeRun) {
					runs.push({
						runId: entry.activeRun.runId,
						sessionId: entry.activeRun.sessionId,
						status: entry.activeRun.status,
						projectKey: entry.activeRun.projectKey,
					});
				}
				for (const t of entry.terminals) runs.push(t);
			}
			return {
				clientId,
				runs,
				runtimeRevision: activeRuntimeRevision(),
				configState: desired.configState,
			};
		},

		setRuntimeConfig(state) {
			desired = state;
			for (const entry of registry.values()) {
				if (entry.activeRuntimeRevision === state.runtimeRevision) continue;
				// 活跃 Run 不热替换：本轮完成后 drain 关闭；空闲则立即关闭。
				entry.drainAfterRun = true;
				closeIfDraining(entry);
			}
		},

		configState() {
			return desired;
		},

		activeRuntimeRevision() {
			return activeRuntimeRevision();
		},

		assertReady() {
			if (desired.configState !== "ready") {
				const failure = notReadyFailure({ requestId: "", action: "agent.prompt" });
				throw Object.assign(new Error(failure.message), { code: failure.code });
			}
		},

		isReady() {
			return desired.configState === "ready";
		},

		async applyStateAck(ack): Promise<{ allClosed: boolean }> {
			const accepted = new Set(ack.acceptedRunIds);
			for (let i = orphanTerminals.length - 1; i >= 0; i--) {
				if (accepted.has(orphanTerminals[i]?.runId ?? ""))
					orphanTerminals.splice(i, 1);
			}
			for (const entry of registry.values()) {
				entry.terminals = entry.terminals.filter((t) => !accepted.has(t.runId));
			}
			for (const runId of accepted) terminalCwd.delete(runId);

			let allClosed = true;
			for (const runId of ack.closedRunIds) {
				const entry = [...registry.values()].find(
					(candidate) => candidate.activeRun?.runId === runId,
				);
				const run = entry?.activeRun;
				if (!entry || !run) continue;
				const response = await requestViaWorker(
					entry,
					run.projectKey,
					{
						requestId: randomUUID(),
						action: "agent.abort",
						runId: run.runId,
						sessionId: run.sessionId,
					},
					REQUEST_TIMEOUT_MS,
				);
				if (response.ok) {
					if (entry.activeRun === run) entry.activeRun = null;
				} else {
					allClosed = false;
				}
			}
			return { allClosed };
		},

		onEvent(listener) {
			eventListeners.push(listener);
			return () => {
				const i = eventListeners.indexOf(listener);
				if (i !== -1) eventListeners.splice(i, 1);
			};
		},

		async shutdown() {
			for (const entry of registry.values()) {
				entry.handle.send({ type: "shutdown" });
			}
			registry.clear();
		},
	};
}

function isDialogKind(kind: unknown): boolean {
	return (
		kind === "select" ||
		kind === "confirm" ||
		kind === "input" ||
		kind === "editor"
	);
}

/** 组装 PiEvent 包装(供 bridge 转发) */
export function wrapPiEvent(
	clientId: string,
	sessionId: string,
	runId: string,
	event: PiClientEvent,
): PiEvent {
	return { clientId, sessionId, runId, event };
}

export { randomUUID as piRequestId };
