import { afterEach, describe, expect, it, vi } from "vitest";
import { VcpDeckApiError } from "./client.js";
import { createTasksApi } from "./tasks.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function fakeClient() {
	const request = vi.fn().mockResolvedValue({
		jsonrpc: "2.0",
		id: "1",
		result: { id: "t1", status: { state: "TASK_STATE_SUBMITTED" } },
	});
	return { request, api: createTasksApi({ request } as never, () => "1") };
}

describe("createTasksApi", () => {
	it("sendMessage 发 JSON-RPC SendMessage", async () => {
		const { request, api } = fakeClient();
		await api.sendMessage({
			message: { messageId: "m1", role: "user", parts: [{ text: "hello" }] },
			metadata: { agentId: "reviewer", intent: "x" },
		});
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/a2a",
			expect.objectContaining({
				jsonrpc: "2.0",
				id: "1",
				method: "SendMessage",
			}),
			undefined,
		);
	});

	it("JSON-RPC error 映射为 VcpDeckApiError", async () => {
		const request = vi.fn().mockResolvedValue({
			jsonrpc: "2.0",
			id: "1",
			error: { code: -32000, message: "not found", data: { code: "TASK_NOT_FOUND" } },
		});
		const api = createTasksApi({ request } as never, () => "1");
		await expect(api.get("t1")).rejects.toBeInstanceOf(VcpDeckApiError);
	});

	it("非安全上下文（无 crypto.randomUUID）下 list 仍能发出请求", async () => {
		// 明文 HTTP 部署时前端拿不到 crypto.randomUUID；默认 id 生成不能因此抛错，
		// 否则 Agent 任务页会整体落到「无法加载 Agent 任务」。
		const { getRandomValues } = globalThis.crypto;
		vi.stubGlobal("crypto", {
			getRandomValues: getRandomValues.bind(globalThis.crypto),
		});
		const request = vi.fn().mockResolvedValue({
			jsonrpc: "2.0",
			id: "x",
			result: { tasks: [], nextPageToken: "", pageSize: 20, totalSize: 0 },
		});
		const api = createTasksApi({ request } as never);
		await api.list({ pageSize: 20 });
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/a2a",
			expect.objectContaining({ method: "ListTasks" }),
			undefined,
		);
	});
});
