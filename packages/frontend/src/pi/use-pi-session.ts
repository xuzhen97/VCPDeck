import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PiAgentState,
	PiCwdRef,
	PiMessage,
	PiModelInfo,
	PiSessionContextPage,
	PiSessionDetail,
	PiSessionJobSnapshot,
	PiSessionOpenResult,
	PiThinkingLevel,
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
	| "done"
	| "disconnected"
	| "error";

export type PiThinkingSelection = "auto" | PiThinkingLevel;

export interface PiSessionState {
	messages: PiMessage[];
	session: PiSessionDetail | null;
	agentState: PiAgentState | null;
	job: PiSessionJobSnapshot | null;
	runId: string | null;
	status: PiSessionStatus;
	error: string | null;
	hasMore: boolean;
	nextCursor: string | null;
	/** 待回答的 Extension UI 请求 */
	pendingExtension: {
		requestId: string;
		kind: string;
		title?: string;
		message?: string;
		options?: string[];
	} | null;
	models: PiModelInfo[];
	thinkingSelection: PiThinkingSelection;
	thinkingText: string;
	thinkingDurationMs: number | null;
}

export interface PiSessionActions {
	createSession(clientId: string, cwdRef: PiCwdRef): Promise<string>;
	openSession(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
	): Promise<void>;
	send(input: { prompt: string; images?: unknown[] }): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	abortCompact(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: PiThinkingSelection): Promise<void>;
	extensionResponse(
		requestId: string,
		value?: string,
		confirmed?: boolean,
		cancelled?: boolean,
	): Promise<void>;
	navigate(targetId: string): Promise<void>;
	fork(messageId: string): Promise<void>;
	clone(): Promise<void>;
	complete(): Promise<void>;
	close(): void;
}

function effectiveStatus(
	job: PiSessionJobSnapshot,
	agentState: PiAgentState,
): PiSessionStatus {
	if (job.status === "done" || job.status === "cancelled") return "done";
	if (job.status === "disconnected") return "disconnected";
	if (job.status === "error") return "error";
	if (job.status === "waiting_input" || agentState.pendingExtension)
		return "waiting_input";
	return job.status === "idle" ? "idle" : "running";
}

const INITIAL_STATE: PiSessionState = {
	messages: [],
	session: null,
	agentState: null,
	job: null,
	runId: null,
	status: "idle",
	error: null,
	hasMore: false,
	nextCursor: null,
	pendingExtension: null,
	models: [],
	thinkingSelection: "auto",
	thinkingText: "",
	thinkingDurationMs: null,
};

/** 前端 Pi 会话状态机（参考 Pi Web useAgentSession 核心语义） */
export function usePiSession(
	pi: Pick<PiApi, "sessions" | "agent" | "models"> &
		Partial<Pick<PiApi, "running">>,
) {
	const [state, setState] = useState<PiSessionState>(INITIAL_STATE);
	const stateRef = useRef(state);
	stateRef.current = state;

	const sessionIdRef = useRef<string | null>(null);
	const clientIdRef = useRef<string | null>(null);
	const cwdRefRef = useRef<PiCwdRef | null>(null);
	const activeRunIdRef = useRef<string | null>(null);
	const isOwnerRef = useRef(false);
	const retiredRunIdsRef = useRef(new Set<string>());
	const rejectedSettlingRunIdRef = useRef<string | null>(null);
	const promptGenerationRef = useRef(0);
	const sessionGenerationRef = useRef(0);
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
		const sessionGeneration = sessionGenerationRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		try {
			const page = (await pi.sessions.context(clientId, sessionId, cwdRef, {
				...(nextCursorRef.current ? { cursor: nextCursorRef.current } : {}),
			})) as PiSessionContextPage;
			if (
				promptGenerationRef.current !== generation ||
				sessionGenerationRef.current !== sessionGeneration
			)
				return; // 旧 run/session 不覆盖
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
	const refreshState = useCallback(async (): Promise<PiAgentState | null> => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		const sessionGeneration = sessionGenerationRef.current;
		if (!clientId || !sessionId || !cwdRef) return null;
		try {
			const agentState = (await pi.agent.state(
				clientId,
				sessionId,
				cwdRef,
			)) as PiAgentState;
			if (sessionGenerationRef.current !== sessionGeneration) return null;
			setState((s) => ({ ...s, agentState }));
			// 权威状态补绑 runId（run_created 丢失或重连场景）
			if (
				agentState.status === "running" ||
				agentState.status === "waiting_for_extension_input"
			) {
				// 保持现有 runId；若为空且状态运行中，等待 run_created/权威接口
			}
			return agentState;
		} catch (err) {
			void err; // 连接未就绪时静默，重连后 refreshState 会重试
			return null;
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
		(
			clientId: string,
			sessionId: string,
			streamGeneration: number,
			onExtension: (
				ui: NonNullable<PiSessionState["pendingExtension"]>,
			) => void,
		) => {
			close();
			const stream = openPiEventStream(
				pi.agent.eventsPath(clientId, sessionId),
				{
					onEvent: (event) => {
						if (sessionGenerationRef.current !== streamGeneration) return;
						const runId =
							"runId" in event ? (event as { runId: string }).runId : undefined;
						// 旧 run 事件丢弃（activeRunId 未绑定时放行 run_created）
						if (
							runId &&
							(retiredRunIdsRef.current.has(runId) ||
								(activeRunIdRef.current && runId !== activeRunIdRef.current))
						) {
							return;
						}
						switch (event.type) {
							case "run_created": {
								const pendingGen = pendingSubmissionsRef.current.get(
									event.submissionId,
								);
								if (pendingGen !== undefined) {
									pendingSubmissionsRef.current.delete(event.submissionId);
									if (promptGenerationRef.current === pendingGen) {
										retiredRunIdsRef.current.delete(event.runId);
										activeRunIdRef.current = event.runId;
										setState((s) => ({
											...s,
											runId: event.runId,
											status: "running",
											job: s.job
												? { ...s.job, status: "running", runId: event.runId }
												: s.job,
										}));
									}
								}
								return;
							}
							case "agent_start":
								clearGrace();
								setState((s) => ({
									...s,
									status: "running",
									thinkingText: "",
									thinkingDurationMs: null,
								}));
								return;
							case "thinking_progress":
								setState((s) => ({
									...s,
									...(event.stage === "start"
										? { thinkingText: "", thinkingDurationMs: null }
										: {}),
									...(event.stage === "delta" && event.text
										? {
												thinkingText: `${s.thinkingText}${event.text}`.slice(
													0,
													262_144,
												),
											}
										: {}),
									...(event.stage === "end"
										? {
												thinkingDurationMs: event.durationMs ?? null,
												...(event.text && !s.thinkingText
													? { thinkingText: event.text.slice(0, 262_144) }
													: {}),
											}
										: {}),
								}));
								return;
							case "agent_end":
								// 非终态：进入 30 秒 grace
								scheduleGrace();
								return;
							case "prompt_done":
								// prompt_done 只表示 prompt Promise 已完成；Server 可在 grace 内
								// 权威收敛上一 run 并接受下一条 Prompt。
								scheduleGrace();
								return;
							case "agent_settled":
								clearGrace();
								if (runId) retiredRunIdsRef.current.add(runId);
								if (rejectedSettlingRunIdRef.current === runId)
									rejectedSettlingRunIdRef.current = null;
								activeRunIdRef.current = null;
								setState((s) => ({
									...s,
									status: "idle",
									runId: null,
									job: s.job ? { ...s.job, status: "idle", runId: null } : null,
								}));
								void reloadHistory();
								void refreshState();
								return;
							case "extension_request":
								if (
									event.ui.kind === "notify" ||
									event.ui.kind === "setStatus" ||
									event.ui.kind === "setWidget" ||
									event.ui.kind === "setTitle" ||
									event.ui.kind === "set_editor_text"
								) {
									return;
								}
								clearGrace();
								setState((s) => ({
									...s,
									status: "waiting_input",
									job: s.job ? { ...s.job, status: "waiting_input" } : null,
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
							case "extension_resolved":
								setState((s) => {
									if (s.pendingExtension?.requestId !== event.requestId) return s;
									const hasPending = event.hasPending === true;
									return {
										...s,
										pendingExtension: null,
										status: hasPending ? "waiting_input" : "running",
										job: s.job
											? {
													...s.job,
													status: hasPending ? "waiting_input" : "running",
												}
											: null,
									};
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
						if (sessionGenerationRef.current !== streamGeneration) return;
						setState((s) => ({
							...s,
							status: "idle",
							error: "连接已断开，等待自动重连",
						}));
					},
				},
			);
			streamRef.current = stream;
			return stream;
		},
		[pi, close, clearGrace, scheduleGrace, scheduleReconcile],
	);

	const openSession = useCallback(
		async (clientId: string, sessionId: string, cwdRef: PiCwdRef) => {
			const sessionGeneration = sessionGenerationRef.current + 1;
			sessionGenerationRef.current = sessionGeneration;
			clientIdRef.current = clientId;
			sessionIdRef.current = sessionId;
			cwdRefRef.current = cwdRef;
			promptGenerationRef.current = 0;
			pendingSubmissionsRef.current.clear();
			activeRunIdRef.current = null;
			isOwnerRef.current = false;
			retiredRunIdsRef.current.clear();
			rejectedSettlingRunIdRef.current = null;
			nextCursorRef.current = null;
			setState({ ...INITIAL_STATE, status: "loading" });

			const stream = openStream(
				clientId,
				sessionId,
				sessionGeneration,
				() => {},
			);
			await stream.connected();
			if (sessionGenerationRef.current !== sessionGeneration) return;

			// /open 补建并返回权威 Session Job；历史和模型只补充展示细节。
			const modelsPromise = pi.models(clientId, cwdRef).catch((err: unknown) => {
				if (sessionGenerationRef.current !== sessionGeneration) return null;
				setState((s) => ({
					...s,
					error: err instanceof Error ? err.message : String(err),
				}));
				return null;
			});
			const [openResult, , models] = await Promise.all([
				pi.agent.open(clientId, sessionId, cwdRef) as Promise<PiSessionOpenResult>,
				reloadHistory(),
				modelsPromise,
			]);
			if (sessionGenerationRef.current !== sessionGeneration) return;
			const { job, agentState } = openResult;
			activeRunIdRef.current = job.runId;
			isOwnerRef.current = job.isOwner;
			if (job.runId) retiredRunIdsRef.current.delete(job.runId);
			const pendingExtension = job.runId ? agentState.pendingExtension ?? null : null;
			setState((s) => ({
				...s,
				job,
				agentState,
				status: effectiveStatus(job, agentState),
				runId: job.runId,
				pendingExtension,
				...(models ? { models } : {}),
				thinkingSelection: agentState.thinkingLevel,
			}));
		},
		[openStream, reloadHistory, refreshState, pi],
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
			if (
				!isOwnerRef.current ||
				(rejectedSettlingRunIdRef.current !== null &&
					rejectedSettlingRunIdRef.current === activeRunIdRef.current) ||
				(!(["idle", "done"] as PiSessionStatus[]).includes(
					stateRef.current.status,
				) && !graceTimerRef.current)
			)
				return;
			const stream = streamRef.current;
			if (!stream) {
				setState((s) => ({ ...s, error: "事件流未就绪" }));
				return;
			}
			const sessionGeneration = sessionGenerationRef.current;
			await stream.connected();
			if (sessionGenerationRef.current !== sessionGeneration) return;

			const settlingRunId = graceTimerRef.current
				? activeRunIdRef.current
				: null;
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
				if (
					sessionGenerationRef.current === sessionGeneration &&
					promptGenerationRef.current === generation
				) {
					if (
						activeRunIdRef.current === null ||
						activeRunIdRef.current === settlingRunId
					) {
						if (settlingRunId) retiredRunIdsRef.current.add(settlingRunId);
						rejectedSettlingRunIdRef.current = null;
						activeRunIdRef.current = accepted.runId;
						setState((s) => ({
							...s,
							runId: accepted.runId,
							job: s.job
								? { ...s.job, status: "running", runId: accepted.runId }
								: s.job,
						}));
					}
				}
			} catch (err) {
				pendingSubmissionsRef.current.delete(submissionId);
				if (
					sessionGenerationRef.current === sessionGeneration &&
					promptGenerationRef.current === generation
				) {
					const restoreSettlingRun =
						settlingRunId !== null &&
						activeRunIdRef.current === settlingRunId;
					if (restoreSettlingRun) {
						rejectedSettlingRunIdRef.current = settlingRunId;
						scheduleGrace();
					}
					setState((s) => ({
						...s,
						...(restoreSettlingRun
							? {
									status: "running" as const,
									runId: settlingRunId,
									job: s.job
										? { ...s.job, status: "running" as const, runId: settlingRunId }
										: s.job,
								}
							: { status: "idle" as const }),
						error: err instanceof Error ? err.message : String(err),
					}));
				}
			}
		},
		[pi, clearGrace, scheduleGrace],
	);

	const withRun = useCallback(
		async (
			fn: (
				clientId: string,
				sessionId: string,
				runId: string,
				sessionGeneration: number,
			) => Promise<unknown>,
		) => {
			const clientId = clientIdRef.current;
			const sessionId = sessionIdRef.current;
			const runId = activeRunIdRef.current;
			const sessionGeneration = sessionGenerationRef.current;
			if (!clientId || !sessionId || !runId || !isOwnerRef.current) return;
			await fn(clientId, sessionId, runId, sessionGeneration);
		},
		[],
	);

	const actions = useMemo<PiSessionActions>(
		() => ({
			createSession,
			openSession,
			send,
			steer: (message) =>
				withRun((c, s, runId) => pi.agent.steer(c, s, runId, message)),
			followUp: (message) =>
				withRun((c, s, runId) => pi.agent.followUp(c, s, runId, message)),
			abort: () =>
				withRun(async (c, s, runId, sessionGeneration) => {
					await pi.agent.abort(c, s, runId);
					if (sessionGenerationRef.current !== sessionGeneration) return;
					clearGrace();
					retiredRunIdsRef.current.add(runId);
					setState((st) => ({
						...st,
						status: "idle",
						runId: null,
						job: st.job ? { ...st.job, status: "idle", runId: null } : null,
					}));
					activeRunIdRef.current = null;
				}),
			compact: (customInstructions) =>
				withRun((c, s, runId) =>
					pi.agent.compact(c, s, runId, customInstructions),
				),
			abortCompact: () =>
				withRun((c, s, runId) => pi.agent.abortCompact(c, s, runId)),
			setModel: async (provider, modelId) => {
				if (
					stateRef.current.status !== "idle" ||
					stateRef.current.agentState?.compacting === true
				)
					return;
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				const sessionGeneration = sessionGenerationRef.current;
				try {
					await pi.agent.setModel(
						clientId,
						sessionId,
						cwdRef,
						provider,
						modelId,
					);
					if (sessionGenerationRef.current !== sessionGeneration) return;
					await refreshState();
					if (sessionGenerationRef.current !== sessionGeneration) return;
					setState((s) => ({ ...s, error: null }));
				} catch (err) {
					if (sessionGenerationRef.current === sessionGeneration) {
						setState((s) => ({
							...s,
							error: err instanceof Error ? err.message : String(err),
						}));
					}
					throw err;
				}
			},
				setThinking: async (level) => {
				if (level === "auto") {
					setState((s) => ({ ...s, thinkingSelection: "auto", error: null }));
					return;
				}
				if (
					stateRef.current.status !== "idle" ||
					stateRef.current.agentState?.compacting === true
				)
					return;
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef) return;
				const sessionGeneration = sessionGenerationRef.current;
				try {
					await pi.agent.setThinking(clientId, sessionId, cwdRef, level);
					if (sessionGenerationRef.current !== sessionGeneration) return;
					const agentState = await refreshState();
					if (sessionGenerationRef.current !== sessionGeneration) return;
					setState((s) => ({
						...s,
						thinkingSelection: agentState?.thinkingLevel ?? level,
						error: null,
					}));
				} catch (err) {
					if (sessionGenerationRef.current === sessionGeneration) {
						setState((s) => ({
							...s,
							error: err instanceof Error ? err.message : String(err),
						}));
					}
					throw err;
				}
			},
			extensionResponse: (requestId, value, confirmed, cancelled) =>
				withRun(async (c, s, runId, sessionGeneration) => {
					await pi.agent.extensionResponse(c, s, runId, {
						requestId,
						...(value !== undefined ? { value } : {}),
						...(confirmed !== undefined ? { confirmed } : {}),
						...(cancelled === true ? { cancelled: true } : {}),
					});
					if (sessionGenerationRef.current !== sessionGeneration) return;
					setState((st) =>
						st.pendingExtension?.requestId === requestId
							? {
									...st,
									status: "running",
									pendingExtension: null,
									job: st.job ? { ...st.job, status: "running" } : null,
								}
							: st,
					);
				}),
			navigate: async (targetId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef || !stateRef.current.job?.isOwner)
					return;
				await pi.sessions.navigate(clientId, sessionId, cwdRef, targetId);
			},
			fork: async (messageId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef || !stateRef.current.job?.isOwner)
					return;
				await pi.sessions.fork(clientId, sessionId, cwdRef, messageId);
			},
			clone: async () => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef || !stateRef.current.job?.isOwner)
					return;
				await pi.sessions.clone(clientId, sessionId, cwdRef);
			},
			complete: async () => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const job = stateRef.current.job;
				const sessionGeneration = sessionGenerationRef.current;
				if (!clientId || !sessionId || !job?.isOwner) return;
				const snapshot = await pi.agent.complete(
					clientId,
					sessionId,
					activeRunIdRef.current ?? undefined,
				);
				if (sessionGenerationRef.current !== sessionGeneration) return;
				activeRunIdRef.current = snapshot.runId;
				setState((s) => ({
					...s,
					job: snapshot,
					runId: snapshot.runId,
					status: snapshot.status === "error" ? "error" : "done",
					pendingExtension: null,
				}));
			},
			close,
		}),
		[
			createSession,
			openSession,
			send,
			withRun,
			pi,
			clearGrace,
			close,
			refreshState,
		],
	);

	return { state, actions };
}
