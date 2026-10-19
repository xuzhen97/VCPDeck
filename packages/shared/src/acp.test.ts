import { describe, expect, it } from "vitest";
import { AcpProtocolError, parseAcpSessionUpdate } from "./acp.js";

describe("parseAcpSessionUpdate", () => {
	it("映射 agent_message_chunk", () => {
		expect(
			parseAcpSessionUpdate({
				sessionUpdate: "agent_message_chunk",
				messageId: "m1",
				content: { type: "text", text: "hello" },
			}),
		).toEqual({ type: "agent.message.delta", messageId: "m1", text: "hello" });
	});

	it("未知 variant 返回 null，不杀会话", () => {
		expect(parseAcpSessionUpdate({ sessionUpdate: "future_variant" })).toBeNull();
	});

	it("映射 tool_call 与文件位置", () => {
		expect(
			parseAcpSessionUpdate({
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "读取文件",
				kind: "read",
				status: "pending",
				locations: [{ path: "/repo/src/a.ts", line: 3 }],
			}),
		).toEqual({
			type: "tool.started",
			toolCallId: "call-1",
			title: "读取文件",
			kind: "read",
			status: "pending",
			locations: [{ path: "/repo/src/a.ts", line: 3 }],
		});
	});

	it("已知 variant 的非法 content 抛 ACP_PROTOCOL_INVALID", () => {
		expect(() =>
			parseAcpSessionUpdate({
				sessionUpdate: "agent_message_chunk",
				messageId: "m1",
				content: { type: "text" },
			}),
		).toThrow(AcpProtocolError);
	});
});
