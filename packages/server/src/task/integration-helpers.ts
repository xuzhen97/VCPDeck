/**
 * Task 集成测试替身：内存 Task 表 + fake ACP Client。
 *
 * 只模拟协议边界，不模拟真实文件系统或 ACP 进程；用于验证
 * Task → dispatch → Client command/event → Task 状态与审计的关联。
 */
import { randomUUID } from "node:crypto";
import type {
	A2aMessage,
	ActorContext,
	TaskClientCommand,
	TaskCommandResult,
	TaskInfo,
} from "@vcpdeck/shared";
import type { AgentRegistryService } from "../agent-registry/agent-registry.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import { A2aService } from "../a2a/a2a.service.js";
import type { TaskAuditService } from "./task-audit.service.js";
import {
	TaskDispatchService,
	type TaskDispatchDeps,
} from "./task-dispatch.service.js";
import { TaskService, type CreateTaskInput } from "./task.service.js";

export interface HarnessAuditEvent {
	id: number;
	taskId: string;
	source: string;
	event: string;
	fidelity: string;
	data?: unknown;
	at: string;
}

export interface TaskHarness {
	tasks: TaskService;
	dispatch: TaskDispatchService;
	a2a: A2aService;
	audit: { record: TaskAuditService["record"]; events: HarnessAuditEvent[] };
	events: HarnessAuditEvent[];
	actor: ActorContext;
	socketId: string;
	sent: TaskClientCommand[];
	createTask(overrides?: Partial<CreateTaskInput>): Promise<TaskInfo>;
	finishPrompt(stopReason?: string): void;
	setOnline(online: boolean): void;
}

export function makeTaskHarness(options: { adapter?: "acp" | "cli" } = {}): TaskHarness {
	let tick = 0;
	const now = () => new Date(1_700_000_000_000 + tick++ * 1_000);
	const socketId = "socket-1";
	let online = true;
	const actor: ActorContext = {
		identityId: "id-1",
		displayName: "tester",
		isAdmin: false,
		credentialId: null,
		sessionId: null,
		source: "cli",
		requestId: "req-1",
	};

	const placement = {
		id: "placement-1",
		agentId: "reviewer",
		name: "Reviewer",
		adapter: options.adapter ?? ("acp" as const),
		clientId: "client-1",
		command: "node",
		args: ["fake-agent.mjs"],
		cwd: "/workspace",
		workspaceRoots: ["/workspace"],
		skills: [],
	};

	const taskRows = new Map<string, Record<string, unknown>>();
	const turns: Array<Record<string, unknown>> = [];
	const attempts = new Map<string, Record<string, unknown>>();

	const withRelations = (row: Record<string, unknown>) => ({
		...row,
		agentPlacement: { agentId: placement.agentId },
		artifacts: [] as Array<Record<string, unknown>>,
	});

	const prisma = {
		task: {
			async findUnique({ where }: { where: { id: string } }) {
				const row = taskRows.get(where.id);
				return row ? withRelations(row) : null;
			},
			async create({ data }: { data: Record<string, unknown> }) {
				const at = now();
				const row = {
					...data,
					createdAt: at,
					updatedAt: at,
					completedAt: null,
					verdict: null,
					errorCode: data.errorCode ?? null,
					errorMessage: data.errorMessage ?? null,
				};
				taskRows.set(data.id as string, row);
				return withRelations(row);
			},
			async update({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) {
				const row = taskRows.get(where.id);
				if (!row) throw new Error("task not found");
				Object.assign(row, data, { updatedAt: now() });
				return withRelations(row);
			},
			async findMany() {
				return [...taskRows.values()].map(withRelations);
			},
			async count() {
				return taskRows.size;
			},
		},
		taskTurn: {
			async findFirst({ where }: { where: { taskId: string } }) {
				const matched = turns.filter((turn) => turn.taskId === where.taskId);
				return matched.at(-1) ?? null;
			},
			async create({ data }: { data: Record<string, unknown> }) {
				turns.push(data);
				return data;
			},
		},
		taskAttempt: {
			async create({ data }: { data: Record<string, unknown> }) {
				attempts.set(data.id as string, data);
				return data;
			},
			async update({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) {
				const row = attempts.get(where.id);
				if (!row) throw new Error("attempt not found");
				Object.assign(row, data);
				return row;
			},
		},
		client: {
			async findUnique() {
				return { socketId: online ? socketId : null, online };
			},
		},
	} as unknown as PrismaService;

	const registry = {
		resolve: async () => placement,
		resolveById: async () => placement,
	} as unknown as AgentRegistryService;

	const events: HarnessAuditEvent[] = [];
	const audit = {
		record: (async (input: {
			taskId: string;
			source: string;
			event: string;
			fidelity: string;
			data?: unknown;
		}) => {
			events.push({
				...input,
				id: events.length + 1,
				at: now().toISOString(),
			});
		}) as TaskAuditService["record"],
		events,
	};

	const tasks = TaskService.withDeps({ prisma, registry, now });
	const sent: TaskClientCommand[] = [];
	let pendingPrompt: TaskClientCommand | null = null;
	let promptCount = 0;
	const permissionRequestId = "perm-1";
	let dispatch: TaskDispatchService;

	const resolveCommand = (
		command: TaskClientCommand,
		result: Omit<TaskCommandResult, "requestId" | "ok"> & { ok?: boolean } = {},
	) => {
		dispatch.handleCommandResult(socketId, {
			requestId: command.requestId,
			ok: result.ok ?? true,
			...result,
		});
	};

	const handle = (command: TaskClientCommand): void => {
		if (command.action === "start" || command.action === "close") {
			queueMicrotask(() => resolveCommand(command));
			return;
		}
		if (command.action === "permission") {
			queueMicrotask(async () => {
				await dispatch.handleEvent(socketId, {
					taskId: command.taskId,
					attemptId: command.attemptId,
					seq: 2,
					event: {
						type: "permission.resolved",
						requestId: command.permissionRequestId,
						outcome:
							command.outcome.outcome === "selected" ? "selected" : "cancelled",
						...(command.outcome.outcome === "selected"
							? { optionId: command.outcome.optionId }
							: {}),
					},
				});
				resolveCommand(command);
			});
			return;
		}
		if (command.action === "cancel") {
			if (pendingPrompt) {
				const prompt = pendingPrompt;
				pendingPrompt = null;
				queueMicrotask(() =>
					resolveCommand(prompt, { stopReason: "cancelled" }),
				);
			}
			queueMicrotask(() => resolveCommand(command));
			return;
		}
		if (command.action === "prompt") {
			pendingPrompt = command;
			promptCount += 1;
			if (promptCount === 1) {
				queueMicrotask(async () => {
					await dispatch.handleEvent(socketId, {
						taskId: command.taskId,
						attemptId: command.attemptId,
						seq: 1,
						event: {
							type: "permission.requested",
							requestId: permissionRequestId,
							toolCallId: "tool-1",
							title: "Write file",
							options: [
								{
									optionId: "allow-once",
									name: "Allow once",
									kind: "allow_once",
								},
							],
						},
					});
				});
				return;
			}
			queueMicrotask(() => {
				if (!pendingPrompt) return;
				const prompt = pendingPrompt;
				pendingPrompt = null;
				resolveCommand(prompt, { stopReason: "end_turn" });
			});
		}
	};

	const send = (targetSocket: string, command: TaskClientCommand): void => {
		if (targetSocket !== socketId) return;
		sent.push(command);
		queueMicrotask(() => handle(command));
	};

	dispatch = TaskDispatchService.withDeps({
		prisma,
		tasks,
		registry,
		send,
		audit,
	} satisfies TaskDispatchDeps);
	const a2a = A2aService.withDeps(tasks, registry, dispatch, audit);

	return {
		tasks,
		dispatch,
		a2a,
		audit,
		events,
		actor,
		socketId,
		sent,
		async createTask(overrides = {}) {
			return tasks.createTask(
				{
					agentId: "reviewer",
					intent: "review",
					acceptanceCriteria: [],
					constraints: {},
					...overrides,
				},
				actor,
			);
		},
		finishPrompt(stopReason = "end_turn") {
			if (!pendingPrompt) throw new Error("No pending prompt");
			const prompt = pendingPrompt;
			pendingPrompt = null;
			resolveCommand(prompt, { stopReason });
		},
		setOnline(value: boolean) {
			online = value;
		},
	};
}

export function userMessage(
	text: string,
	taskId?: string,
): A2aMessage {
	return {
		messageId: `msg-${randomUUID().slice(0, 8)}`,
		role: "user",
		parts: [{ text }],
		...(taskId ? { taskId } : {}),
	};
}
