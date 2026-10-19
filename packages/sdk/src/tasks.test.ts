import { describe, expect, it, vi } from "vitest";
import { VcpDeckApiError } from "./client.js";
import { createTasksApi } from "./tasks.js";

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
});
