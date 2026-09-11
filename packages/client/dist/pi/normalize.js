"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeToolCalls = normalizeToolCalls;
exports.textOf = textOf;
exports.truncatePreview = truncatePreview;
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 把 Pi 原生 assistant 消息中的 toolCall block 字段名规范化 */
function normalizeToolCalls(msg) {
    if (msg.role !== "assistant")
        return msg;
    const content = msg.content;
    if (!Array.isArray(content))
        return msg;
    const normalized = content.map((block) => {
        if (block.type !== "tool_call")
            return block;
        const raw = block;
        return {
            type: "tool_call",
            toolCallId: typeof raw.toolCallId === "string"
                ? raw.toolCallId
                : typeof raw.id === "string"
                    ? (raw.id)
                    : "",
            toolName: typeof raw.toolName === "string"
                ? raw.toolName
                : typeof raw.name === "string"
                    ? (raw.name)
                    : "",
            input: isObject(raw.input)
                ? raw.input
                : isObject(raw.arguments)
                    ? (raw.arguments)
                    : {},
        };
    });
    return { ...msg, content: normalized };
}
/** 提取 text block 的纯文本（历史列表 firstMessage 预览用） */
function textOf(content) {
    if (typeof content === "string")
        return content;
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
function truncatePreview(text, max = 200) {
    const trimmed = text.trim();
    if (trimmed.length <= max)
        return trimmed;
    return `${trimmed.slice(0, max - 1)}…`;
}
