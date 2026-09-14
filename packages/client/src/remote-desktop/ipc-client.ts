import { connect as connectSocket } from "node:net";
import {
	RemoteDesktopLimits,
	parseRemoteDesktopClientResponse,
	parseRemoteDesktopStateReport,
	type RemoteDesktopClientRequest,
	type RemoteDesktopClientResponse,
	type RemoteDesktopStateReport,
} from "@vcpdeck/shared";

export interface DesktopHostIpcFrame {
	protocolVersion: 1;
	generationId: string;
	kind: "request" | "response" | "state";
	payload: unknown;
}

export interface DesktopHostIpcEndpoint {
	connect(): DesktopHostIpcTransport;
}

export interface DesktopHostIpcSocket {
	on(event: "data" | "error" | "close", listener: (...args: unknown[]) => void): DesktopHostIpcSocket;
	off(event: "data" | "error" | "close", listener: (...args: unknown[]) => void): DesktopHostIpcSocket;
	write(data: Uint8Array): boolean;
	destroy(): void;
}

export interface DesktopHostIpcTransport {
	write(frame: Uint8Array): void;
	onData(listener: (chunk: Uint8Array) => void): () => void;
	onError?(listener: (error: Error) => void): () => void;
	onClose?(listener: () => void): () => void;
	close?(): void;
}

export interface DesktopHostIpcClientOptions {
	transport: DesktopHostIpcTransport;
	generationId: string;
	timeoutMs?: number;
	expectedHostGeneration?: string;
}

const HEADER_BYTES = 4;
const VERSION = 1 as const;

export interface DesktopHostIpcTransportOptions {
	endpoint: string;
	connect?: (endpoint: string) => DesktopHostIpcSocket;
}

export interface DefaultDesktopHostIpcClientOptions {
	generationId?: string;
	endpoint?: string;
	connect?: (endpoint: string) => DesktopHostIpcSocket;
}

/** 返回受 Supervisor 管理的 Desktop Host 本机端点；不提供网络回退。 */
export function defaultDesktopHostIpcEndpoint(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (env.VCPDECK_DESKTOP_HOST_ENDPOINT) return env.VCPDECK_DESKTOP_HOST_ENDPOINT;
	if (platform === "win32") return "\\\\.\\pipe\\vcpdeck-desktop-host";
	if (platform === "linux") return "/run/vcpdeck/desktop-host.sock";
	return null;
}

/** 创建默认 Desktop Host IPC Client；未知平台没有网络或 stdin/stdout 回退。 */
export function createDefaultDesktopHostIpcClient(
	options: DefaultDesktopHostIpcClientOptions = {},
): DesktopHostIpcClient {
	const endpoint = options.endpoint ?? defaultDesktopHostIpcEndpoint();
	if (!endpoint) throw new Error("REMOTE_DESKTOP_UNSUPPORTED");
	return new DesktopHostIpcClient({
		transport: createDesktopHostIpcTransport({ endpoint, connect: options.connect }),
		generationId: options.generationId ?? crypto.randomUUID(),
	});
}

/** 创建受保护本机 IPC 的 Node socket 适配器；Windows endpoint 为 Named Pipe，Linux endpoint 为 Unix socket。 */
export function createDesktopHostIpcTransport(
	options: DesktopHostIpcTransportOptions,
): DesktopHostIpcTransport {
	const socket: DesktopHostIpcSocket = options.connect?.(options.endpoint) ?? connectSocket(options.endpoint);
	let dataListener: ((chunk: Uint8Array) => void) | null = null;
	let errorListener: ((error: Error) => void) | null = null;
	let closeListener: (() => void) | null = null;
	const onData = (listener: (chunk: Uint8Array) => void): (() => void) => {
		dataListener = listener;
		const handler = (chunk: unknown) => {
			if (chunk instanceof Uint8Array) dataListener?.(chunk);
		};
		socket.on("data", handler);
		return () => {
			if (dataListener === listener) dataListener = null;
			socket.off("data", handler);
		};
	};
	return {
		write(frame) {
			socket.write(frame);
		},
		onData,
		onError(listener) {
			errorListener = listener;
			const handler = (error: unknown) => {
				if (error instanceof Error) errorListener?.(error);
				else errorListener?.(new Error("Desktop Host IPC error"));
			};
			socket.on("error", handler);
			return () => {
				if (errorListener === listener) errorListener = null;
				socket.off("error", handler);
			};
		},
		onClose(listener) {
			closeListener = listener;
			const handler = () => closeListener?.();
			socket.on("close", handler);
			return () => {
				if (closeListener === listener) closeListener = null;
				socket.off("close", handler);
			};
		},
		close() {
			socket.destroy();
		},
	};
}

/** 为本地 Desktop Host IPC 编解码长度前缀 JSON 帧。 */
export function encodeDesktopHostFrame(frame: DesktopHostIpcFrame): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(frame));
	if (body.byteLength > RemoteDesktopLimits.maxIpcFrameBytes) {
		throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
	}
	const output = new Uint8Array(HEADER_BYTES + body.byteLength);
	new DataView(output.buffer).setUint32(0, body.byteLength);
	output.set(body, HEADER_BYTES);
	return output;
}

/** 处理任意碎片边界，并拒绝超过共享上限的 IPC 帧。 */
export class DesktopHostFrameDecoder {
	private buffer = new Uint8Array(0);

	push(chunk: Uint8Array): DesktopHostIpcFrame[] {
		const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
		merged.set(this.buffer);
		merged.set(chunk, this.buffer.byteLength);
		this.buffer = merged;
		const frames: DesktopHostIpcFrame[] = [];
		while (this.buffer.byteLength >= HEADER_BYTES) {
			const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0);
			if (length > RemoteDesktopLimits.maxIpcFrameBytes) throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
			if (this.buffer.byteLength < HEADER_BYTES + length) break;
			let body: string;
			try {
				body = new TextDecoder("utf-8", { fatal: true }).decode(
					this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length),
				);
			} catch {
				throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
			}
			const frame = parsed as Record<string, unknown>;
			if (
				Object.keys(frame).some((key) => !["protocolVersion", "generationId", "kind", "payload"].includes(key)) ||
				frame.protocolVersion !== VERSION ||
				typeof frame.generationId !== "string" ||
				!["request", "response", "state"].includes(frame.kind as string)
			) {
				throw new Error("REMOTE_DESKTOP_PROTOCOL_MISMATCH");
			}
			// SAFETY: frame fields were validated immediately above; payload remains opaque by design.
			frames.push(frame as unknown as DesktopHostIpcFrame);
			this.buffer = this.buffer.slice(HEADER_BYTES + length);
		}
		return frames;
	}
}

interface Pending {
	resolve: (response: RemoteDesktopClientResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

function hostError(
	message: string,
	code: "REMOTE_DESKTOP_HOST_OFFLINE" | "REMOTE_DESKTOP_PROTOCOL_MISMATCH" = "REMOTE_DESKTOP_HOST_OFFLINE",
): Error {
	return Object.assign(new Error(message), { code });
}

/** 维护 requestId、generation 与超时；不会向 TypeScript 暴露媒体、输入或剪贴板正文。 */
export class DesktopHostIpcClient {
	private readonly decoder = new DesktopHostFrameDecoder();
	private readonly pending = new Map<string, Pending>();
	private readonly generationId: string;
	private readonly timeoutMs: number;
	private readonly expectedHostGeneration?: string;
	private readonly unsubscribe: () => void;
	private readonly unsubscribeError?: () => void;
	private readonly unsubscribeClose?: () => void;
	private readonly stateListeners = new Set<(report: RemoteDesktopStateReport) => void>();
	private readonly transport: DesktopHostIpcTransport;

	constructor(options: DesktopHostIpcClientOptions) {
		this.generationId = options.generationId;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.expectedHostGeneration = options.expectedHostGeneration;
		this.transport = options.transport;
		this.unsubscribe = options.transport.onData((chunk) => this.onData(chunk));
		this.unsubscribeError = options.transport.onError?.(() => {
			this.failAll(hostError("Desktop Host is offline"));
		});
		this.unsubscribeClose = options.transport.onClose?.(() => {
			this.failAll(hostError("Desktop Host disconnected"));
		});
	}

	onState(listener: (report: RemoteDesktopStateReport) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	request(request: RemoteDesktopClientRequest): Promise<RemoteDesktopClientResponse> {
		if (this.pending.has(request.requestId)) return Promise.reject(hostError("Duplicate Desktop Host request"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.requestId);
				reject(hostError("Desktop Host request timed out"));
			}, this.timeoutMs);
			this.pending.set(request.requestId, { resolve, reject, timer });
			try {
				this.transport.write(encodeDesktopHostFrame({
					protocolVersion: VERSION,
					generationId: this.generationId,
					kind: "request",
					payload: request,
				}));
			} catch {
				clearTimeout(timer);
				this.pending.delete(request.requestId);
				reject(hostError("Desktop Host is offline"));
			}
		});
	}

	private onData(chunk: Uint8Array): void {
		let frames: DesktopHostIpcFrame[];
		try {
			frames = this.decoder.push(chunk);
		} catch {
			this.failAll(hostError("Invalid Desktop Host frame", "REMOTE_DESKTOP_PROTOCOL_MISMATCH"));
			return;
		}
		for (const frame of frames) {
			if (frame.generationId !== this.generationId) {
				this.failAll(hostError("Desktop Host generation changed"));
				return;
			}
			if (frame.kind === "state") {
				try {
					const report = parseRemoteDesktopStateReport(frame.payload);
					for (const listener of this.stateListeners) listener(report);
				} catch {
					this.failAll(hostError("Invalid Desktop Host state", "REMOTE_DESKTOP_PROTOCOL_MISMATCH"));
				}
				continue;
			}
			if (frame.kind !== "response") continue;
			let response: RemoteDesktopClientResponse;
			try {
				response = parseRemoteDesktopClientResponse(frame.payload);
				if (this.expectedHostGeneration && response.hostGeneration !== this.expectedHostGeneration) {
					this.failAll(hostError("Desktop Host generation changed"));
					return;
				}
			} catch {
				this.failAll(hostError("Invalid Desktop Host response", "REMOTE_DESKTOP_PROTOCOL_MISMATCH"));
				return;
			}
			const pending = this.pending.get(response.requestId);
			if (!pending) continue;
			this.pending.delete(response.requestId);
			clearTimeout(pending.timer);
			pending.resolve(response);
		}
	}

	private failAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	close(): void {
		this.unsubscribe();
		this.unsubscribeError?.();
		this.unsubscribeClose?.();
		this.failAll(hostError("Desktop Host is offline"));
		this.stateListeners.clear();
		this.transport.close?.();
	}
}
