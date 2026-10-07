import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	PiAgentState,
	PiAttachmentRef,
	PiCwdRef,
	PiExtensionCommands,
	PiExtensionUiSnapshot,
	PiMessage,
	PiModelInfo,
	PiSessionContextPage,
	PiSessionDetail,
	PiSessionJobSnapshot,
	PiSessionOpenResult,
	PiThinkingLevel,
} from "@vcpdeck/shared";
import type { PiApi } from "@vcpdeck/sdk";
import { randomUUID } from "@/lib/utils";
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

/** prompt 接纳结果：上层据此决定是否丢弃附件草稿。 */
export type PiSendResult = "accepted" | "rejected";

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
	/** 当前 Session/runtime 实际注册的扩展命令（绑定换代，不含本地路径）。 */
	commands: PiExtensionCommands | null;
	/** 持续 UI 状态快照（status/widget/title 的最新有界值）。 */
	extensionUi: PiExtensionUiSnapshot | null;
	/** 待处理的扩展编辑填充请求；由用户显式应用或忽略，UI 不自动发送。 */
	editorRequest: { requestId: string; text: string } | null;
}

export interface PiSessionActions {
	createSession(clientId: string, cwdRef: PiCwdRef): Promise<string>;
	openSession(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
	): Promise<void>;
	/** 加载更早的历史消息（追加到消息列表头部）。 */
	loadMore(): Promise<void>;
	/** 返回是否被接纳；`rejected` 时调用方应保留草稿。 */
	send(input: { prompt: string; images?: PiAttachmentRef[] }): Promise<PiSendResult>;
	/**
	 * 调用已注册的扩展斜杠命令。
	 *
	 * 绝不回退为普通 Prompt（未知命令必须明确拒绝）；命令不允许携带附件。
	 * 返回 `rejected` 时调用方应保留草稿。
	 */
	command(name: string, args?: string): Promise<PiSendResult>;
	/** 重新拉取持续 UI 快照（重连后读取最新值，不重放历史更新）。 */
	refreshExtensionUi(): Promise<void>;
	/** 丢弃待应用的编辑填充请求。 */
	dismissEditorRequest(requestId: string): void;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	compact(customInstructions?: string): Promise<void>;
	abortCompact(): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: PiThinkingSelection): Promise<void>;
	setExecutionMode(mode: import("@vcpdeck/shared").PiToolExecutionMode | null): Promise<void>;
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
	/** 重置内部状态（用于删除会话后清空会话相关 UI）。 */
	reset(): void;
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
	commands: null,
	extensionUi: null,
	editorRequest: null,
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
	/** 已加载过更早历史（reloadHistory 合并时不再把 hasMore 重置回最新窗口语义） */
	const loadedMoreRef = useRef(false);
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

	/**
	 * 重新读取最新窗口（generation 守卫：旧 run 结果不覆盖新 run）。
	 * 已加载的更早历史保持不变（旧消息不会变更），只更新最新窗口部分。
	 */
	const reloadHistory = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		const generation = promptGenerationRef.current;
		const sessionGeneration = sessionGenerationRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		try {
			const page = (await pi.sessions.context(
				clientId,
				sessionId,
				cwdRef,
			)) as PiSessionContextPage;
			if (
				promptGenerationRef.current !== generation ||
				sessionGenerationRef.current !== sessionGeneration
			)
				return; // 旧 run/session 不覆盖
			nextCursorRef.current = page.nextCursor ?? null;
			setState((s) => {
				const newIds = new Set(page.messages.map((m) => m.id));
				// 最新窗口外的消息（更早历史）保持不变；分页窗口互不重叠
				const older = s.messages.filter((m) => !newIds.has(m.id));
				const messages = [...older, ...page.messages];
				const firstLoad = s.messages.length === 0;
				return {
					...s,
					messages,
					// 追加后“更早”游标 = 当前最旧消息；hasMore 只在首载/loadMore 时更新
					nextCursor: messages.length > 0 ? messages[0]!.id : null,
					hasMore: firstLoad ? page.nextCursor !== null : s.hasMore,
				};
			});
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

	/** 清空所有会话相关 UI 状态（消息、运行详情、扩展请求等）。保留 stream/timers。 */
	const reset = useCallback(() => {
		setState({ ...INITIAL_STATE });
	}, []);

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
	/**
	 * 应用持续 UI 快照，按换代与 sequence 做新旧裁决。
	 *
	 * 同换代时只有更大的 sequence 能覆盖；换代变化则以本次权威查询结果为准。
	 * 这样迟到的旧状态不会回滚界面（ADR-0040 决策 4）。
	 */
	const applyExtensionUi = useCallback((incoming: PiExtensionUiSnapshot) => {
		setState((s) => {
			const current = s.extensionUi;
			const sameGeneration =
				current !== null &&
				current.runtimeInstanceId === incoming.runtimeInstanceId &&
				current.runtimeRevision === incoming.runtimeRevision;
			if (sameGeneration && incoming.sequence <= current.sequence) return s;
			return { ...s, extensionUi: incoming };
		});
	}, []);

	const refreshExtensionUi = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		const sessionGeneration = sessionGenerationRef.current;
		try {
			const snapshot = await pi.agent.extensionUi(clientId, sessionId, cwdRef);
			if (sessionGenerationRef.current !== sessionGeneration) return;
			applyExtensionUi(snapshot);
		} catch {
			// 恢复快照失败不得用空值覆写已有状态（重连抖动不该清空界面）。
		}
	}, [pi, applyExtensionUi]);

	const refreshCommands = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		// Client 端按 cwdRef 解析会话归属与项目；缺它会被 PI_PROTOCOL_INVALID 拒绝。
		const cwdRef = cwdRefRef.current;
		if (!clientId || !sessionId || !cwdRef) return;
		const sessionGeneration = sessionGenerationRef.current;
		try {
			const commands = await pi.agent.commands(clientId, sessionId, cwdRef);
			if (sessionGenerationRef.current !== sessionGeneration) return;
			setState((s) => ({ ...s, commands }));
		} catch {
			// 清单拉取失败不阻断会话；下次重连再试。
		}
	}, [pi]);

	const dismissEditorRequest = useCallback((requestId: string) => {
		setState((s) =>
			s.editorRequest?.requestId === requestId
				? { ...s, editorRequest: null }
				: s,
		);
	}, []);

	/**
	 * 调用已注册的扩展斜杠命令。
	 *
	 * 命令是**启动新工作**，因此与 prompt 一样由 Server 接纳 Run：
	 * 前端不得自带 runId（否则会绕过项目互斥与结算）。
	 * 只走 executeCommand：未知命令明确拒绝，**绝不**回退为普通 Prompt。
	 * 返回 `rejected` 时调用方应保留草稿。
	 */


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
			// 本条流的首连标志：openSession 已统一拉取，重连时才需要刷新。
			let firstOpen = true;
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
							case "prompt_error":
								// 运行失败：与 agent_settled 同样收尾，并把错误浮到界面（否则永远卡在运行中）
								clearGrace();
								activeRunIdRef.current = null;
								setState((s) => ({
									...s,
									status: "idle",
									runId: null,
									job: s.job
										? { ...s.job, status: "idle", runId: null }
										: null,
									error: event.message,
								}));
								void reloadHistory();
								void refreshState();
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
								// 编辑填充是一次性请求：记下待应用项，由用户显式应用或忽略；
								// UI 不得自动发送或静默覆写用户的草稿（ADR-0040 决策 3）。
								if (event.ui.kind === "set_editor_text") {
									setState((s) => ({
										...s,
										editorRequest: {
											requestId: event.ui.requestId,
											text: event.ui.message ?? "",
										},
									}));
									return;
								}
								// notify/status/widget/title 属持续状态：统一由有界快照投影，
								// 事件通道不得逐条覆写快照。
								if (
									event.ui.kind === "notify" ||
									event.ui.kind === "setStatus" ||
									event.ui.kind === "setWidget" ||
									event.ui.kind === "setTitle"
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
									if (s.pendingExtension?.requestId !== event.requestId)
										return s;
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
					// 每次（重）连接都重新对账并拉取最新有界快照：
					// ADR-0040 决策 4——重连读最新快照，不重放历史更新。
					// 首次连接交给 openSession 的统一拉取，避免重复请求。
					// 注意：不能拿 sessionGeneration 判断首连——重连时它不变，
					// 否则同一条流的重连会被永久跳过。
					onConnected: () => {
						if (sessionGenerationRef.current !== streamGeneration) return;
						if (firstOpen) {
							firstOpen = false;
							return;
						}
						void refreshCommands();
						void refreshExtensionUi();
						void refreshState();
					},
				},
			);
			streamRef.current = stream;
			return stream;
		},
		[pi, close, clearGrace, scheduleGrace, scheduleReconcile, refreshState, refreshCommands, refreshExtensionUi],
	);

	const command = useCallback(
		async (name: string, args = ""): Promise<PiSendResult> => {
			const clientId = clientIdRef.current;
			const sessionId = sessionIdRef.current;
			const cwdRef = cwdRefRef.current;
			if (!clientId || !sessionId || !cwdRef) {
				setState((s) => ({ ...s, error: "尚未打开会话" }));
				return "rejected";
			}
			// 运行中不得执行斜杠命令：复用现有 status 判定与宽限期语义。
			if (
				!isOwnerRef.current ||
				!(["idle", "done"] as PiSessionStatus[]).includes(
					stateRef.current.status,
				) ||
				graceTimerRef.current
			) {
				return "rejected";
			}
			const stream = streamRef.current;
			if (!stream) {
				setState((s) => ({ ...s, error: "事件流未就绪" }));
				return "rejected";
			}
			const sessionGeneration = sessionGenerationRef.current;
			await stream.connected();
			if (sessionGenerationRef.current !== sessionGeneration) return "rejected";

			promptGenerationRef.current += 1;
			const generation = promptGenerationRef.current;
			const submissionId = randomUUID();
			pendingSubmissionsRef.current.set(submissionId, generation);
			clearGrace();
			setState((s) => ({ ...s, status: "running", error: null }));

			try {
				const accepted = await pi.agent.executeCommand(
					clientId,
					sessionId,
					cwdRef,
					submissionId,
					name,
					args,
				);
				if (
					sessionGenerationRef.current === sessionGeneration &&
					promptGenerationRef.current === generation &&
					activeRunIdRef.current === null
				) {
					activeRunIdRef.current = accepted.runId;
					setState((s) => ({ ...s, runId: accepted.runId }));
				}
				return "accepted";
			} catch (err) {
				pendingSubmissionsRef.current.delete(submissionId);
				if (
					sessionGenerationRef.current === sessionGeneration &&
					promptGenerationRef.current === generation
				) {
					// 命令未获接纳：回到权威空闲，不得留下假 running。
					setState((s) => ({
						...s,
						status: "idle" as const,
						error: err instanceof Error ? err.message : String(err),
					}));
				}
				return "rejected";
			}
		},
		[pi, clearGrace],
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
			loadedMoreRef.current = false;
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
			const modelsPromise = pi
				.models(clientId, cwdRef)
				.catch((err: unknown) => {
					if (sessionGenerationRef.current !== sessionGeneration) return null;
					setState((s) => ({
						...s,
						error: err instanceof Error ? err.message : String(err),
					}));
					return null;
				});
			let openResult: PiSessionOpenResult;
			let modelsResult: Awaited<typeof modelsPromise> | null = null;
			let models: Awaited<typeof modelsPromise> | null = null;
			try {
				[openResult, , modelsResult] = await Promise.all([
					pi.agent.open(
						clientId,
						sessionId,
						cwdRef,
					) as Promise<PiSessionOpenResult>,
					reloadHistory(),
					modelsPromise,
				]);
			} catch (err) {
				// /open 失败（严格校验 400 等）：落入 error 展示，不让调用方抛出导致页面卡 loading
				if (sessionGenerationRef.current !== sessionGeneration) return;
				setState((s) => ({
					...s,
					status: "idle",
					error: err instanceof Error ? err.message : String(err),
				}));
				return;
			}
			models = modelsResult;
			if (sessionGenerationRef.current !== sessionGeneration) return;
			const { job, agentState } = openResult;
			activeRunIdRef.current = job.runId;
			isOwnerRef.current = job.isOwner;
			if (job.runId) retiredRunIdsRef.current.delete(job.runId);
			const pendingExtension = job.runId
				? (agentState.pendingExtension ?? null)
				: null;
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

			// 只在就绪且空闲时拉取扩展命令与 UI 快照：
			// 避免为 Observer 的每次重连都启动 Worker factory（ADR-0040 决策 4）。
			if (job.status === "idle" && !pendingExtension) {
				await Promise.all([refreshCommands(), refreshExtensionUi()]);
			}
		},
		[
			openStream,
			reloadHistory,
			refreshState,
			refreshCommands,
			refreshExtensionUi,
			pi,
		],
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
		async (input: { prompt: string; images?: PiAttachmentRef[] }): Promise<PiSendResult> => {
			const clientId = clientIdRef.current;
			const sessionId = sessionIdRef.current;
			const cwdRef = cwdRefRef.current;
			if (!clientId || !sessionId || !cwdRef) {
				setState((s) => ({ ...s, error: "尚未打开会话" }));
				return "rejected";
			}
			if (
				!isOwnerRef.current ||
				(rejectedSettlingRunIdRef.current !== null &&
					rejectedSettlingRunIdRef.current === activeRunIdRef.current) ||
				(!(["idle", "done"] as PiSessionStatus[]).includes(
					stateRef.current.status,
				) &&
					!graceTimerRef.current)
			)
				return "rejected";
			const stream = streamRef.current;
			if (!stream) {
				setState((s) => ({ ...s, error: "事件流未就绪" }));
				return "rejected";
			}
			const sessionGeneration = sessionGenerationRef.current;
			await stream.connected();
			if (sessionGenerationRef.current !== sessionGeneration) return "rejected";

			const settlingRunId = graceTimerRef.current
				? activeRunIdRef.current
				: null;
			promptGenerationRef.current += 1;
			const generation = promptGenerationRef.current;
			const submissionId = randomUUID();
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
						settlingRunId !== null && activeRunIdRef.current === settlingRunId;
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
										? {
												...s.job,
												status: "running" as const,
												runId: settlingRunId,
											}
										: s.job,
								}
								: { status: "idle" as const }),
						error: err instanceof Error ? err.message : String(err),
					}));
				}
				return "rejected";
			}
			return "accepted";
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

	const loadMore = useCallback(async () => {
		const clientId = clientIdRef.current;
		const sessionId = sessionIdRef.current;
		const cwdRef = cwdRefRef.current;
		const cursor = nextCursorRef.current;
		const generation = promptGenerationRef.current;
		const sessionGeneration = sessionGenerationRef.current;
		if (!clientId || !sessionId || !cwdRef || !cursor) return;
		try {
			const page = (await pi.sessions.context(clientId, sessionId, cwdRef, {
				cursor,
			})) as PiSessionContextPage;
			if (
				promptGenerationRef.current !== generation ||
				sessionGenerationRef.current !== sessionGeneration
			)
				return; // 旧 run/session 不覆盖
			loadedMoreRef.current = true;
			nextCursorRef.current = page.nextCursor ?? null;
			setState((s) => ({
				...s,
				messages: [...page.messages, ...s.messages],
				hasMore: page.nextCursor !== null,
				nextCursor: page.nextCursor ?? null,
			}));
		} catch {
			// 静默：可重试
		}
	}, [pi]);

	const actions = useMemo<PiSessionActions>(
		() => ({
			createSession,
			openSession,
			loadMore,
			send,
			command,
			refreshExtensionUi,
			dismissEditorRequest,
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
			setExecutionMode: async (mode) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (!clientId || !sessionId || !cwdRef || !isOwnerRef.current) return;
				if (stateRef.current.status !== "idle" && stateRef.current.status !== "done") return;
				const generation = sessionGenerationRef.current;
				try {
					const job = await pi.agent.setExecutionMode(clientId, sessionId, cwdRef, mode);
					if (sessionGenerationRef.current !== generation) return;
					setState((s) => ({ ...s, job, error: null }));
				} catch (err) {
					if (sessionGenerationRef.current === generation) setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
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
				if (
					!clientId ||
					!sessionId ||
					!cwdRef ||
					!stateRef.current.job?.isOwner
				)
					return;
				await pi.sessions.navigate(clientId, sessionId, cwdRef, targetId);
			},
			fork: async (messageId) => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (
					!clientId ||
					!sessionId ||
					!cwdRef ||
					!stateRef.current.job?.isOwner
				)
					return;
				await pi.sessions.fork(clientId, sessionId, cwdRef, messageId);
			},
			clone: async () => {
				const clientId = clientIdRef.current;
				const sessionId = sessionIdRef.current;
				const cwdRef = cwdRefRef.current;
				if (
					!clientId ||
					!sessionId ||
					!cwdRef ||
					!stateRef.current.job?.isOwner
				)
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
			reset,
		}),
		[
			createSession,
			openSession,
			loadMore,
			send,
			command,
			refreshExtensionUi,
			dismissEditorRequest,
			withRun,
			pi,
			clearGrace,
			close,
			refreshState,
			reset,
		],
	);

	return { state, actions };
}
