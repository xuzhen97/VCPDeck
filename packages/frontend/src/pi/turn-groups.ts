import type { PiMessage } from "@vcpdeck/shared";

/** 一个回合：user prompt + 中间过程（Process Details）+ 最终回答 */
export interface PiTurnGroup {
	userMessage: PiMessage | null;
	processMessages: PiMessage[];
	finalAssistant: PiMessage | null;
	toolCallCount: number;
	processMessageCount: number;
}

function isToolCall(m: PiMessage): boolean {
	return m.role === "assistant" && m.content.some((c) => c.type === "tool_call");
}

function hasText(m: PiMessage): boolean {
	return m.role === "assistant" && m.content.some((c) => c.type === "text" && c.text.trim() !== "");
}

/**
 * 把消息流折叠为回合组：每条 user 消息开启新回合；
 * 中间 assistant/tool 消息归入 process（最终一条有文本的 assistant 单独显示）。
 */
export function buildTurnGroups(messages: PiMessage[]): PiTurnGroup[] {
	const groups: PiTurnGroup[] = [];
	let current: PiTurnGroup | null = null;

	for (const m of messages) {
		if (m.role === "user") {
			if (current) groups.push(current);
			current = {
				userMessage: m,
				processMessages: [],
				finalAssistant: null,
				toolCallCount: 0,
				processMessageCount: 0,
			};
			continue;
		}
		if (!current) {
			// 孤立 process 消息（无 user 前缀）：建一个无 prompt 的组
			current = {
				userMessage: null,
				processMessages: [],
				finalAssistant: null,
				toolCallCount: 0,
				processMessageCount: 0,
			};
		}
		if (m.role === "assistant" && hasText(m)) {
			// 最新有文本的 assistant 是最终回答；旧 final 折叠进 process
			if (current.finalAssistant) {
				current.processMessages.push(current.finalAssistant);
			}
			current.finalAssistant = m;
		} else {
			current.processMessages.push(m);
		}
		if (isToolCall(m)) current.toolCallCount += 1;
		current.processMessageCount = current.processMessages.length;
	}
	if (current) groups.push(current);
	return groups;
}
