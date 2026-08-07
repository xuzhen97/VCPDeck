import { describe, expect, it } from "vitest";
import { buildTurnGroups } from "./turn-groups.js";
import type { PiMessage } from "@vcpdeck/shared";

const user = (id: string, text: string): PiMessage => ({
	id,
	role: "user",
	content: [{ type: "text", text }],
});
const assistant = (id: string, text: string): PiMessage => ({
	id,
	role: "assistant",
	content: [{ type: "text", text }],
});
const toolCall = (id: string, name: string): PiMessage => ({
	id,
	role: "assistant",
	content: [{ type: "tool_call", toolCallId: id, toolName: name, input: {} }],
});
const toolResult = (id: string): PiMessage => ({
	id,
	role: "tool_result",
	toolCallId: id,
	content: [{ type: "text", text: "ok" }],
});

describe("buildTurnGroups", () => {
	it("把中间消息折叠为 Process Details，最终回答单独显示", () => {
		const groups = buildTurnGroups([
			user("u1", "fix the bug"),
			toolCall("t1", "bash"),
			toolResult("t1"),
			assistant("a1", "middle text"),
			toolCall("t2", "edit"),
			toolResult("t2"),
			assistant("a2", "done!"),
		]);
		expect(groups).toHaveLength(1);
		const g = groups[0]!;
		expect(g.userMessage?.id).toBe("u1");
		expect(g.processMessageCount).toBe(5);
		expect(g.toolCallCount).toBe(2);
		expect(g.finalAssistant?.id).toBe("a2");
	});

	it("多回合各自成组", () => {
		const groups = buildTurnGroups([
			user("u1", "q1"),
			assistant("a1", "ans1"),
			user("u2", "q2"),
			assistant("a2", "ans2"),
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.finalAssistant?.id).toBe("a1");
		expect(groups[1]?.finalAssistant?.id).toBe("a2");
	});

	it("纯工具回合没有 final assistant", () => {
		const groups = buildTurnGroups([
			user("u1", "run"),
			toolCall("t1", "bash"),
			toolResult("t1"),
		]);
		expect(groups[0]?.finalAssistant).toBeNull();
		expect(groups[0]?.toolCallCount).toBe(1);
	});

	it("空消息返回空数组", () => {
		expect(buildTurnGroups([])).toEqual([]);
	});

	it("孤立 process 消息（无 user 前缀）不丢", () => {
		const groups = buildTurnGroups([toolCall("t1", "bash"), assistant("a1", "final")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.userMessage).toBeNull();
		expect(groups[0]?.finalAssistant?.id).toBe("a1");
	});
});
