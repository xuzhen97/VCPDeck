/**
 * Tailnet 密钥交付桥（ADR-0062）。
 *
 * Server 只能在当前已派发 job 的允许集合内请求密钥；requestId 单次有效，
 * 断连清空待处理请求与允许集合，重连不自动恢复。
 */
import { randomUUID } from "node:crypto";
import {
	assertTailnetSecretUsable,
	Events,
	parseTailnetSecretResponse,
	TAILNET_PROTOCOL_VERSION,
	type TailnetErrorCode,
	type TailnetSecretRequest,
} from "@vcpdeck/shared";

/** 默认密钥请求 TTL。 */
const DEFAULT_TTL_MS = 30_000;

/** 最小 Socket 面；真实 Socket.IO Socket 满足。 */
export interface TailnetSecretSocket {
	on(event: string, handler: (payload: unknown) => void): void;
	emit(event: string, payload: unknown): void;
}

/** 构造选项。 */
export interface TailnetSocketBridgeOptions {
	ttlMs?: number;
}

interface PendingRequest {
	jobId: string;
	requestId: string;
	timer: ReturnType<typeof setTimeout> | undefined;
	detachAbort: () => void;
	resolve: (authKey: string) => void;
	reject: (error: Error) => void;
}

function secretError(code: TailnetErrorCode, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * 管理单次密钥请求的请求/响应生命周期。
 */
export class TailnetSocketBridge {
	private readonly socket: TailnetSecretSocket;
	private readonly ttlMs: number;
	private registered = false;
	private readonly allowedJobs = new Set<string>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly consumed = new Set<string>();

	constructor(
		socket: TailnetSecretSocket,
		options: TailnetSocketBridgeOptions = {},
	) {
		this.socket = socket;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.socket.on(Events.TAILNET_SECRET_RESPONSE, (payload) => {
			this.handleResponse(payload);
		});
	}

	/** Server 完成注册确认后才允许请求密钥。 */
	onRegistered(): void {
		this.registered = true;
	}

	/** 断连：拒绝在途请求，清空允许集合。 */
	onDisconnected(): void {
		this.registered = false;
		this.allowedJobs.clear();
		for (const requestId of [...this.pending.keys()]) {
			this.fail(requestId, "TAILNET_SECRET_DENIED", "连接已断开");
		}
		this.consumed.clear();
	}

	/** handler 在真正执行 Job 前允许该 jobId 请求一次密钥。 */
	allowJob(jobId: string): void {
		this.allowedJobs.add(jobId);
	}

	/** handler 在 finally 中撤销允许。 */
	forgetJob(jobId: string): void {
		this.allowedJobs.delete(jobId);
	}

	/**
	 * 请求一次性密钥；未注册、未允许、重复在途或已取消都不发报文。
	 */
	request(jobId: string, signal: AbortSignal): Promise<string> {
		if (!this.registered || !this.allowedJobs.has(jobId)) {
			return Promise.reject(
				secretError("TAILNET_SECRET_DENIED", "未允许请求该任务的密钥"),
			);
		}
		if (signal.aborted) {
			return Promise.reject(
				secretError("TAILNET_SECRET_DENIED", "请求已取消"),
			);
		}
		for (const pending of this.pending.values()) {
			if (pending.jobId === jobId) {
				return Promise.reject(
					secretError("TAILNET_SECRET_DENIED", "该任务已有在途密钥请求"),
				);
			}
		}

		const request: TailnetSecretRequest = {
			protocolVersion: TAILNET_PROTOCOL_VERSION,
			jobId,
			requestId: randomUUID(),
		};
		return new Promise<string>((resolve, reject) => {
			const pending: PendingRequest = {
				jobId,
				requestId: request.requestId,
				timer: undefined,
				detachAbort: () => undefined,
				resolve,
				reject,
			};
			this.pending.set(request.requestId, pending);

			const onAbort = () => {
				this.fail(request.requestId, "TAILNET_SECRET_DENIED", "请求已取消");
			};
			signal.addEventListener("abort", onAbort, { once: true });
			pending.detachAbort = () => {
				signal.removeEventListener("abort", onAbort);
			};
			pending.timer = setTimeout(() => {
				this.fail(
					request.requestId,
					"TAILNET_SECRET_TIMEOUT",
					"等待密钥响应超时",
				);
			}, this.ttlMs);

			this.socket.emit(Events.TAILNET_SECRET_REQUEST, request);
		});
	}

	private handleResponse(payload: unknown): void {
		let parsed;
		try {
			parsed = parseTailnetSecretResponse(payload);
		} catch {
			// 畸形报文静默丢弃，等待超时；不回显原报文。
			return;
		}
		if (this.consumed.has(parsed.requestId)) {
			return;
		}
		const pending = this.pending.get(parsed.requestId);
		if (!pending || pending.jobId !== parsed.jobId) {
			return;
		}
		try {
			assertTailnetSecretUsable(parsed, {
				jobId: pending.jobId,
				requestId: pending.requestId,
			});
		} catch (error) {
			const code =
				(error as { code?: TailnetErrorCode }).code ??
				"TAILNET_SECRET_EXPIRED";
			this.fail(
				pending.requestId,
				code,
				(error as Error).message || "密钥不可用",
			);
			return;
		}
		this.consumed.add(parsed.requestId);
		this.pending.delete(pending.requestId);
		if (pending.timer) {
			clearTimeout(pending.timer);
		}
		pending.detachAbort();
		pending.resolve(parsed.authKey);
	}

	private fail(
		requestId: string,
		code: TailnetErrorCode,
		message: string,
	): void {
		const pending = this.pending.get(requestId);
		if (!pending) {
			return;
		}
		if (pending.timer) {
			clearTimeout(pending.timer);
		}
		pending.detachAbort();
		this.pending.delete(requestId);
		pending.reject(secretError(code, message));
	}
}
