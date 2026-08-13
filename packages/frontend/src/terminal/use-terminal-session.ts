import { useCallback, useEffect, useReducer, useRef } from "react";
import type { TerminalOutputChunk, TerminalSessionStatus } from "@vcpdeck/shared";
import type { TerminalSocketEvents } from "./terminal-socket.js";

export type { TerminalSocketEvents } from "./terminal-socket.js";

/** 终端画面句柄（xterm 适配的最小面）。 */
export interface TerminalViewHandle {
	write(data: string): void;
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
	| { type: "control"; control: { mode: "operator" | "viewer"; operatorName: string | null; controlProtectedUntil: string | null; canTakeover: boolean } }
	| { type: "output"; seq: number }
	| { type: "resync-required" }
	| { type: "ended"; status: TerminalSessionStatus; reason?: string }
	| { type: "error"; code: string; message: string };

function reducer(state: TerminalSessionState, action: Action): TerminalSessionState {
	switch (action.type) {
		case "attaching":
			return { ...state, phase: "attaching", error: null };
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
			return { ...state, phase: "error", error: { code: action.code, message: action.message } };
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
}

/**
 * 单终端会话 hook：attach/重连 token、snapshot + delta 恢复、seq 去重/gap resync、
 * 单写多读状态、接管与清理。卸载只 detach，不关闭远端会话。
 */
export function useTerminalSession(options: UseTerminalSessionOptions) {
	const { socket, clientId, sessionId, view } = options;
	const storage = options.storage ?? window.sessionStorage;
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
	const tokenKey = `${TOKEN_KEY_PREFIX}${clientId}:${sessionId}`;

	const attach = useCallback(async () => {
		dispatch({ type: "attaching" });
		const token = storage.getItem(tokenKey);
		try {
			const attached = await socket.attach(sessionId, token);
			attachmentIdRef.current = attached.attachmentId;
			storage.setItem(tokenKey, attached.reconnectToken);
			dispatch({ type: "attached", mode: attached.mode });
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			dispatch({
				type: "error",
				code: typeof code === "string" ? code : "TERMINAL_SESSION_NOT_FOUND",
				message: (error as { message?: string }).message ?? "终端连接失败",
			});
		}
	}, [socket, sessionId, tokenKey, storage]);

	useEffect(() => {
		void attach();
	}, [attach]);

	// ── 入站事件 ──
	useEffect(() => {
		socket.onSnapshot((m) => {
			// 冲刷缓冲：seq > snapshotSeq 的增量按序写出
			const buffered = pendingRef.current;
			pendingRef.current = [];
			view.reset();
			view.write(m.snapshot);
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
		});
		socket.onOutput((chunk) => {
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
			dispatch({ type: "control", control });
		});
		socket.onSessionState((m) => {
			dispatch({ type: "ended", status: m.status, reason: m.reason });
			storage.removeItem(tokenKey);
		});
		socket.onResyncRequired(() => {
			dispatch({ type: "resync-required" });
			void socket.resync(sessionId, attachmentIdRef.current ?? "");
		});
		socket.onError((e) => {
			dispatch({ type: "error", code: e.code, message: e.message });
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
