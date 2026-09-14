import { io, type Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	RemoteDesktopBrowserAttached,
	RemoteDesktopSignal,
	RemoteDesktopAck,
} from "@vcpdeck/shared";
import {
	parseRemoteDesktopBrowserAttached,
	parseRemoteDesktopSignal,
} from "@vcpdeck/shared";

export interface RemoteDesktopSocket {
	attach(
		sessionId: string,
		reconnectToken?: string | null,
	): Promise<RemoteDesktopBrowserAttached>;
	detach(sessionId: string, attachmentId: string): Promise<void>;
	takeover(sessionId: string, attachmentId: string): Promise<{ role: "operator" }>;
	signal(
		sessionId: string,
		attachmentId: string,
		signal: RemoteDesktopSignal,
	): Promise<void>;
		onSignal(
			cb: (message: { sessionId: string; attachmentId: string; signal: RemoteDesktopSignal }) => void,
		): () => void;
	onConnectionChange(cb: (connected: boolean) => void): () => void;
	isConnected(): boolean;
	dispose(): void;
}

let appSocket: Socket | null = null;

/** 复用已认证的 `/app` Socket.IO 连接。 */
export function createRemoteDesktopAppSocket(): Socket {
	if (!appSocket) appSocket = io("/app", { withCredentials: true });
	return appSocket;
}

function protocolError(message: string, code = "REMOTE_DESKTOP_PROTOCOL_MISMATCH"): Error {
	return Object.assign(new Error(message), { code });
}

function requestWithAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
	return new Promise((resolve, reject) => {
		socket.emit(
			event,
			payload,
			(result: RemoteDesktopAck<T>) => {
				if (result?.ok) resolve(result.data);
				else reject(protocolError(result?.error?.message ?? "Remote Desktop request failed", result?.error?.code));
			},
		);
	});
}

/** Browser 远程桌面控制面门面；只处理 attach、信令和连接生命周期。 */
export function createRemoteDesktopSocket(socket: Socket): RemoteDesktopSocket {
	const cleanup: Array<() => void> = [];
	const on = <T>(event: string, cb: (value: T) => void) => {
		const handler = (value: T) => cb(value);
		socket.on(event, handler as never);
		const off = () => socket.off(event, handler as never);
		cleanup.push(off);
		return off;
	};

	return {
		attach: (sessionId, reconnectToken) =>
			requestWithAck<RemoteDesktopBrowserAttached>(socket, Events.REMOTE_DESKTOP_ATTACH, {
				sessionId,
				...(reconnectToken ? { reconnectToken } : {}),
			}).then(parseRemoteDesktopBrowserAttached),
		detach: (sessionId, attachmentId) =>
			requestWithAck<void>(socket, Events.REMOTE_DESKTOP_DETACH, { sessionId, attachmentId }).then(() => undefined),
		takeover: (sessionId, attachmentId) =>
			requestWithAck<{ role: "operator" }>(socket, Events.REMOTE_DESKTOP_TAKEOVER, { sessionId, attachmentId }),
		signal: (sessionId, attachmentId, signal) =>
			requestWithAck<void>(socket, Events.REMOTE_DESKTOP_SIGNAL, { sessionId, attachmentId, signal }).then(() => undefined),
		onSignal: (cb) =>
			on<{ sessionId: string; attachmentId: string; signal: unknown }>(
				Events.REMOTE_DESKTOP_SIGNAL,
				(message) => {
					try {
						cb({ ...message, signal: parseRemoteDesktopSignal(message.signal) });
					} catch (error) {
						// 严格协议：非法 Host 信令不能进入 WebRTC 状态机。
						// 但不能静默：否则“answer 永远不来”完全不可观测。
						console.error(
							`[vcpdeck] 远程桌面 Host 信令非法，已丢弃：${(error as Error).message}`,
						);
					}
				},
			),
		onConnectionChange: (cb) => {
			const offConnect = on("connect", () => cb(true));
			const offDisconnect = on("disconnect", () => cb(false));
			return () => {
				offConnect();
				offDisconnect();
			};
		},
		isConnected: () => socket.connected,
		dispose: () => {
			for (const off of cleanup) off();
			cleanup.length = 0;
		},
	};
}
