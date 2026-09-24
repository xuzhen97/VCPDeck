import { describe, expect, it } from "vitest";
import type { PiMessage } from "@vcpdeck/shared";
import { toRenderMessages } from "./pi-render-adapter";

const ctx = { model: "glm-5", provider: "zai" };

describe("toRenderMessages（PiMessage → AgentMessage）", () => {
	it("user：text 映射 TextContent；image 占位映射为标注文本（无字节可渲染）", () => {
		const out = toRenderMessages(
			[
				{
					id: "m1",
					role: "user",
					content: [
						{ type: "text", text: "你好" },
						{
							type: "image",
							deferred: true,
							mimeType: "image/png",
							entryId: "e1",
							blockIndex: 0,
						},
					],
				} as PiMessage,
			],
			ctx,
		);
		expect(out).toMatchObject([
			{
				role: "user",
				content: [{ type: "text", text: "你好" }, { type: "text", text: "[图片 image/png]" }],
			},
		]);
	});

	it("assistant：text/thinking/tool_call 映射对应块，tool_call 改名 toolCall 并带 model/provider", () => {
		const out = toRenderMessages(
			[
				{
					id: "m2",
					role: "assistant",
					content: [
						{ type: "thinking", deferred: true, text: "推理中", durationMs: 3000 },
						{ type: "text", text: "答案" },
						{ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
					],
				} as PiMessage,
			],
			ctx,
		);
		expect(out).toMatchObject([
			{
				role: "assistant",
				model: "glm-5",
				provider: "zai",
				content: [
					{ type: "thinking", thinking: "推理中" },
					{ type: "text", text: "答案" },
					{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: { command: "ls" } },
				],
			},
		]);
	});

	it("thinking 历史占位（无正文）映射为 deferred thinking", () => {
		const out = toRenderMessages(
			[{ id: "m3", role: "assistant", content: [{ type: "thinking", deferred: true }] } as PiMessage],
			ctx,
		);
		expect(out[0]).toMatchObject({
			role: "assistant",
			content: [{ type: "thinking", deferred: true }],
		});
	});

	it("tool_result 改名 toolResult 并携带文本内容", () => {
		const out = toRenderMessages(
			[
				{
					id: "m4",
					role: "tool_result",
					toolCallId: "t1",
					content: [{ type: "text", text: "hi" }],
				} as PiMessage,
			],
			ctx,
		);
		expect(out).toMatchObject([
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "hi" }] },
		]);
	});

	it("custom 映射 CustomMessage（customType=kind，display=true）", () => {
		const out = toRenderMessages([{ id: "m5", role: "custom", kind: "compaction" } as PiMessage], ctx);
		expect(out).toMatchObject([
			{ role: "custom", customType: "compaction", content: "", display: true },
		]);
	});
});
