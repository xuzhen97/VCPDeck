import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@vcpdeck/shared";
import type { PrismaService } from "../prisma/prisma.service.js";
import { TaskService } from "./task.service.js";

const ACTOR: ActorContext = {
	identityId: "i1",
	displayName: "Admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "cli",
	requestId: "req-1",
};

function makeHarness() {
	const tasks = new Map<string, Record<string, unknown>>();
	const turns = new Map<string, Array<Record<string, unknown>>>();
	const attempts = new Map<string, Record<string, unknown>>();
	let turnSeq = 0;
	const registry = {
		resolve: vi.fn(async (agentId: string) => ({
			id: "ap-1",
			agentId,
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
		task: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const row = {
					...data,
					createdAt: new Date("2026-10-18T00:00:00.000Z"),
					updatedAt: new Date("2026-10-18T00:00:00.000Z"),
				};
				tasks.set(String(data.id), row);
				return row;
			}),
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				const row = tasks.get(where.id);
				if (!row) return null;
				return { ...row, artifacts: [] };
			}),
			update: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { id: string };
					data: Record<string, unknown>;
				}) => {
					const row = {
						...(tasks.get(where.id) ?? {}),
						...data,
						updatedAt: new Date("2026-10-18T00:01:00.000Z"),
					};
					tasks.set(where.id, row);
					return { ...row, artifacts: [] };
				},
			),
			findMany: vi.fn(async () => [...tasks.values()].map((row) => ({ ...row, artifacts: [] }))),
			count: vi.fn(async () => tasks.size),
		},
		taskTurn: {
			findFirst: vi.fn(async ({ where }: { where: { taskId: string } }) => {
				const list = turns.get(where.taskId) ?? [];
				return list.at(-1) ?? null;
			}),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const list = turns.get(String(data.taskId)) ?? [];
				list.push(data);
				turns.set(String(data.taskId), list);
				turnSeq += 1;
				return data;
			}),
		},
		taskAttempt: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				attempts.set(String(data.id), data);
				return data;
			}),
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
				const row = { ...(attempts.get(where.id) ?? {}), ...data };
				attempts.set(where.id, row);
				return row;
			}),
		},
	} as unknown as PrismaService;
	const service = TaskService.withDeps({
		prisma,
		registry: registry as never,
		now: () => new Date("2026-10-18T00:00:00.000Z"),
	});
	return { service, prisma, registry, tasks, turns, turnSeq: () => turnSeq };
}

async function createTask(service: TaskService) {
	return service.createTask(
		{
			agentId: "reviewer",
			intent: "修复失败测试",
			acceptanceCriteria: ["test 通过"],
			constraints: {},
		},
		ACTOR,
	);
}

function msg(messageId: string, text: string) {
	return { messageId, role: "user" as const, parts: [{ text }] };
}

describe("TaskService", () => {
	it("input-required 后允许第二个 Turn，终态后拒绝", async () => {
		const { service } = makeHarness();
		const task = await createTask(service);
		expect(task.state).toBe("submitted");
		await service.appendUserTurn(task.id, msg("m1", "第一轮"), ACTOR);
		await service.transition(task.id, "working");
		await service.transition(task.id, "input-required");
		await service.appendUserTurn(task.id, msg("m2", "第二轮"), ACTOR);
		await service.transition(task.id, "working");
		await service.transition(task.id, "completed");
		await expect(
			service.appendUserTurn(task.id, msg("m3", "第三轮"), ACTOR),
		).rejects.toMatchObject({ code: "TASK_TERMINAL" });
	});

	it("working 时拒绝并发 Turn", async () => {
		const { service } = makeHarness();
		const task = await createTask(service);
		await service.appendUserTurn(task.id, msg("m1", "第一轮"), ACTOR);
		await service.transition(task.id, "working");
		await expect(
			service.appendUserTurn(task.id, msg("m2", "第二轮"), ACTOR),
		).rejects.toMatchObject({ code: "TASK_BUSY" });
	});

	it("只存摘要与 hash，不存完整 prompt", async () => {
		const { service, turns } = makeHarness();
		const task = await createTask(service);
		const secret = `FULL_SECRET_${"x".repeat(500)}`;
		await service.appendUserTurn(task.id, msg("m1", secret), ACTOR);
		const stored = turns.get(task.id)?.[0] as Record<string, unknown>;
		expect(stored.summary).not.toBe(secret);
		expect(String(stored.summary).length).toBeLessThanOrEqual(200);
		expect(String(stored.contentHash)).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(stored)).not.toContain(secret);
	});

	it("非法状态转移被拒绝", async () => {
		const { service } = makeHarness();
		const task = await createTask(service);
		await expect(service.transition(task.id, "completed")).rejects.toMatchObject({
			code: "INVALID_TASK_TRANSITION",
		});
	});

	it("cancel 终态幂等", async () => {
		const { service } = makeHarness();
		const task = await createTask(service);
		const cancelled = await service.cancelTask(task.id, ACTOR);
		expect(cancelled.state).toBe("canceled");
		expect((await service.cancelTask(task.id, ACTOR)).state).toBe("canceled");
	});
});
