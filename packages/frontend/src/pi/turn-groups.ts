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

function openGroup(userMessage: PiMessage | null): PiTurnGroup {
	return {
		userMessage,
		processMessages: [],
		finalAssistant: null,
		toolCallCount: 0,
		processMessageCount: 0,
	};
}

/** 回合内单条消息归类（最新有文本的 assistant = 最终回答，其余进中间过程）。 */
function applyMessage(group: PiTurnGroup, m: PiMessage): void {
	if (m.role === "assistant" && hasText(m)) {
		if (group.finalAssistant) group.processMessages.push(group.finalAssistant);
		group.finalAssistant = m;
	} else {
		group.processMessages.push(m);
	}
	if (isToolCall(m)) group.toolCallCount += 1;
	group.processMessageCount = group.processMessages.length;
}

/**
 * 把消息流折叠为回合组：每条 user 消息开启新回合；
 * 中间 assistant/tool 消息归入 process（最终一条有文本的 assistant 单独显示）。
 *
 * 首条 user 之前的非 user 消息属于「分页窗口落在回合中间」的残段：它们并入随后的第一个
 * 回合（作为该回合的中间过程），而不是单独成组——否则渲染顺序会让 Process Details 出现在
 * 提问气泡之上。整个窗口都没有 user 消息时才保留一个无 prompt 的组。
 */
export function buildTurnGroups(messages: PiMessage[]): PiTurnGroup[] {
	const groups: PiTurnGroup[] = [];
	let current: PiTurnGroup | null = null;
	/** 首条 user 之前的非 user 消息（并入随后回合） */
	let leading: PiMessage[] = [];

	for (const m of messages) {
		if (m.role === "user") {
			if (current) groups.push(current);
			current = openGroup(m);
			if (leading.length > 0) {
				for (const lead of leading) applyMessage(current, lead);
				leading = [];
			}
			continue;
		}
		if (!current) {
			leading.push(m);
			continue;
		}
		applyMessage(current, m);
	}
	if (current) {
		groups.push(current);
	} else if (leading.length > 0) {
		// 整个窗口没有任何 user 消息（分页落在回合中间）：仍然按普通回合归类，
		// 使尾部有文本的 assistant 仍然是最终回答。
		const orphan = openGroup(null);
		for (const lead of leading) applyMessage(orphan, lead);
		groups.push(orphan);
	}
	return groups;
}
