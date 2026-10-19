import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
	RemoteDevAttachmentMode,
	RemoteDevBrowserEvent,
	RemoteDevClientEvent,
	RemoteDevPortInfo,
	RemoteDevSessionInfo,
	RemoteDevTranscriptPayload,
} from "@vcpdeck/shared";
import { createAppSocket } from "../terminal/terminal-socket.js";

export interface RemoteDevAttachment {
	attachmentId: string;
	mode: RemoteDevAttachmentMode;
	reconnectToken: string;
	controlProtectedUntil?: string;
}

export interface RemoteDevStatePayload {
	session: RemoteDevSessionInfo;
	ports: RemoteDevPortInfo[];
	attachment?: RemoteDevAttachment;
}

export interface RemoteDevSocket {
	attach(
		sessionId: string,
		reconnectToken?: string,
	): Promise<RemoteDevAttachment>;
	detach(sessionId: string): Promise<void>;
	prompt(sessionId: string, text: string): Promise<void>;
	cancel(sessionId: string): Promise<void>;
	permission(
		sessionId: string,
		requestId: string,
		optionId?: string,
	): Promise<void>;
	openPort(
		sessionId: string,
		remotePort: number,
		label?: string,
	): Promise<RemoteDevPortInfo>;
	closePort(sessionId: string, portId: string): Promise<RemoteDevPortInfo>;
	resync(sessionId: string): Promise<void>;
	onState(cb: (payload: RemoteDevStatePayload) => void): () => void;
	onAgentEvent(cb: (event: RemoteDevClientEvent) => void): () => void;
	/** 附着成功后的历史回放。 */
	onTranscript(cb: (payload: RemoteDevTranscriptPayload) => void): () => void;
	onPortState(cb: (port: RemoteDevPortInfo) => void): () => void;
	onClosed(cb: (payload: { sessionId: string; reason?: string }) => void): () => void;
	onError(cb: (payload: { code: string; message: string }) => void): () => void;
	onConnectionChange(cb: (connected: boolean) => void): () => void;
	dispose(): void;
}

function socketError(result: {
	ok: false;
	error: { code: string; message: string };
}): Error {
	return Object.assign(new Error(result.error.message), {
		code: result.error.code,
	});
}

function request<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
	return new Promise((resolve, reject) => {
		socket.emit(
			event,
			payload,
			(
				result:
					| { ok: true; data?: T }
					| { ok: false; error: { code: string; message: string } },
			) => {
				if (result?.ok) resolve(result.data as T);
				else reject(socketError(result));
			},
		);
	});
}

/** `/app` RDS 门面；复用共享 socket，错误统一为带 code 的 Error。 */
export function createRemoteDevSocket(
	socket: Socket = createAppSocket(),
): RemoteDevSocket {
	const listeners: Array<() => void> = [];
	const subscribe = <T>(event: string, cb: (payload: T) => void) => {
		const handler = (payload: T) => cb(payload);
		socket.on(event, handler as never);
		const off = () => {
			if (typeof socket.off === "function") socket.off(event, handler as never);
		};
		listeners.push(off);
		return off;
	};
	return {
		attach: (sessionId, reconnectToken) =>
			request<RemoteDevAttachment>(socket, Events.RDS_ATTACH, {
				sessionId,
				...(reconnectToken ? { reconnectToken } : {}),
			}),
		detach: (sessionId) =>
			request<void>(socket, Events.RDS_DETACH, { sessionId }),
		prompt: (sessionId, text) =>
			request<void>(socket, Events.RDS_PROMPT, { sessionId, text }),
		cancel: (sessionId) =>
			request<void>(socket, Events.RDS_CANCEL, { sessionId }),
		permission: (sessionId, requestId, optionId) =>
			request<void>(socket, Events.RDS_PERMISSION, {
				sessionId,
				requestId,
				...(optionId ? { optionId } : {}),
			}),
		openPort: (sessionId, remotePort, label) =>
			request<RemoteDevPortInfo>(socket, Events.RDS_PORT_OPEN, {
				sessionId,
				remotePort,
				...(label ? { label } : {}),
			}),
		closePort: (sessionId, portId) =>
			request<RemoteDevPortInfo>(socket, Events.RDS_PORT_CLOSE, {
				sessionId,
				portId,
			}),
		resync: (sessionId) =>
			request<void>(socket, Events.RDS_RESYNC, { sessionId }),
		onState: (cb) => subscribe(Events.RDS_STATE, cb),
		onAgentEvent: (cb) => subscribe(Events.RDS_AGENT_EVENT, cb),
		onTranscript: (cb) => subscribe(Events.RDS_TRANSCRIPT, cb),
		onPortState: (cb) => subscribe(Events.RDS_PORT_STATE, cb),
		onClosed: (cb) => subscribe(Events.RDS_CLOSED, cb),
		onError: (cb) => subscribe(Events.RDS_ERROR, cb),
		onConnectionChange: (cb) => {
			const offConnect = subscribe<unknown>("connect", () => cb(true));
			const offDisconnect = subscribe<unknown>("disconnect", () => cb(false));
			return () => {
				offConnect();
				offDisconnect();
			};
		},
		dispose() {
			for (const off of listeners) off();
			listeners.length = 0;
		},
	};
}

export type { RemoteDevBrowserEvent };
