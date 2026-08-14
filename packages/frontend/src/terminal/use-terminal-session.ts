import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
	TerminalOutputChunk,
	TerminalSessionStatus,
	TerminalSnapshotMessage,
} from "@vcpdeck/shared";
import type { TerminalSocketEvents } from "./terminal-socket.js";

export type { TerminalSocketEvents } from "./terminal-socket.js";

/** 终端画面句柄（xterm 适配的最小面）。 */
export interface TerminalViewHandle {
	write(data: string, cb?: () => void): void;
	reset(): void;
}

export type SessionPhase =
	| "idle"
	| "attaching"
	| "syncing"
	| "live"
	| "reconnecting"
	| "ended"
	| "error";

export interface TerminalSessionState {
	phase: SessionPhase;
	mode: "operator" | "viewer";
	operatorName: string | null;
	controlProtectedUntil: string | null;
	canTakeover: boolean;
	lastSeq: number;
	historyTruncated: boolean;
	status: TerminalSessionStatus | null;
	error: { code: string; message: string } | null;
}

type Action =
	| { type: "attaching" }
	| { type: "attached"; mode: "operator" | "viewer" }
	| { type: "syncing" }
	| { type: "live" }
	| { type: "reconnecting" }
	| {
			type: "control";
			control: {
				mode: "operator" | "viewer";
				operatorName: string | null;
				controlProtectedUntil: string | null;
				canTakeover: boolean;
			};
	  }
	| { type: "output"; seq: number }
	| { type: "resync-required" }
	| { type: "ended"; status: TerminalSessionStatus; reason?: string }
	| { type: "error"; code: string; message: string };

function reducer(
	state: TerminalSessionState,
	action: Action,
): TerminalSessionState {
	switch (action.type) {
		case "attaching":
			return { ...state, phase: "attaching", error: null };
		case "reconnecting":
			return { ...state, phase: "reconnecting" };
		case "attached":
			return { ...state, phase: "syncing", mode: action.mode };
		case "syncing":
			return { ...state, phase: "syncing" };
		case "live":
			return { ...state, phase: "live" };
		case "control":
			return {
				...state,
				mode: action.control.mode,
				operatorName: action.control.operatorName,
				controlProtectedUntil: action.control.controlProtectedUntil,
				canTakeover: action.control.canTakeover,
			};
		case "output":
			return { ...state, lastSeq: Math.max(state.lastSeq, action.seq) };
		case "resync-required":
			return { ...state, phase: "syncing" };
		case "ended":
			return { ...state, phase: "ended", status: action.status };
		case "error":
			return {
				...state,
				phase: "error",
				error: { code: action.code, message: action.message },
			};
	}
}

const TOKEN_KEY_PREFIX = "vcpdeck:term:";

export interface TerminalStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface UseTerminalSessionOptions {
	socket: TerminalSocketEvents;
	clientId: string;
	sessionId: string;
	view: TerminalViewHandle;
	storage?: TerminalStorage;
	/** 本 attachment 获得操作权时回调（接管/重连恢复后触发，用于 fit + 下发尺寸）。 */
	onGainedControl?: () => void;
}

/**
 * 单终端会话 hook：attach/重连 token、snapshot + delta 恢复、seq 去重/gap resync、
 * 单写多读状态、接管与清理。卸载只 detach，不关闭远端会话。
 */
export function useTerminalSession(options: UseTerminalSessionOptions) {
	const { socket, clientId, sessionId, view } = options;
	const storage = options.storage ?? window.sessionStorage;
	const onGainedControlRef = useRef(options.onGainedControl);
	onGainedControlRef.current = options.onGainedControl;
	const [state, dispatch] = useReducer(reducer, {
		phase: "idle",
		mode: "viewer",
		operatorName: null,
		controlProtectedUntil: null,
		canTakeover: false,
		lastSeq: 0,
		historyTruncated: false,
		status: null,
		error: null,
	});
	const attachmentIdRef = useRef<string | null>(null);
	const pendingRef = useRef<TerminalOutputChunk[]>([]);
	const lastSeqRef = useRef(0);
	// 快照串行化：xterm write 是异步缓冲的，连续快照时后一个 reset 清不掉前一个已排队的写入，会内容叠加
	const snapshotBusyRef = useRef(false);
	const latestSnapshotRef = useRef<TerminalSnapshotMessage | null>(null);
	// attach 挂载代次：StrictMode 双挂载/快速卸载后，过期 attach 的响应必须丢弃
	const attachGenerationRef = useRef(0);
	// 组件是否仍挂载（区分 StrictMode 双挂载 vs 页面卸载）
	const mountedRef = useRef(true);
	const tokenKey = `${TOKEN_KEY_PREFIX}${clientId}:${sessionId}`;

	const attach = useCallback(
		async (generation: number) => {
			dispatch({ type: "attaching" });
			const token = storage.getItem(tokenKey);
			try {
				const attached = await socket.attach(sessionId, token);
				if (attachGenerationRef.current !== generation) {
					// StrictMode 双挂载：同 socket 的新 attach 会 supersede 旧 attachment，无需 detach——
					// 若 detach 先到会释放 operator 并设 30s 保护期，把新 attach 挡成 viewer（随机只读）
					// 仅页面已卸载时才 detach（防幽灵 operator）
					if (!mountedRef.current) {
						void socket.detach(sessionId, attached.attachmentId);
					}
					return;
				}
				attachmentIdRef.current = attached.attachmentId;
				storage.setItem(tokenKey, attached.reconnectToken);
				dispatch({ type: "attached", mode: attached.mode });
			} catch (error) {
				if (attachGenerationRef.current !== generation) return;
				const code = (error as { code?: unknown }).code;
				dispatch({
					type: "error",
					code: typeof code === "string" ? code : "TERMINAL_SESSION_NOT_FOUND",
					message: (error as { message?: string }).message ?? "终端连接失败",
				});
			}
		},
		[socket, sessionId, tokenKey, storage],
	);

	useEffect(() => {
		const generation = ++attachGenerationRef.current;
		mountedRef.current = true;
		// socket 未就绪（页面加载早期/重连中）时 emit 的包可能丢失，ack 永不回 → attachmentId 永远为空 → 输入静默失效
		if (socket.isConnected()) {
			void attach(generation);
		} else {
			const off = socket.onConnectionChange((connected) => {
				if (!connected) return;
				off();
				void attach(generation);
			});
		}
		return () => {
			mountedRef.current = false;
			attachGenerationRef.current++;
		};
	}, [attach, socket]);

	// ── 入站事件（共享 socket：所有事件必须先按 sessionId 过滤，否则多会话互相串扰） ──
	useEffect(() => {
		// 快照串行应用：xterm write 异步缓冲，连续快照会让后一个 reset 清不掉前一个排队写入（内容叠加）
		const applySnapshot = (m: TerminalSnapshotMessage): void => {
			snapshotBusyRef.current = true;
			// 冲刷缓冲：seq > snapshotSeq 的增量按序写出
			const buffered = pendingRef.current;
			pendingRef.current = [];
			view.reset();
			view.write(m.snapshot, () => {
				let base = m.snapshotSeq;
				for (const chunk of buffered) {
					if (chunk.seq <= base) continue;
					if (chunk.seq > base + 1) {
						void socket.resync(sessionId, attachmentIdRef.current ?? "");
						dispatch({ type: "resync-required" });
						break;
					}
					base = chunk.seq;
					lastSeqRef.current = chunk.seq;
					view.write(chunk.data);
				}
				lastSeqRef.current = Math.max(lastSeqRef.current, m.snapshotSeq);
				dispatch({ type: "output", seq: lastSeqRef.current });
				dispatch({ type: "live" });
				snapshotBusyRef.current = false;
				// 处理期间到达的新快照：只应用最新的（快照是全量，中间版本可丢）
				const next = latestSnapshotRef.current;
				latestSnapshotRef.current = null;
				if (next) applySnapshot(next);
			});
		};
		socket.onSnapshot((m) => {
			if (m.sessionId !== sessionId) return;
			if (snapshotBusyRef.current) {
				latestSnapshotRef.current = m;
				return;
			}
			applySnapshot(m);
		});
		socket.onOutput((chunk) => {
			if (chunk.sessionId !== sessionId) return;
			// syncing 期间只缓冲（snapshot 到达后按 seq 仲裁）；live 期间去重与 gap 检测
			if (phaseRef.current === "syncing") {
				pendingRef.current.push(chunk);
				lastSeqRef.current = Math.max(lastSeqRef.current, chunk.seq);
				dispatch({ type: "output", seq: chunk.seq });
				return;
			}
			if (chunk.seq <= lastSeqRef.current) return;
			if (chunk.seq > lastSeqRef.current + 1) {
				void socket.resync(sessionId, attachmentIdRef.current ?? "");
				dispatch({ type: "resync-required" });
				return;
			}
			lastSeqRef.current = chunk.seq;
			dispatch({ type: "output", seq: chunk.seq });
			view.write(chunk.data);
		});
		socket.onControl((control) => {
			if (control.sessionId !== sessionId) return;
			const prevMode = phaseRef.current;
			void prevMode;
			const wasOperator = stateRef.current.mode === "operator";
			dispatch({ type: "control", control });
			// 新获得操作权：触发 fit + 权威尺寸下发（设计 10.4）
			if (control.mode === "operator" && !wasOperator) {
				onGainedControlRef.current?.();
			}
		});
		socket.onSessionState((m) => {
			if (m.sessionId !== sessionId) return;
			dispatch({ type: "ended", status: m.status, reason: m.reason });
			storage.removeItem(tokenKey);
		});
		socket.onResyncRequired((m) => {
			if (m.sessionId !== sessionId) return;
			dispatch({ type: "resync-required" });
			void socket.resync(sessionId, attachmentIdRef.current ?? "");
		});
		socket.onError((e) => {
			if (e.sessionId !== sessionId) return;
			dispatch({ type: "error", code: e.code, message: e.message });
		});
		// 断线：展示恢复中；重连：自动重新 attach（token 恢复操作权）
		socket.onConnectionChange((connected) => {
			if (!connected) {
				dispatch({ type: "reconnecting" });
			} else if (phaseRef.current !== "idle" && phaseRef.current !== "ended") {
				void attach(attachGenerationRef.current);
			}
		});
		return () => {
			if (attachmentIdRef.current) {
				void socket.detach(sessionId, attachmentIdRef.current);
				attachmentIdRef.current = null;
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [socket, sessionId, view, storage, tokenKey]);

	// 供事件回调读取最新 state（避免闭包过期）
	const stateRef = useRef(state);
	stateRef.current = state;
	const phaseRef = useRef(state.phase);
	phaseRef.current = state.phase;

	const handleInput = useCallback(
		(data: string) => {
			if (stateRef.current.mode !== "operator") return;
			const attachmentId = attachmentIdRef.current;
			if (!attachmentId) return;
			void socket.input(sessionId, attachmentId, data);
		},
		[socket, sessionId],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (stateRef.current.mode !== "operator") return;
			const attachmentId = attachmentIdRef.current;
			if (!attachmentId) return;
			void socket.resize(sessionId, attachmentId, cols, rows);
		},
		[socket, sessionId],
	);

	const handleTakeover = useCallback(() => {
		if (!stateRef.current.canTakeover) return;
		const attachmentId = attachmentIdRef.current;
		if (!attachmentId) return;
		void socket.takeover(sessionId, attachmentId);
	}, [socket, sessionId]);

	const handleAckOutput = useCallback(
		(seq: number) => {
			const attachmentId = attachmentIdRef.current;
			if (!attachmentId) return;
			void socket.ackOutput(sessionId, attachmentId, seq);
		},
		[socket, sessionId],
	);

	return {
		state,
		handleInput,
		handleResize,
		handleTakeover,
		handleAckOutput,
		attachmentId: attachmentIdRef.current,
	};
}
