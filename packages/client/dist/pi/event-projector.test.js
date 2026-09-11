"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const event_projector_js_1 = require("./event-projector.js");
const SID = "s1";
(0, vitest_1.describe)("projectPiEvent", () => {
    (0, vitest_1.it)("丢弃 turn_start/turn_end/tool_execution_update", () => {
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "turn_start" }, SID)).toBeNull();
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "turn_end" }, SID)).toBeNull();
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "tool_execution_update", toolName: "bash" }, SID)).toBeNull();
    });
    (0, vitest_1.it)("thinking 阶段和 delta 进入事件，但限制单次正文大小", () => {
        const start = (0, event_projector_js_1.projectPiEvent)({ type: "thinking_start" }, SID);
        (0, vitest_1.expect)(start).toEqual({
            type: "thinking_progress",
            sessionId: SID,
            stage: "start",
        });
        const delta = (0, event_projector_js_1.projectPiEvent)({
            type: "message_update",
            assistantMessageEvent: {
                type: "thinking_delta",
                delta: "secret thinking",
            },
        }, SID);
        (0, vitest_1.expect)(delta).toEqual({
            type: "thinking_progress",
            sessionId: SID,
            stage: "delta",
            text: "secret thinking",
        });
        const end = (0, event_projector_js_1.projectPiEvent)({ type: "thinking_end", durationMs: 1234, content: "secret thinking" }, SID);
        (0, vitest_1.expect)(end).toEqual({
            type: "thinking_progress",
            sessionId: SID,
            stage: "end",
            text: "secret thinking",
            durationMs: 1234,
        });
        const huge = (0, event_projector_js_1.projectPiEvent)({
            type: "message_update",
            assistantMessageEvent: {
                type: "thinking_delta",
                delta: "x".repeat(20_000),
            },
        }, SID);
        (0, vitest_1.expect)(huge.text?.length).toBeLessThanOrEqual(16_384);
    });
    (0, vitest_1.it)("message_update 不携带完整 partial", () => {
        const projected = (0, event_projector_js_1.projectPiEvent)({
            type: "message_update",
            text: "delta",
            assistantMessageEvent: { full: "secret full content" },
        }, SID);
        (0, vitest_1.expect)(projected).toEqual({
            type: "message_update",
            sessionId: SID,
            text: "delta",
        });
        (0, vitest_1.expect)(JSON.stringify(projected)).not.toContain("secret full content");
    });
    (0, vitest_1.it)("agent_end / agent_settled 作为阶段事件转发", () => {
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "agent_end" }, SID)).toEqual({
            type: "agent_end",
            sessionId: SID,
        });
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "agent_settled" }, SID)).toEqual({
            type: "agent_settled",
            sessionId: SID,
        });
    });
    (0, vitest_1.it)("超大事件兜底为 history_changed", () => {
        const huge = (0, event_projector_js_1.projectPiEvent)({ type: "usage_update", usage: { x: "y".repeat(300 * 1024) } }, SID);
        (0, vitest_1.expect)(huge?.type).toBe("history_changed");
        const projected = huge;
        (0, vitest_1.expect)(projected).toMatchObject({ type: "history_changed" });
        (0, vitest_1.expect)(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(256 * 1024);
    });
    (0, vitest_1.it)("extension_ui_request 投影为标准 UI 请求", () => {
        const projected = (0, event_projector_js_1.projectPiEvent)({
            type: "extension_ui_request",
            id: "u1",
            method: "confirm",
            title: "T",
            message: "M",
        }, SID);
        (0, vitest_1.expect)(projected).toMatchObject({
            type: "extension_request",
            sessionId: SID,
            ui: { requestId: "u1", kind: "confirm", title: "T", message: "M" },
        });
    });
    (0, vitest_1.it)("custom UI 映射为 unsupported 状态事件", () => {
        const projected = (0, event_projector_js_1.projectPiEvent)({ type: "extension_ui_request", id: "u2", method: "custom" }, SID);
        (0, vitest_1.expect)(projected).toEqual({
            type: "status_update",
            sessionId: SID,
            status: "custom_ui_unsupported",
        });
    });
    (0, vitest_1.it)("未识别事件只提示历史变化", () => {
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "totally_unknown", x: 1 }, SID)).toEqual({
            type: "history_changed",
            sessionId: SID,
        });
    });
    (0, vitest_1.it)("message_end 提示历史已更新", () => {
        (0, vitest_1.expect)((0, event_projector_js_1.projectPiEvent)({ type: "message_end" }, SID)).toEqual({
            type: "history_changed",
            sessionId: SID,
        });
    });
});
