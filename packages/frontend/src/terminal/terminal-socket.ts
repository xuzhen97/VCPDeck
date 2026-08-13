import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	TerminalBrowserAttached,
	TerminalControlState,
	TerminalErrorMessage,
	TerminalOutputChunk,
	TerminalSessionStateMessage,
	TerminalSnapshotMessage,
} from "@vcpdeck/shared";
import { parseTerminalBrowserAttached } from "@vcpdeck/shared";

/** 终端 Socket 门面：类型化收发，错误统一为 TerminalError。 */
export interface TerminalSocketEvents {
	/** attach（可选重连 token）；失败 reject 稳定错误。 */
	attach(sessionId: string, reconnectToken?: string | null): Promise<TerminalBrowserAttached>;
	detach(sessionId: string, attachmentId: string): Promise<void>;
	input(sessionId: string, attachmentId: string, data: string): Promise<void>;
	resize(sessionId: string, attachmentId: string, cols: number, rows: number): Promise<void>;
	takeover(sessionId: string, attachmentId: string): Promise<{ mode: "operator" | "viewer" }>;
	ackOutput(sessionId: string, attachmentId: string, seq: number): Promise<void>;
	resync(sessionId: string, attachmentId: string): Promise<void>;
	onSnapshot(cb: (m: TerminalSnapshotMessage) => void): void;
	onOutput(cb: (c: TerminalOutputChunk) => void): void;
	onControl(cb: (c: TerminalControlState) => void): void;
	onSessionState(cb: (m: TerminalSessionStateMessage) => void): void;
	onResyncRequired(cb: () => void): void;
	onError(cb: (e: TerminalErrorMessage) => void): void;
	/** 连接状态变化（断线/重连），用于状态展示与自动重新 attach。 */
	onConnectionChange(cb: (connected: boolean) => void): void;
	dispose(): void;
}

function terminalError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

let appSocket: Socket | null = null;

/** 共享 `/app` socket（Cookie 认证；单例，复用连接）。 */
export function createAppSocket(): Socket {
	if (!appSocket) {
		appSocket = io("/app", { withCredentials: true });
	}
	return appSocket;
}

/** 包装共享 `/app` socket，提供类型化终端事件。 */
export function createTerminalSocket(socket: Socket): TerminalSocketEvents {
	const listeners: Array<() => void> = [];
	const subscribe = <T,>(event: string, cb: (payload: T) => void): void => {
		const handler = (raw: T) => cb(raw);
		socket.on(event, handler as never);
		listeners.push(() => {
			if (typeof socket.off === "function") socket.off(event, handler as never);
		});
	};

	/** 请求 + ack 判别联合。 */
	function requestWithAck<T>(event: string, payload: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			socket.emit(event, payload, (result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }) => {
				if (result?.ok) {
					resolve(result.data);
				} else {
					reject(
						terminalError(
							result?.error?.code ?? "TERMINAL_PROTOCOL_INVALID",
							result?.error?.message ?? "Terminal request failed",
						),
					);
				}
			});
		});
	}

	subscribe<unknown>(Events.TERMINAL_ATTACHED, () => {
		/* attached 由 ack 返回；此处保留扩展点 */
	});

	return {
		attach: (sessionId, reconnectToken) =>
			requestWithAck<TerminalBrowserAttached>(Events.TERMINAL_ATTACH, {
				sessionId,
				...(reconnectToken ? { reconnectToken } : {}),
			}).then((attached) => parseTerminalBrowserAttached(attached)),
		detach: (sessionId, attachmentId) =>
			requestWithAck<void>(Events.TERMINAL_DETACH, { sessionId, attachmentId }).then(() => undefined),
		input: (sessionId, attachmentId, data) =>
			requestWithAck<void>(Events.TERMINAL_INPUT, { sessionId, attachmentId, data }).then(() => undefined),
		resize: (sessionId, attachmentId, cols, rows) =>
			requestWithAck<void>(Events.TERMINAL_RESIZE, { sessionId, attachmentId, cols, rows }).then(() => undefined),
		takeover: (sessionId, attachmentId) =>
			requestWithAck<{ mode: "operator" | "viewer" }>(Events.TERMINAL_TAKEOVER, { sessionId, attachmentId }),
		ackOutput: (sessionId, attachmentId, seq) =>
			requestWithAck<void>(Events.TERMINAL_ACK_OUTPUT, { sessionId, attachmentId, seq }).then(() => undefined),
		resync: (sessionId, attachmentId) =>
			requestWithAck<void>(Events.TERMINAL_RESYNC, { sessionId, attachmentId }).then(() => undefined),
		onSnapshot: (cb) => subscribe<TerminalSnapshotMessage>(Events.TERMINAL_SNAPSHOT, cb),
		onOutput: (cb) => subscribe<TerminalOutputChunk>(Events.TERMINAL_OUTPUT, cb),
		onControl: (cb) => subscribe<TerminalControlState>(Events.TERMINAL_CONTROL, cb),
		onSessionState: (cb) => subscribe<TerminalSessionStateMessage>(Events.TERMINAL_SESSION_STATE, cb),
		onResyncRequired: (cb) => subscribe<unknown>(Events.TERMINAL_RESYNC_REQUIRED, () => cb()),
		onError: (cb) => subscribe<TerminalErrorMessage>(Events.TERMINAL_ERROR, cb),
		onConnectionChange: (cb) => {
			subscribe<unknown>("connect", () => cb(true));
			subscribe<unknown>("disconnect", () => cb(false));
		},
		dispose: () => {
			for (const off of listeners) off();
			listeners.length = 0;
		},
	};
}
