import { describe, expect, it } from "vitest";
import { projectPiEvent } from "./event-projector.js";

const SID = "s1";

describe("projectPiEvent", () => {
	it("丢弃 turn_start/turn_end/tool_execution_update", () => {
		expect(projectPiEvent({ type: "turn_start" }, SID)).toBeNull();
		expect(projectPiEvent({ type: "turn_end" }, SID)).toBeNull();
		expect(
			projectPiEvent({ type: "tool_execution_update", toolName: "bash" }, SID),
		).toBeNull();
	});

	it("SDK 新增的边界事件不改变现有投影语义", () => {
		// agent_before_settle（0.87.0 新增）没有专项分支，落到 default：
		// 「未识别事件只提示历史已变化」。这是壳主的保守兼底——刷新历史是安全的，
		// 但不得因此新增一条协议事件类型。此处把它锁定下来。
		expect(projectPiEvent({ type: "agent_before_settle" }, SID)).toEqual({
			type: "history_changed",
			sessionId: SID,
		});
		// turn_end 本就是显式丢弃名单，增加边界字段（entries/aborted）后仍是丢弃。
		expect(
			projectPiEvent({ type: "turn_end", entries: [], aborted: false }, SID),
		).toBeNull();
	});

	it("agent_settled 的 aborted 字段不进入投影", () => {
		// SDK 1.1.0 起 agent_settled 带 aborted；协议当前不含该字段，
		// 因此投影必须显式构造，不得透传事件对象。
		expect(projectPiEvent({ type: "agent_settled", aborted: true }, SID)).toEqual({
			type: "agent_settled",
			sessionId: SID,
		});
	});

	it("thinking 阶段和 delta 进入事件，但限制单次正文大小", () => {
		const start = projectPiEvent({ type: "thinking_start" }, SID);
		expect(start).toEqual({
			type: "thinking_progress",
			sessionId: SID,
			stage: "start",
		});
		const delta = projectPiEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "secret thinking",
				},
			},
			SID,
		);
		expect(delta).toEqual({
			type: "thinking_progress",
			sessionId: SID,
			stage: "delta",
			text: "secret thinking",
		});
		const end = projectPiEvent(
			{ type: "thinking_end", durationMs: 1234, content: "secret thinking" },
			SID,
		);
		expect(end).toEqual({
			type: "thinking_progress",
			sessionId: SID,
			stage: "end",
			text: "secret thinking",
			durationMs: 1234,
		});
		const huge = projectPiEvent(
			{
				type: "message_update",
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: "x".repeat(20_000),
				},
			},
			SID,
		) as { text?: string };
		expect(huge.text?.length).toBeLessThanOrEqual(16_384);
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
		expect(projected).toEqual({
			type: "message_update",
			sessionId: SID,
			text: "delta",
		});
		expect(JSON.stringify(projected)).not.toContain("secret full content");
	});

	it("agent_end / agent_settled 作为阶段事件转发", () => {
		expect(projectPiEvent({ type: "agent_end" }, SID)).toEqual({
			type: "agent_end",
			sessionId: SID,
		});
		expect(projectPiEvent({ type: "agent_settled" }, SID)).toEqual({
			type: "agent_settled",
			sessionId: SID,
		});
	});

	it("超大事件兜底为 history_changed", () => {
		const huge = projectPiEvent(
			{ type: "usage_update", usage: { x: "y".repeat(300 * 1024) } },
			SID,
		);
		expect(huge?.type).toBe("history_changed");
		const projected = huge as { type: "history_changed" };
		expect(projected).toMatchObject({ type: "history_changed" });
		expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
			256 * 1024,
		);
	});

	it("extension_ui_request 投影为标准 UI 请求", () => {
		const projected = projectPiEvent(
			{
				type: "extension_ui_request",
				id: "u1",
				method: "confirm",
				title: "T",
				message: "M",
			},
			SID,
		);
		expect(projected).toMatchObject({
			type: "extension_request",
			sessionId: SID,
			ui: { requestId: "u1", kind: "confirm", title: "T", message: "M" },
		});
	});

	it("custom UI 映射为 unsupported 状态事件", () => {
		const projected = projectPiEvent(
			{ type: "extension_ui_request", id: "u2", method: "custom" },
			SID,
		);
		expect(projected).toEqual({
			type: "status_update",
			sessionId: SID,
			status: "custom_ui_unsupported",
		});
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
