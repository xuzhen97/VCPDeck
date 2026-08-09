import { Injectable } from "@nestjs/common";
import type { PiRequest, PiResponse } from "@vcpdeck/shared";

export const PI_REQUEST_TIMEOUT_MS = 15_000;

interface PendingRequest {
	clientId: string;
	resolve: (response: PiResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * Pi 请求代理：把 REST 请求通过 Socket.IO 发到目标 Client，以 requestId 关联响应。
 * - 不记录 request payload 正文；
 * - Client 断线时失败所有 pending；
 * - 只接受来自原目标 Client 的响应（防伪造）。
 */
@Injectable()
export class PiRequestBroker {
	private emitter: ((clientId: string, request: PiRequest) => void) | null =
		null;
	private readonly pending = new Map<string, PendingRequest>();

	/** Gateway afterInit 时绑定 emitter（避免循环依赖） */
	bindEmitter(fn: (clientId: string, request: PiRequest) => void): void {
		this.emitter = fn;
	}

	request(
		clientId: string,
		request: PiRequest,
		timeoutMs: number = PI_REQUEST_TIMEOUT_MS,
	): Promise<PiResponse> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.requestId);
				reject(piError("PI_REQUEST_TIMEOUT", "Client did not respond in time"));
			}, timeoutMs);
			this.pending.set(request.requestId, { clientId, resolve, reject, timer });
			this.emitter?.(clientId, request);
		});
	}

	/** Client 响应：校验来源 clientId 后 resolve */
	resolve(clientId: string, response: PiResponse): void {
		const pending = this.pending.get(response.requestId);
		if (!pending) return; // 未知/重复响应忽略
		if (pending.clientId !== clientId) return; // 伪造响应拒绝
		clearTimeout(pending.timer);
		this.pending.delete(response.requestId);
		pending.resolve(response);
	}

	/** Client 断线：失败其全部 pending request */
	disconnect(clientId: string): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.clientId === clientId) {
				clearTimeout(pending.timer);
				this.pending.delete(requestId);
				pending.reject(
					piError("PI_CLIENT_DISCONNECTED", "Client disconnected"),
				);
			}
		}
	}
}
