import { describe, expect, it } from "vitest";
import {
	ACP_PERMISSION_EXTENSION_URI,
	A2aProtocolError,
	parseA2aJsonRpcRequest,
	parseAgentPlacementInput,
	toA2aTask,
	type TaskInfo,
} from "./a2a.js";

function validSendMessage() {
	return {
		jsonrpc: "2.0",
		id: "req-1",
		method: "SendMessage",
		params: {
			message: {
				messageId: "m1",
				role: "user",
				parts: [{ text: "修复失败测试" }],
			},
			metadata: {
				agentId: "reviewer",
				intent: "修复失败测试",
				acceptanceCriteria: ["pnpm test 通过"],
				constraints: { allowedPaths: ["src/"] },
			},
		},
	};
}

describe("parseA2aJsonRpcRequest", () => {
	it("接受带 intent/acceptance 的 SendMessage", () => {
		const parsed = parseA2aJsonRpcRequest(validSendMessage());
		expect(parsed.method).toBe("SendMessage");
		if (parsed.method !== "SendMessage") throw new Error("unexpected method");
		expect(parsed.params.message.parts[0]?.text).toBe("修复失败测试");
	});

	it("接受声明过的 ACP permission extension", () => {
		const parsed = parseA2aJsonRpcRequest({
			jsonrpc: "2.0",
			id: "req-2",
			method: "SendMessage",
			params: {
				message: {
					messageId: "m1",
					role: "user",
					parts: [{ text: "继续" }],
					taskId: "t1",
				},
				metadata: {
					extensions: {
						[ACP_PERMISSION_EXTENSION_URI]: {
							requestId: "perm-1",
							optionId: "allow-once",
						},
					},
				},
			},
		});
		expect(parsed.method).toBe("SendMessage");
	});

	it("拒绝调用方提交 command/args/env", () => {
		expect(() =>
			parseA2aJsonRpcRequest({
				jsonrpc: "2.0",
				id: "req-3",
				method: "SendMessage",
				params: {
					message: { messageId: "m1", role: "user", parts: [{ text: "x" }] },
					metadata: { agentId: "a", command: "rm -rf /" },
				},
			}),
		).toThrow(A2aProtocolError);
	});

	it("拒绝未知 JSON-RPC 方法", () => {
		expect(() =>
			parseA2aJsonRpcRequest({
				jsonrpc: "2.0",
				id: "req-4",
				method: "DeleteEverything",
				params: {},
			}),
		).toThrow(A2aProtocolError);
	});

	it("拒绝超过上限的消息正文", () => {
		expect(() =>
			parseA2aJsonRpcRequest({
				jsonrpc: "2.0",
				id: "req-5",
				method: "SendMessage",
				params: {
					message: {
						messageId: "m1",
						role: "user",
						parts: [{ text: "x".repeat(64 * 1024 + 1) }],
					},
				},
			}),
		).toThrow(A2aProtocolError);
	});
});

describe("toA2aTask", () => {
	it("输出 status.state 与 TASK_STATE_*，不暴露内部小写 state", () => {
		const info: TaskInfo = {
			id: "t1",
			contextId: "c1",
			state: "submitted",
			agentId: "reviewer",
			intent: "x",
			acceptanceCriteria: [],
			constraints: {},
			artifacts: [],
			createdAt: "2026-10-18T00:00:00.000Z",
			updatedAt: "2026-10-18T00:00:00.000Z",
		};
		const task = toA2aTask(info);
		expect(task.status.state).toBe("TASK_STATE_SUBMITTED");
		expect(task).not.toHaveProperty("state");
		expect(task.metadata?.vcpdeck.agentId).toBe("reviewer");
	});
});

describe("parseAgentPlacementInput", () => {
	it("接受受控 placement 输入", () => {
		expect(
			parseAgentPlacementInput({
				agentId: "reviewer",
				name: "Code Reviewer",
				adapter: "acp",
				clientId: "c1",
				command: "dsh",
				args: ["--profile", "acp"],
				cwd: "/repo",
				workspaceRoots: ["/repo"],
				skills: ["review"],
			}),
		).toMatchObject({ agentId: "reviewer", adapter: "acp" });
	});

	it("拒绝未知字段与非法 agentId", () => {
		expect(() =>
			parseAgentPlacementInput({
				agentId: "Reviewer",
				name: "x",
				adapter: "acp",
				clientId: "c1",
				command: "dsh",
				args: [],
				cwd: "/repo",
				workspaceRoots: [],
				env: { SECRET: "x" },
			}),
		).toThrow(A2aProtocolError);
	});
});
