import { describe, expect, it } from "vitest";
import { projectPiEvent } from "./event-projector.js";

const SID = "s1";

describe("projectPiEvent", () => {
	it("丢弃 turn_start/turn_end/tool_execution_update", () => {
		expect(projectPiEvent({ type: "turn_start" }, SID)).toBeNull();
		expect(projectPiEvent({ type: "turn_end" }, SID)).toBeNull();
		expect(projectPiEvent({ type: "tool_execution_update", toolName: "bash" }, SID)).toBeNull();
	});

	it("thinking 正文不进入事件（只保留阶段）", () => {
		const start = projectPiEvent({ type: "thinking_start" }, SID);
		expect(start).toEqual({ type: "thinking_progress", sessionId: SID, stage: "start" });
		const end = projectPiEvent({ type: "thinking_end", durationMs: 1234 }, SID);
		expect(end).toEqual({ type: "thinking_progress", sessionId: SID, stage: "end", durationMs: 1234 });
		expect(JSON.stringify(start)).not.toContain("secret");
	});

	it("message_update 不携带完整 partial", () => {
		const projected = projectPiEvent(
			{
				type: "message_update",
				text: "delta",
				assistantMessageEvent: { full: "secret full content" },
			},
			SID,
		);
		expect(projected).toEqual({ type: "message_update", sessionId: SID, text: "delta" });
		expect(JSON.stringify(projected)).not.toContain("secret full content");
	});

	it("agent_end / agent_settled 作为阶段事件转发", () => {
		expect(projectPiEvent({ type: "agent_end" }, SID)).toEqual({ type: "agent_end", sessionId: SID });
		expect(projectPiEvent({ type: "agent_settled" }, SID)).toEqual({
			type: "agent_settled",
			sessionId: SID,
		});
	});

	it("超大事件兜底为 history_changed", () => {
		const huge = projectPiEvent({ type: "usage_update", usage: { x: "y".repeat(300 * 1024) } }, SID);
		expect(huge?.type).toBe("history_changed");
		const projected = huge as { type: "history_changed" };
		expect(projected).toMatchObject({ type: "history_changed" });
		expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(256 * 1024);
	});

	it("extension_ui_request 投影为标准 UI 请求", () => {
		const projected = projectPiEvent(
			{ type: "extension_ui_request", id: "u1", method: "confirm", title: "T", message: "M" },
			SID,
		);
		expect(projected).toMatchObject({
			type: "extension_request",
			sessionId: SID,
			ui: { requestId: "u1", kind: "confirm", title: "T", message: "M" },
		});
	});

	it("custom UI 映射为 unsupported 状态事件", () => {
		const projected = projectPiEvent({ type: "extension_ui_request", id: "u2", method: "custom" }, SID);
		expect(projected).toEqual({ type: "status_update", sessionId: SID, status: "custom_ui_unsupported" });
	});

	it("未识别事件只提示历史变化", () => {
		expect(projectPiEvent({ type: "totally_unknown", x: 1 }, SID)).toEqual({
			type: "history_changed",
			sessionId: SID,
		});
	});

	it("message_end 提示历史已更新", () => {
		expect(projectPiEvent({ type: "message_end" }, SID)).toEqual({
			type: "history_changed",
			sessionId: SID,
		});
	});
});
