import type { PiClientEvent } from "@vcpdeck/shared";

export interface PiStreamHandlers {
	onEvent(event: PiClientEvent): void;
	/** 解析失败等诊断信息（不含原始 event body） */
	onDiagnostics?(message: string): void;
	/** 连接彻底关闭（EventSource readyState CLOSED 且非手动） */
	onFatal?(error: Error): void;
}

export interface PiEventStream {
	/** 首次连接就绪 */
	connected(): Promise<void>;
	close(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 认证 SSE 包装：cookie 自动携带；解析失败只上报诊断信息；
 * 断线由 EventSource 自动重连；close() 手动关闭。
 */
export function openPiEventStream(
	path: string,
	handlers: PiStreamHandlers,
): PiEventStream {
	let source: EventSource | null = null;
	let closed = false;
	let resolveConnected: () => void = () => {};
	let connectedPromise: Promise<void> | null = null;

	const ensureSource = (): EventSource => {
		if (source && source.readyState !== EventSource.CLOSED) return source;
		source = new EventSource(path, { withCredentials: true });
		source.onopen = () => resolveConnected();
		source.onmessage = (event) => {
			try {
				const parsed = JSON.parse(event.data as string) as unknown;
				const envelope =
					isRecord(parsed) && isRecord(parsed.event) ? parsed : null;
				const clientEvent = envelope ? envelope.event : parsed;
				if (isRecord(clientEvent) && typeof clientEvent.type === "string") {
					const eventWithRun =
						envelope && typeof envelope.runId === "string"
							? { ...clientEvent, runId: envelope.runId }
							: clientEvent;
					handlers.onEvent(eventWithRun as unknown as PiClientEvent);
				} else {
					handlers.onDiagnostics?.("SSE event 缺少 type 字段");
				}
			} catch {
				handlers.onDiagnostics?.("SSE event 解析失败");
			}
		};
		source.onerror = () => {
			// EventSource 自动重连；readyState CLOSED 表示无法再连
			if (source?.readyState === EventSource.CLOSED && !closed) {
				const error = new Error("SSE connection closed");
				resolveConnected();
				handlers.onFatal?.(error);
			}
		};
		return source;
	};

	connectedPromise = new Promise<void>((resolve) => {
		resolveConnected = resolve;
		ensureSource();
	});

	return {
		connected: () => connectedPromise ?? Promise.resolve(),
		close() {
			closed = true;
			resolveConnected();
			source?.close();
		},
	};
}
