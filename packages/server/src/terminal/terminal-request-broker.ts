import { Injectable } from "@nestjs/common";
import type { TerminalClientRequest, TerminalClientResponse } from "@vcpdeck/shared";

export const TERMINAL_REQUEST_TIMEOUT_MS = 15_000;

export interface TerminalLease {
	clientId: string;
	socketId: string;
}

interface PendingRequest extends TerminalLease {
	resolve: (response: TerminalClientResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function terminalError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * 终端请求代理：把 REST/浏览器请求通过 Socket.IO 发到目标 Client，以 requestId 关联响应。
 * - 不记录 request payload 正文；
 * - socket 断线时只失败该连接的 pending；
 * - 只接受来自原 lease socket 的响应（防串线）；
 * - 未绑定 emitter 视为 Client 离线。
 */
@Injectable()
export class TerminalRequestBroker {
	private emitter: ((socketId: string, request: TerminalClientRequest) => void) | null = null;
	private readonly pending = new Map<string, PendingRequest>();

	/** Gateway afterInit 时绑定 emitter（避免循环依赖）。 */
	bindEmitter(fn: (socketId: string, request: TerminalClientRequest) => void): void {
		this.emitter = fn;
	}

	request(
		lease: TerminalLease,
		request: TerminalClientRequest,
		timeoutMs: number = TERMINAL_REQUEST_TIMEOUT_MS,
	): Promise<TerminalClientResponse> {
		if (!this.emitter) {
			return Promise.reject(terminalError("TERMINAL_CLIENT_OFFLINE", "Client is offline"));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.requestId);
				reject(terminalError("TERMINAL_REQUEST_TIMEOUT", "Client did not respond in time"));
			}, timeoutMs);
			this.pending.set(request.requestId, { ...lease, resolve, reject, timer });
			this.emitter?.(lease.socketId, request);
		});
	}

	/** Client 响应：校验来源 socketId 后 resolve（响应正文校验由上层负责）。 */
	resolve(socketId: string, response: TerminalClientResponse): void {
		const pending = this.pending.get(response.requestId);
		if (!pending) return; // 未知/重复响应忽略
		if (pending.socketId !== socketId) return; // 旧连接或伪造响应拒绝
		clearTimeout(pending.timer);
		this.pending.delete(response.requestId);
		pending.resolve(response);
	}

	/** socket 断线：只失败该连接的 pending request。 */
	disconnect(socketId: string): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.socketId === socketId) {
				clearTimeout(pending.timer);
				this.pending.delete(requestId);
				pending.reject(terminalError("TERMINAL_CLIENT_OFFLINE", "Client disconnected"));
			}
		}
	}
}
