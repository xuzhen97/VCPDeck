"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EVENT_BYTES = void 0;
exports.projectPiEvent = projectPiEvent;
/** 单个投影事件 JSON 上限 */
exports.MAX_EVENT_BYTES = 256 * 1024;
const MAX_THINKING_DELTA_CHARS = 16_384;
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
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v) {
    return typeof v === "string" ? v : undefined;
}
function strArr(v) {
    if (!Array.isArray(v))
        return undefined;
    const out = v.filter((x) => typeof x === "string");
    return out.length > 0 ? out : undefined;
}
function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bounded(event) {
    if (Buffer.byteLength(JSON.stringify(event)) <= exports.MAX_EVENT_BYTES)
        return event;
    return {
        type: "history_changed",
        sessionId: event.sessionId,
    };
}
/**
 * 把 Pi SDK 原生事件投影为可出站的裁剪事件。
 * - 去掉 turn_start/turn_end/tool_execution_update；
 * - thinking 只保留受限阶段、正文增量和耗时；
 * - message_update 不携带完整 partial；
 * - 超大事件兜底为 history_changed。
 */
function projectPiEvent(event, sessionId) {
    if (!isRecord(event))
        return null;
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
            const assistantEvent = isRecord(event.assistantMessageEvent)
                ? event.assistantMessageEvent
                : null;
            if (assistantEvent?.type === "thinking_start" ||
                assistantEvent?.type === "thinking_delta" ||
                assistantEvent?.type === "thinking_end") {
                const stage = assistantEvent.type.replace("thinking_", "");
                const text = stage === "delta"
                    ? str(assistantEvent.delta)
                    : str(assistantEvent.content);
                return {
                    type: "thinking_progress",
                    sessionId,
                    stage,
                    ...(text !== undefined
                        ? { text: text.slice(0, MAX_THINKING_DELTA_CHARS) }
                        : {}),
                };
            }
            const projected = {
                type: "message_update",
                sessionId,
                ...(str(event.text) !== undefined
                    ? { text: str(event.text) }
                    : {}),
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
                ...(str(event.content) !== undefined
                    ? {
                        text: str(event.content).slice(0, MAX_THINKING_DELTA_CHARS),
                    }
                    : {}),
                ...(num(event.durationMs) !== undefined
                    ? { durationMs: num(event.durationMs) }
                    : {}),
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
function projectExtensionRequest(event, sessionId) {
    const method = str(event.method);
    if (method === undefined || !UI_KINDS.has(method)) {
        if (method === "custom") {
            return {
                type: "status_update",
                sessionId,
                status: "custom_ui_unsupported",
            };
        }
        return null;
    }
    const ui = {
        requestId: str(event.id) ?? "",
        extensionId: str(event.extensionId) ?? "",
        kind: method,
        ...(str(event.title) !== undefined
            ? { title: str(event.title) }
            : {}),
        ...(str(event.message) !== undefined
            ? { message: str(event.message) }
            : {}),
        ...(strArr(event.options) !== undefined
            ? { options: strArr(event.options) }
            : {}),
        ...(num(event.timeout) !== undefined
            ? { timeoutMs: num(event.timeout) }
            : {}),
    };
    return { type: "extension_request", sessionId, ui };
}
