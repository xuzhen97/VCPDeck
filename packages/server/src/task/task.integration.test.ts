import { describe, expect, it } from "vitest";
import type { A2aJsonRpcResponse } from "@vcpdeck/shared";
import { makeTaskHarness, userMessage } from "./integration-helpers.js";

async function waitFor(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition not met before timeout");
}

function taskOf(response: A2aJsonRpcResponse) {
	if (!("result" in response)) throw new Error(JSON.stringify(response));
	return response.result as {
		id: string;
		status: { state: string };
	};
}

describe("Task 集成回路", () => {
	it("permission 往返后 completed，审计链可查", async () => {
		const h = makeTaskHarness();
		const created = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: {
					message: userMessage("review this"),
					metadata: {
						agentId: "reviewer",
						intent: "review",
						acceptanceCriteria: ["tests pass"],
					},
				},
			},
			h.actor,
		);
		const task = taskOf(created);
		expect(task.status.state).toBe("TASK_STATE_WORKING");

		await waitFor(async () => {
			const current = await h.tasks.getTask(task.id);
			return current.state === "input-required";
		});
		expect(h.sent.map((command) => command.action)).toEqual(["start", "prompt"]);

		const premature = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "SendMessage",
				params: { message: userMessage("are you there?", task.id) },
			},
			h.actor,
		);
		expect(premature).toMatchObject({
			error: { code: -32000, message: expect.stringContaining("permission") },
		});

		const answered = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "SendMessage",
				params: {
					message: userMessage("allow", task.id),
					metadata: {
						extensions: {
							"https://vcpdeck.dev/a2a/extensions/acp-permission/v1": {
								requestId: "perm-1",
								optionId: "allow-once",
							},
						},
					},
				},
			},
			h.actor,
		);
		expect(taskOf(answered).status.state).toBe("TASK_STATE_WORKING");

		h.finishPrompt("end_turn");
		await waitFor(async () => (await h.tasks.getTask(task.id)).state === "completed");

		const names = h.events.map((event) => event.event);
		expect(names).toEqual(
			expect.arrayContaining([
				"task.created",
				"turn.started",
				"task.routed",
				"permission.requested",
				"permission.decided",
				"turn.completed",
				"task.completed",
			]),
		);
		const fetched = await h.a2a.rpc(
			{ jsonrpc: "2.0", id: 3, method: "GetTask", params: { id: task.id } },
			h.actor,
		);
		expect(taskOf(fetched).status.state).toBe("TASK_STATE_COMPLETED");
		expect("state" in (taskOf(fetched) as object)).toBe(false);

		const afterTerminal = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 4,
				method: "SendMessage",
				params: { message: userMessage("again", task.id) },
			},
			h.actor,
		);
		expect(afterTerminal).toMatchObject({
			error: { data: { code: "TASK_TERMINAL" } },
		});
	});

	it("CancelTask 发 cancel 命令并收敛 canceled", async () => {
		const h = makeTaskHarness();
		const created = taskOf(
			await h.a2a.rpc(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "SendMessage",
					params: {
						message: userMessage("long task"),
						metadata: { agentId: "reviewer", intent: "review" },
					},
				},
				h.actor,
			),
		);
		await waitFor(async () => {
			const current = await h.tasks.getTask(created.id);
			return current.state === "input-required";
		});

		const canceled = await h.a2a.rpc(
			{ jsonrpc: "2.0", id: 2, method: "CancelTask", params: { id: created.id } },
			h.actor,
		);
		expect(taskOf(canceled).status.state).toBe("TASK_STATE_CANCELED");
		await waitFor(() => h.sent.some((command) => command.action === "cancel"));
		await waitFor(async () => {
			const current = await h.tasks.getTask(created.id);
			return current.state === "canceled";
		});
	});

	it("Client 离线时 SendMessage 返回稳定错误并落 failed", async () => {
		const h = makeTaskHarness();
		h.setOnline(false);
		const response = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: {
					message: userMessage("offline"),
					metadata: { agentId: "reviewer", intent: "review" },
				},
			},
			h.actor,
		);
		expect(response).toMatchObject({
			error: { data: { code: "TASK_CLIENT_OFFLINE" } },
		});
		const list = await h.tasks.listTasks({}, 1, 10);
		expect(list.data[0]?.state).toBe("failed");
	});

	it("Client 离线收敛未完成 Task 为 failed", async () => {
		const h = makeTaskHarness();
		const created = taskOf(
			await h.a2a.rpc(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "SendMessage",
					params: {
						message: userMessage("long task"),
						metadata: { agentId: "reviewer", intent: "review" },
					},
				},
				h.actor,
			),
		);
		await waitFor(async () => {
			const current = await h.tasks.getTask(created.id);
			return current.state === "input-required";
		});
		await h.dispatch.failByClientId("client-1");
		const failed = await h.tasks.getTask(created.id);
		expect(failed.state).toBe("failed");
		expect(failed.error?.code).toBe("TASK_CLIENT_DISCONNECTED");
		expect(h.events.map((event) => event.event)).toContain("task.failed");
	});

	it("cli adapter 未实现时失败关闭", async () => {
		const h = makeTaskHarness({ adapter: "cli" });
		const response = await h.a2a.rpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: {
					message: userMessage("cli"),
					metadata: { agentId: "reviewer", intent: "review" },
				},
			},
			h.actor,
		);
		expect(response).toMatchObject({
			error: { data: { code: "TASK_ADAPTER_UNSUPPORTED" } },
		});
		const list = await h.tasks.listTasks({}, 1, 10);
		expect(list.data[0]?.state).toBe("failed");
	});
});
