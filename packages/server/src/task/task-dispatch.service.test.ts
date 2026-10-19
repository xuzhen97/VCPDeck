import { describe, expect, it, vi } from "vitest";
import type { TaskClientCommand, TaskClientEvent } from "@vcpdeck/shared";
import { TaskDispatchService } from "./task-dispatch.service.js";

function harness() {
	const sent: Array<{ socketId: string; command: TaskClientCommand }> = [];
	const tasks = {
		getTask: vi.fn(async () => ({
			id: "t1",
			agentPlacementId: "ap-1",
			state: "submitted",
		})),
		createAttempt: vi.fn(async () => ({ attemptId: "a1" })),
		transition: vi.fn(async (_id: string, state: string) => ({ state })),
		finishAttempt: vi.fn(async () => undefined),
	};
	const registry = {
		resolveById: vi.fn(async () => ({
			id: "ap-1",
			agentId: "reviewer",
			adapter: "acp" as const,
			clientId: "c1",
			command: "dsh",
			args: ["--profile", "acp"],
			cwd: "/repo",
			workspaceRoots: ["/repo"],
			skills: [],
		})),
	};
	const prisma = {
		client: {
			findUnique: vi.fn(async () => ({ socketId: "s1", online: true })),
		},
	};
	const service = TaskDispatchService.withDeps({
		prisma: prisma as never,
		tasks: tasks as never,
		registry: registry as never,
		send: (socketId, command) => sent.push({ socketId, command }),
	});
	return { service, sent, tasks, registry, prisma };
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TaskDispatchService", () => {
	it("start 只向 placement 的 client socket 发受控命令", async () => {
		const h = harness();
		const started = h.service.start("t1", "hello");
		await tick();
		expect(h.sent[0]).toMatchObject({
			socketId: "s1",
			command: {
				action: "start",
				taskId: "t1",
				command: "dsh",
				cwd: "/repo",
			},
		});
		const start = h.sent[0]!.command;
		h.service.handleCommandResult("s1", {
			requestId: start.requestId,
			ok: true,
			sessionId: "s1",
		});
		await started;
		await tick();
		expect(h.sent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					command: expect.objectContaining({ action: "prompt", text: "hello" }),
				}),
			]),
		);
	});

	it("permission.requested 事件把 Task 推入 input-required", async () => {
		const h = harness();
		const event: TaskClientEvent = {
			taskId: "t1",
			attemptId: "a1",
			seq: 1,
			event: {
				type: "permission.requested",
				requestId: "p1",
				toolCallId: "call-1",
				options: [],
			},
		};
		// 先建立 runtime
		const started = h.service.start("t1", "hello");
		await tick();
		const start = h.sent[0]!.command;
		h.service.handleCommandResult("s1", {
			requestId: start.requestId,
			ok: true,
			sessionId: "s1",
		});
		await started;
		await h.service.handleEvent("s1", event);
		expect(h.tasks.transition).toHaveBeenCalledWith("t1", "input-required");
	});
});
