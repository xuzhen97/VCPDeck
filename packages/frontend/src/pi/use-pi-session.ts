import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PiAgentState,
	PiCwdRef,
	PiMessage,
	PiSessionContextPage,
	PiSessionDetail,
} from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { openPiEventStream, type PiEventStream } from "./pi-stream.js";

/** 事件后到 history/state 对账的 debounce（30 秒 grace 对齐） */
const RECONCILE_DEBOUNCE_MS = 500;
/** 30 秒 idle grace：grace 内新 activity 取消关闭 */
const IDLE_GRACE_MS = 30_000;

export type PiSessionStatus =
	| "idle"
	| "loading"
	| "running"
	| "waiting_input"
	| "error";

export interface PiSessionState {
	messages: PiMessage[];
	session: PiSessionDetail | null;
	agentState: PiAgentState | null;
	runId: string | null;
	status: PiSessionStatus;
	error: string | null;
	hasMore: boolean;
	nextCursor: string | null;
	/** 待回答的 Extension UI 请求 */
	pendingExtension: { requestId: string; kind: string; title?: string; message?: string; options?: string[] } | null;
}

export interface PiSessionActions {
	createSession(clientId: string, cwdRef: PiCwdRef): Promise<string>;
	openSession(clientId: string, sessionId: string, cwdRef: PiCwdRef): Promise<void>;
	send(input: { prompt: string; images?: unknown[] }): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	abortCompact(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: string): Promise<void>;
	extensionResponse(requestId: string, value?: string, confirmed?: boolean): Promise<void>;
	navigate(targetId: string): Promise<void>;
	fork(messageId: string): Promise<void>;
	clone(): Promise<void>;
	close(): void;
}

const INITIAL_STATE: PiSessionState = {
	messages: [],
	session: null,
	agentState: null,
	runId: null,
	status: "idle",
	error: null,
	hasMore: false,
	nextCursor: null,
	pendingExtension: null,
};

/** 前端 Pi 会话状态机（参考 Pi Web useAgentSession 核心语义） */
export function usePiSession(pi: Pick<PiApi, "sessions" | "agent">) {
	const [state, setState] = useState<PiSessionState>(INITIAL_STATE);

	const sessionIdRef = useRef<string | null>(null);
	const clientIdRef = useRef<string | null>(null);
	const cwdRefRef = useRef<PiCwdRef | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	const promptGenerationRef = useRef(0);
	const nextCursorRef = useRef<string | null>(null);
	const pendingSubmissionsRef = useRef(new Map<string, number>());
	const streamRef = useRef<PiEventStream | null>(null);
	const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearGrace = useCallback(() => {
		if (graceTimerRef.current) {
			clearTimeout(graceTimerRef.current);
			graceTimerRef.current = null;
		}
	}, []);

	/** 重新读取历史（generation 守卫：旧 run 结果不覆盖新 run） */
	const reloadHistory = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		const generation = promptGenerationRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		try {
			const page = (await pi.sessions.context(clientId, sessionId, cwdRef, {
				...(nextCursorRef.current ? { cursor: nextCursorRef.current } : {}),
			})) as PiSessionContextPage;
			if (promptGenerationRef.current !== generation) return; // 旧 run 不覆盖
			nextCursorRef.current = page.nextCursor ?? null;
			setState((s) => ({
				...s,
				messages: page.messages,
				hasMore: page.nextCursor !== null,
				nextCursor: page.nextCursor ?? null,
			}));
		} catch {
			// 忽略：连接恢复后重试
		}
	}, [pi]);

	/** 读取权威 agent state（reconcile/补绑 runId） */
	const refreshState = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		try {
			const agentState = (await pi.agent.state(clientId, sessionId, cwdRef)) as PiAgentState;
			setState((s) => ({ ...s, agentState }));
			// 权威状态补绑 runId（run_created 丢失或重连场景）
			if (
				agentState.status === "running" ||
				agentState.status === "waiting_for_extension_input"
			) {
				// 保持现有 runId；若为空且状态运行中，等待 run_created/权威接口
			}
		} catch (err) {
			void err; // 连接未就绪时静默，重连后 refreshState 会重试
		}
	}, [pi]);

	const scheduleReconcile = useCallback(() => {
		if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
		reconcileTimerRef.current = setTimeout(() => {
			reconcileTimerRef.current = null;
			void reloadHistory();
			void refreshState();
		}, RECONCILE_DEBOUNCE_MS);
	}, [reloadHistory, refreshState]);

	/** 30 秒 grace：到期后对账；期间新 activity 取消 */
	const scheduleGrace = useCallback(() => {
		clearGrace();
		graceTimerRef.current = setTimeout(() => {
			graceTimerRef.current = null;
			void reloadHistory();
			void refreshState();
		}, IDLE_GRACE_MS);
	}, [clearGrace, reloadHistory, refreshState]);

	const close = useCallback(() => {
		streamRef.current?.close();
		streamRef.current = null;
		clearGrace();
		if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
	}, [clearGrace]);

	useEffect(() => close, [close]);

	/** 页面可见性/网络恢复时立即对账（Pi Web 语义） */
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") {
				void reloadHistory();
				void refreshState();
			}
		};
		const onOnline = () => {
			void reloadHistory();
			void refreshState();
		};
		window.addEventListener("visibilitychange", onVisible);
		window.addEventListener("online", onOnline);
		return () => {
			window.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("online", onOnline);
		};
	}, [reloadHistory, refreshState]);

	const openStream = useCallback(
		(clientId: string, sessionId: string, onExtension: (ui: NonNullable<PiSessionState["pendingExtension"]>) => void) => {
			close();
			const stream = openPiEventStream(pi.agent.eventsPath(clientId, sessionId), {
				onEvent: (event) => {
					const runId = "runId" in event ? (event as { runId: string }).runId : undefined;
					// 旧 run 事件丢弃（activeRunId 未绑定时放行 run_created）
					if (
						runId &&
						activeRunIdRef.current &&
						runId !== activeRunIdRef.current
					) {
						return;
					}
					switch (event.type) {
						case "run_created": {
							const pendingGen = pendingSubmissionsRef.current.get(event.submissionId);
							if (pendingGen !== undefined) {
								pendingSubmissionsRef.current.delete(event.submissionId);
								if (promptGenerationRef.current === pendingGen) {
									activeRunIdRef.current = event.runId;
									setState((s) => ({ ...s, runId: event.runId, status: "running" }));
								}
							}
							return;
						}
						case "agent_start":
							clearGrace();
							setState((s) => ({ ...s, status: "running" }));
							return;
						case "agent_end":
							// 非终态：进入 30 秒 grace
							scheduleGrace();
							return;
						case "prompt_done":
						case "agent_settled":
							scheduleGrace();
							return;
						case "extension_request":
							clearGrace();
							setState((s) => ({
								...s,
								status: "waiting_input",
								pendingExtension: {
									requestId: event.ui.requestId,
									kind: event.ui.kind,
									...(event.ui.title ? { title: event.ui.title } : {}),
									...(event.ui.message ? { message: event.ui.message } : {}),
									...(event.ui.options ? { options: event.ui.options } : {}),
								},
							}));
							onExtension({
								requestId: event.ui.requestId,
								kind: event.ui.kind,
								...(event.ui.title ? { title: event.ui.title } : {}),
								...(event.ui.message ? { message: event.ui.message } : {}),
								...(event.ui.options ? { options: event.ui.options } : {}),
							});
							return;
						case "history_changed":
						case "message_update":
							scheduleReconcile();
							return;
						default:
							return;
					}
				},
				onFatal: () => {
					setState((s) => ({ ...s, status: "idle", error: "连接已断开，等待自动重连" }));
				},
			});
			streamRef.current = stream;
			return stream;
		},
		[pi, close, clearGrace, scheduleGrace, scheduleReconcile],
	);

	const openSession = useCallback(
		async (clientId: string, sessionId: string, cwdRef: PiCwdRef) => {
			clientIdRef.current = clientId;
			sessionIdRef.current = sessionId;
			cwdRefRef.current = cwdRef;
			promptGenerationRef.current = 0;
			activeRunIdRef.current = null;
			nextCursorRef.current = null;
			setState({ ...INITIAL_STATE, status: "loading" });

			const stream = openStream(clientId, sessionId, () => {});
			await stream.connected();

			// 附着：读取历史 + 权威状态
			await reloadHistory();
			await refreshState();
			setState((s) => ({ ...s, status: "idle" }));
		},
		[openStream, reloadHistory, refreshState],
	);

	const createSession = useCallback(
		async (clientId: string, cwdRef: PiCwdRef): Promise<string> => {
			const { sessionId } = (await pi.agent.newSession(clientId, cwdRef)) as {
				sessionId: string;
			};
			await openSession(clientId, sessionId, cwdRef);
			return sessionId;
		},
		[pi, openSession],
	);

	const send = useCallback(
		async (input: { prompt: string; images?: unknown[] }) => {
			const clientId = clientIdRef.current;
			const sessionId = sessionIdRef.current;
			const cwdRef = cwdRefRef.current;
			if (!clientId || !sessionId || !cwdRef) {
				setState((s) => ({ ...s, error: "尚未打开会话" }));
				return;
			}
			const stream = streamRef.current;
			if (!stream) {
				setState((s) => ({ ...s, error: "事件流未就绪" }));
				return;
			}
			await stream.connected();

			promptGenerationRef.current += 1;
			const generation = promptGenerationRef.current;
			const submissionId = crypto.randomUUID();
			pendingSubmissionsRef.current.set(submissionId, generation);
			clearGrace();
			setState((s) => ({ ...s, status: "running", error: null }));

			try {
				const accepted = (await pi.agent.prompt(clientId, sessionId, cwdRef, {
					submissionId,
					prompt: input.prompt,
					...(input.images?.length ? { images: input.images } : {}),
				})) as { jobId: string; runId: string; sessionId: string };
				// POST response 补绑（run_created 可能已到；未到则用权威响应）
				if (promptGenerationRef.current === generation) {
					if (activeRunIdRef.current === null) {
						activeRunIdRef.current = accepted.runId;
						setState((s) => ({ ...s, runId: accepted.runId }));
					}
				}
			} catch (err) {
				pendingSubmissionsRef.current.delete(submissionId);
				if (promptGenerationRef.current === generation) {
					setState((s) => ({
						...s,
						status: "idle",
						error: err instanceof Error ? err.message : String(err),
					}));
				}
			}
		},
		[pi, clearGrace],
	);

	const withRun = useCallback(
		async (fn: (clientId: string, sessionId: string, runId: string) => Promise<unknown>) => {
			const clientId = clientIdRef.current;
			const sessionId = sessionIdRef.current;
			const runId = activeRunIdRef.current;
			if (!clientId || !sessionId || !runId) return;
			await fn(clientId, sessionId, runId);
		},
		[],
	);

	const actions = useMemo<PiSessionActions>(
		() => ({
			createSession,
			openSession,
			send,
			steer: (message) =>
				withRun((c, s, runId) =>
					pi.agent.steer(c, s, runId, message),
				),
			followUp: (message) =>
				withRun((c, s, runId) =>
					pi.agent.followUp(c, s, runId, message),
				),
			abort: () =>
				withRun(async (c, s, runId) => {
					await pi.agent.abort(c, s, runId);
					clearGrace();
					setState((st) => ({ ...st, status: "idle", runId: null }));
					activeRunIdRef.current = null;
				}),
			compact: (customInstructions) =>
				withRun((c, s, runId) =>
					pi.agent.compact(c, s, runId, customInstructions),
				),
			abortCompact: () =>
				withRun((c, s, runId) => pi.agent.abortCompact(c, s, runId)),
			setModel: async (provider, modelId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				await pi.agent.setModel(clientId, sessionId, cwdRef, provider, modelId);
			},
			setThinking: async (level) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				await pi.agent.setThinking(clientId, sessionId, cwdRef, level);
			},
			extensionResponse: (requestId, value, confirmed) =>
				withRun(async (c, s, runId) => {
					await pi.agent.extensionResponse(c, s, runId, {
						requestId,
						...(value !== undefined ? { value } : {}),
						...(confirmed !== undefined ? { confirmed } : {}),
					});
					setState((st) => ({ ...st, status: "running", pendingExtension: null }));
				}),
			navigate: async (targetId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				await pi.sessions.navigate(clientId, sessionId, cwdRef, targetId);
			},
			fork: async (messageId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				await pi.sessions.fork(clientId, sessionId, cwdRef, messageId);
			},
			clone: async () => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				await pi.sessions.clone(clientId, sessionId, cwdRef);
			},
			close,
		}),
		[createSession, openSession, send, withRun, pi, clearGrace, close],
	);

	return { state, actions };
}
