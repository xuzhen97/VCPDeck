import { describe, expect, it } from "vitest";
import { normalizeToolCalls, textOf, truncatePreview } from "./normalize.js";
import type { PiAssistantMessage } from "@vcpdeck/shared";

describe("normalizeToolCalls", () => {
	it("把 Pi 文件格式 ToolCall 规范化", () => {
		const raw = {
			id: "m1",
			role: "assistant",
			content: [
				{
					type: "tool_call",
					id: "c1",
					name: "bash",
					arguments: { command: "pwd" },
				},
			],
		} as unknown as PiAssistantMessage;
		const normalized = normalizeToolCalls(raw) as PiAssistantMessage;
		expect(normalized.content[0]).toMatchObject({
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "pwd" },
		});
	});

	it("非 assistant 消息原样返回", () => {
		const user = { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] };
		expect(normalizeToolCalls(user as never)).toBe(user);
	});

	it("缺失字段回退为空字符串/对象", () => {
		const raw = {
			id: "m1",
			role: "assistant",
			content: [{ type: "tool_call" }],
		} as unknown as PiAssistantMessage;
		const normalized = normalizeToolCalls(raw) as PiAssistantMessage;
		expect(normalized.content[0]).toMatchObject({
			toolCallId: "",
			toolName: "",
			input: {},
		});
	});
});

describe("textOf / truncatePreview", () => {
	it("提取 text block 内容", () => {
		expect(textOf("plain")).toBe("plain");
		expect(textOf([{ type: "text", text: "hello" }])).toBe("hello");
		expect(textOf([{ type: "image", deferred: true }])).toBe("");
	});

	it("安全截断预览", () => {
		expect(truncatePreview("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
		expect(truncatePreview("short", 10)).toBe("short");
	});
});
