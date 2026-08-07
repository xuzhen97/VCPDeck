import type {
	PiAssistantMessage,
	PiMessage,
	PiToolCallContent,
} from "@vcpdeck/shared";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 把 Pi SDK 原生 toolCall 字段（id/name/arguments）规范化为协议字段 */
export function normalizeToolCalls(msg: PiMessage): PiMessage {
	if (msg.role !== "assistant") return msg;
	const content = (msg as PiAssistantMessage).content;
	if (!Array.isArray(content)) return msg;
	const normalized = content.map((block) => {
		if (block.type !== "tool_call") return block;
		const raw = block as PiToolCallContent;
		const legacy = raw as unknown as {
			id?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		return {
			type: "tool_call",
			toolCallId:
				typeof raw.toolCallId === "string"
					? raw.toolCallId
					: typeof legacy.id === "string"
						? legacy.id
						: "",
			toolName:
				typeof raw.toolName === "string"
					? raw.toolName
					: typeof legacy.name === "string"
						? legacy.name
						: "",
			input: isObject(raw.input)
				? raw.input
				: isObject(legacy.arguments)
					? legacy.arguments
					: {},
		} satisfies PiToolCallContent;
	});
	return { ...msg, content: normalized } as PiAssistantMessage;
}

/** 提取消息文本（firstMessage 预览用） */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (isObject(block) && block.type === "text" && typeof block.text === "string") {
				return block.text;
			}
		}
	}
	return "";
}

/** 安全截断预览文本 */
export function truncatePreview(text: string, max = 200): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}
