import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import type { TaskInfo } from "@vcpdeck/shared";
import { A2aService } from "./a2a.service.js";

const ACTOR: ActorContext = {
	identityId: "i1",
	displayName: "Admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "cli",
	requestId: "req-1",
};

function taskInfo(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
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
		...overrides,
	};
}

function makeService() {
	const tasks = {
		createTask: vi.fn(async () => taskInfo()),
		appendUserTurn: vi.fn(async () => ({})),
		getTask: vi.fn(async () => taskInfo()),
		listTasks: vi.fn(async () => ({
			data: [taskInfo()],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		})),
		cancelTask: vi.fn(async () => taskInfo({ state: "canceled" })),
		transition: vi.fn(async () => taskInfo({ state: "working" })),
	};
	const agents = {
		agentCard: vi.fn(async () => ({ name: "hub" })),
	};
	return {
		tasks,
		agents,
		service: new A2aService(tasks as never, agents as never),
	};
}

describe("A2aService", () => {
	it("GetTask 返回 status.state 而不是内部 state", async () => {
		const { service } = makeService();
		const response = await service.rpc(
			{ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: "t1" } },
			ACTOR,
		);
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: 2,
			result: {
				id: "t1",
				status: { state: "TASK_STATE_SUBMITTED" },
			},
		});
		if ("result" in response) {
			expect(response.result).not.toHaveProperty("state");
		}
	});

	it("SendMessage 新任务使用 metadata.agentId 创建 Task", async () => {
		const { service, tasks } = makeService();
		await service.rpc(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "SendMessage",
				params: {
					message: { messageId: "m1", role: "user", parts: [{ text: "x" }] },
					metadata: {
						agentId: "reviewer",
						intent: "修复",
						acceptanceCriteria: ["test"],
					},
				},
			},
			ACTOR,
		);
		expect(tasks.createTask).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "reviewer", intent: "修复" }),
			ACTOR,
		);
	});

	it("ListTasks 把 wire status 映射回内部 state", async () => {
		const { service, tasks } = makeService();
		await service.rpc(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "ListTasks",
				params: { status: "TASK_STATE_WORKING", pageSize: 10 },
			},
			ACTOR,
		);
		expect(tasks.listTasks).toHaveBeenCalledWith(
			expect.objectContaining({ state: "working" }),
			1,
			10,
		);
	});
});
