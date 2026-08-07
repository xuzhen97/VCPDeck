import type {
	PiAssistantMessage,
	PiMessage,
	PiTextContent,
	PiToolCallContent,
} from "@vcpdeck/shared";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 把 Pi 原生 assistant 消息中的 toolCall block 字段名规范化 */
export function normalizeToolCalls(msg: PiMessage): PiMessage {
	if (msg.role !== "assistant") return msg;
	const content = (msg as PiAssistantMessage).content;
	if (!Array.isArray(content)) return msg;
	const normalized = content.map((block) => {
		if (block.type !== "tool_call") return block;
		const raw = block as PiToolCallContent;
		return {
			type: "tool_call",
			toolCallId:
				typeof raw.toolCallId === "string"
					? raw.toolCallId
					: typeof (raw as unknown as { id?: unknown }).id === "string"
						? ((raw as unknown as { id: string }).id)
						: "",
			toolName:
				typeof raw.toolName === "string"
					? raw.toolName
					: typeof (raw as unknown as { name?: unknown }).name === "string"
						? ((raw as unknown as { name: string }).name)
						: "",
			input:
				isObject(raw.input)
					? raw.input
					: isObject((raw as unknown as { arguments?: unknown }).arguments)
						? ((raw as unknown as { arguments: Record<string, unknown> }).arguments)
						: {},
		} satisfies PiToolCallContent;
	});
	return { ...msg, content: normalized } as PiAssistantMessage;
}

/** 提取 text block 的纯文本（历史列表 firstMessage 预览用） */
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
