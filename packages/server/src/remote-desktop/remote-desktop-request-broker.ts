import { Injectable } from "@nestjs/common";
import type {
	RemoteDesktopClientRequest,
	RemoteDesktopClientResponse,
} from "@vcpdeck/shared";

export const REMOTE_DESKTOP_REQUEST_TIMEOUT_MS = 15_000;

export interface RemoteDesktopClientLease {
	clientId: string;
	socketId: string;
}

interface PendingRequest extends RemoteDesktopClientLease {
	resolve: (response: RemoteDesktopClientResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function remoteDesktopError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * Remote Desktop 控制面请求代理：只把请求投递到指定 Client socket，
 * 并拒绝旧 socket、重复响应和超时响应。不会记录信令、输入或剪贴板正文。
 */
@Injectable()
export class RemoteDesktopRequestBroker {
	private emitter:
		| ((socketId: string, request: RemoteDesktopClientRequest) => void)
		| null = null;
	private readonly pending = new Map<string, PendingRequest>();

	/** ClientGateway afterInit 时绑定精确 socket emitter。 */
	bindEmitter(
		fn: (socketId: string, request: RemoteDesktopClientRequest) => void,
	): void {
		this.emitter = fn;
	}

	request(
		lease: RemoteDesktopClientLease,
		request: RemoteDesktopClientRequest,
		timeoutMs = REMOTE_DESKTOP_REQUEST_TIMEOUT_MS,
	): Promise<RemoteDesktopClientResponse> {
		if (!this.emitter) {
			return Promise.reject(
				remoteDesktopError("REMOTE_DESKTOP_HOST_OFFLINE", "Desktop Host is offline"),
			);
		}
		if (this.pending.has(request.requestId)) {
			return Promise.reject(
				remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", "Duplicate request id"),
			);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.requestId);
				reject(
					remoteDesktopError(
						"REMOTE_DESKTOP_HOST_OFFLINE",
						"Desktop Host did not respond in time",
					),
				);
			}, timeoutMs);
			this.pending.set(request.requestId, { ...lease, resolve, reject, timer });
			this.emitter?.(lease.socketId, request);
		});
	}

	/** 只接受原始 lease socket 的响应；payload 形状由 Gateway parser 校验。 */
	resolve(socketId: string, response: RemoteDesktopClientResponse): void {
		const pending = this.pending.get(response.requestId);
		if (!pending || pending.socketId !== socketId) return;
		clearTimeout(pending.timer);
		this.pending.delete(response.requestId);
		pending.resolve(response);
	}

	/** Client socket 断开时，仅拒绝该 socket 的 pending 请求。 */
	disconnect(socketId: string): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.socketId !== socketId) continue;
			clearTimeout(pending.timer);
			this.pending.delete(requestId);
			pending.reject(
				remoteDesktopError("REMOTE_DESKTOP_HOST_OFFLINE", "Desktop Host disconnected"),
			);
		}
	}
}
