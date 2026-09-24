import type {
	PiMessage,
	PiMessageContent,
	PiTextContent,
	PiImagePlaceholder,
} from "@vcpdeck/shared";
import type {
	AgentMessage,
	AssistantContentBlock,
	TextContent,
	ThinkingContent,
	ToolCallContent,
} from "../pi-web/lib/types";

/** 单块映射：文本直通；图片占位无字节可渲染，退化为标注文本；thinking 实时正文优先；tool_call → toolCall。 */
function mapBlock(block: PiMessageContent): AssistantContentBlock {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text } satisfies TextContent;
		case "image":
			return { type: "text", text: `[图片 ${block.mimeType}]` } satisfies TextContent;
		case "thinking":
			return block.text !== undefined
				? ({ type: "thinking", thinking: block.text } satisfies ThinkingContent)
				: ({ type: "thinking", thinking: "", deferred: true } satisfies ThinkingContent);
		case "tool_call":
			return {
				type: "toolCall",
				toolCallId: block.toolCallId,
				toolName: block.toolName,
				input: block.input,
			} satisfies ToolCallContent;
	}
}

function mapUserBlock(block: PiTextContent | PiImagePlaceholder): TextContent {
	return block.type === "text"
		? { type: "text", text: block.text }
		: { type: "text", text: `[图片 ${block.mimeType}]` };
}

/**
 * PiMessage[]（Shared DTO）→ AgentMessage[]（pi-web 渲染模型）。
 * 唯一翻译点（ADR-0032 决策 2）：协议变化只改本模块。
 */
export function toRenderMessages(
	messages: PiMessage[],
	ctx: { model: string; provider: string },
): AgentMessage[] {
	return messages.map((message): AgentMessage => {
		switch (message.role) {
			case "user":
				return { role: "user", content: message.content.map(mapUserBlock) };
			case "assistant":
				return {
					role: "assistant",
					content: message.content.map(mapBlock),
					model: ctx.model,
					provider: ctx.provider,
				};
			case "tool_result":
				return {
					role: "toolResult",
					toolCallId: message.toolCallId,
					content: message.content.map((c) => ({ type: "text", text: c.text })),
				};
			case "custom":
				return { role: "custom", customType: message.kind, content: "", display: true };
		}
	});
}
