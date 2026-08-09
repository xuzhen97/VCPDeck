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

/** 单个请求等待 Worker 响应的上限 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Worker 进程句柄（测试注入） */
export interface PiWorkerHandle {
	send(msg: PiWorkerRequestMessage): void;
	onMessage(listener: (msg: PiWorkerOutboundMessage) => void): () => void;
	onExit(listener: (code: number) => void): () => void;
	kill(): void;
}

interface ActiveRun {
	jobId: string;
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

export interface PiSupervisor {
	request(request: PiRequest, timeoutMs?: number): Promise<PiResponse>;
	getStateReport(): PiStateReport;
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
		{ cwd: string; jobId: string; sessionId: string }
	>();
	const eventListeners: ((event: PiEvent) => void)[] = [];
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
		if (request.jobId) {
			for (const [key, entry] of registry) {
				if (
					entry.activeRun?.jobId === request.jobId &&
					(!request.runId || entry.activeRun.runId === request.runId)
				) {
					return { key, cwd: entry.cwd };
				}
			}
			// settlement 在 activeRun 清除后查询：按 runId 回退，避免同 Session 多轮冲突
			const settled = request.runId
				? terminalCwd.get(request.runId)
				: undefined;
			if (settled && settled.jobId === request.jobId) {
				return {
					key: projectKeyFor(canonicalPath(settled.cwd)),
					cwd: settled.cwd,
				};
			}
			throw { code: "PI_SESSION_NOT_FOUND", message: "No active run for job" };
		}
		throw {
			code: "PI_PROTOCOL_INVALID",
			message: "Request needs cwdRef or jobId",
		};
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
		};
		registry.set(key, entry);

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
				if (run && msg.jobId === run.jobId && msg.runId === run.runId) {
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
					if (msg.event.type === "agent_settled") {
						entry.terminals.push({
							jobId: run.jobId,
							runId: run.runId,
							sessionId: run.sessionId,
							status: "done",
							projectKey: run.projectKey,
						});
						terminalCwd.set(run.runId, {
							cwd: entry.cwd,
							jobId: run.jobId,
							sessionId: run.sessionId,
						});
						entry.activeRun = null;
					}
					if (msg.event.type === "prompt_error") {
						entry.terminals.push({
							jobId: run.jobId,
							runId: run.runId,
							sessionId: run.sessionId,
							status: "error",
							projectKey: run.projectKey,
						});
						terminalCwd.set(run.runId, {
							cwd: entry.cwd,
							jobId: run.jobId,
							sessionId: run.sessionId,
						});
						entry.activeRun = null;
					}
				}
				emitEvent({
					clientId,
					sessionId: msg.sessionId,
					jobId: msg.jobId,
					runId: msg.runId,
					event: msg.event,
				});
			}
		});

		handle.onExit(() => {
			if (entry.activeRun) {
				const run = entry.activeRun;
				orphanTerminals.push({
					jobId: run.jobId,
					runId: run.runId,
					sessionId: run.sessionId,
					status: "error",
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

				const { key, cwd } = await resolveKey(request);
				const entry = entryFor(key, cwd);

				if (request.action === "agent.prompt") {
					if (entry.activeRun) {
						return piError(
							request.requestId,
							"PI_PROJECT_BUSY",
							"Project has an active turn",
						);
					}
					entry.activeRun = {
						jobId: request.jobId ?? "",
						runId: request.runId ?? request.jobId ?? "",
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

				const result = await requestViaWorker(entry, key, request, timeoutMs);
				if (
					request.action === "agent.prompt" &&
					!result.ok &&
					entry.activeRun?.jobId === request.jobId &&
					entry.activeRun?.runId === request.runId
				) {
					entry.activeRun = null;
				}
				return result;
			} catch (err) {
				const code =
					typeof err === "object" && err !== null && "code" in err
						? (String((err as { code: unknown }).code) as PiErrorCode)
						: "PI_PROTOCOL_INVALID";
				return piError(
					request.requestId,
					code,
					err instanceof Error ? err.message : "Request failed",
				);
			}
		},

		getStateReport(): PiStateReport {
			const runs: PiRunSummary[] = [...orphanTerminals];
			for (const entry of registry.values()) {
				if (entry.activeRun) {
					runs.push({
						jobId: entry.activeRun.jobId,
						runId: entry.activeRun.runId,
						sessionId: entry.activeRun.sessionId,
						status: entry.activeRun.status,
						projectKey: entry.activeRun.projectKey,
					});
				}
				for (const t of entry.terminals) runs.push(t);
			}
			return { clientId, runs };
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
						jobId: run.jobId,
						runId: run.runId,
						sessionId: run.sessionId,
					},
					REQUEST_TIMEOUT_MS,
				);
				if (response.ok && entry.activeRun === run) entry.activeRun = null;
				else allClosed = false;
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

/** 组装 PiEvent 包装（供 bridge 转发） */
export function wrapPiEvent(
	clientId: string,
	sessionId: string,
	jobId: string,
	runId: string,
	event: PiClientEvent,
): PiEvent {
	return { clientId, sessionId, jobId, runId, event };
}

export { randomUUID as piRequestId };
