import type { PiClientEvent, PiExtensionUiRequest } from "@vcpdeck/shared";

/** 单个投影事件 JSON 上限 */
export const MAX_EVENT_BYTES = 256 * 1024;

const UI_KINDS = new Set([
	"select",
	"confirm",
	"input",
	"editor",
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function strArr(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = v.filter((x): x is string => typeof x === "string");
	return out.length > 0 ? out : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function bounded(event: PiClientEvent): PiClientEvent {
	if (Buffer.byteLength(JSON.stringify(event)) <= MAX_EVENT_BYTES) return event;
	return { type: "history_changed", sessionId: (event as { sessionId: string }).sessionId };
}

/**
 * 把 Pi SDK 原生事件投影为可出站的裁剪事件。
 * - 去掉 turn_start/turn_end/tool_execution_update；
 * - thinking 只保留阶段/耗时；
 * - message_update 不携带完整 partial；
 * - 超大事件兜底为 history_changed。
 */
export function projectPiEvent(event: unknown, sessionId: string): PiClientEvent | null {
	if (!isRecord(event)) return null;
	switch (event.type) {
		case "turn_start":
		case "turn_end":
		case "tool_execution_update":
			return null;
		case "agent_start":
			return { type: "agent_start", sessionId };
		case "agent_end":
			return { type: "agent_end", sessionId };
		case "agent_settled":
			return { type: "agent_settled", sessionId };
		case "prompt_done":
			return { type: "prompt_done", sessionId };
		case "prompt_error":
			return bounded({
				type: "prompt_error",
				sessionId,
				code: "PI_RUNTIME_UNAVAILABLE",
				message: str(event.errorMessage) ?? "Prompt failed",
			});
		case "message_update": {
			const projected: PiClientEvent = {
				type: "message_update",
				sessionId,
				...(str(event.text) !== undefined ? { text: str(event.text) as string } : {}),
			};
			return projected;
		}
		case "message_end":
			return { type: "history_changed", sessionId };
		case "thinking_start":
			return { type: "thinking_progress", sessionId, stage: "start" };
		case "thinking_end":
			return {
				type: "thinking_progress",
				sessionId,
				stage: "end",
				...(num(event.durationMs) !== undefined ? { durationMs: num(event.durationMs) as number } : {}),
			};
		case "auto_compaction_start":
		case "compaction_start":
			return { type: "status_update", sessionId, status: "compacting" };
		case "auto_compaction_end":
		case "compaction_end":
			return { type: "status_update", sessionId, status: "settled" };
		case "usage_update":
			return bounded({
				type: "usage_update",
				sessionId,
				usage: isRecord(event.usage) ? event.usage : {},
			});
		case "extension_ui_request":
			return projectExtensionRequest(event, sessionId);
		default:
			// 未识别事件只提示历史已变化
			return { type: "history_changed", sessionId };
	}
}

function projectExtensionRequest(
	event: Record<string, unknown>,
	sessionId: string,
): PiClientEvent | null {
	const method = str(event.method);
	if (method === undefined || !UI_KINDS.has(method)) {
		if (method === "custom") {
			return { type: "status_update", sessionId, status: "custom_ui_unsupported" };
		}
		return null;
	}
	const ui: PiExtensionUiRequest = {
		requestId: str(event.id) ?? "",
		extensionId: str(event.extensionId) ?? "",
		kind: method as PiExtensionUiRequest["kind"],
		...(str(event.title) !== undefined ? { title: str(event.title) as string } : {}),
		...(str(event.message) !== undefined ? { message: str(event.message) as string } : {}),
		...(strArr(event.options) !== undefined ? { options: strArr(event.options) as string[] } : {}),
		...(num(event.timeout) !== undefined ? { timeoutMs: num(event.timeout) as number } : {}),
	};
	return { type: "extension_request", sessionId, ui };
}
