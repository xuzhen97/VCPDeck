import { isPiClientEventType, type PiClientEvent } from "@vcpdeck/shared";

export interface PiStreamHandlers {
	onEvent(event: PiClientEvent): void;
	/** 每次连接建立都触发（含 EventSource 自动重连）；`connected()` 只在首次触发。 */
	onConnected?(): void;
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
		source.onopen = () => {
			resolveConnected();
			// 每次连接（含 EventSource 自动重连）都通知宿主。
			// `connected()` 只在首次连接时 resolve，两者语义不同：
			// 重连后宿主应重新对账并拉取最新快照，而不必重新 open 会话。
			handlers.onConnected?.();
		};
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
					// SAFETY: 上游只接受 `isRecord && typeof type === "string"`，但 TypeScript
					// 无法据此断定 type 是 PiClientEvent["type"]。这里按“未知事件类型一律丢弃”
					// 的方式处理：不猜测、不透传，交由消费方的 switch 忽略未知 type
					// （项目规则：未知 type 不得宽松猜测）。
					if (!isPiClientEventType(clientEvent.type)) {
						handlers.onDiagnostics?.("SSE event type 未知，已忽略");
						return;
					}
					// SAFETY: 上一步已用 Shared 的 EVENT_TYPES 校验 type，剩余字段按各事件
					// 类型的必填形状由消费方防御性读取；此处不伪造未知字段。
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
