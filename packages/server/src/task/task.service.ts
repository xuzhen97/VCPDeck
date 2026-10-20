import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
	type A2aMessage,
	type A2aTaskConstraints,
	type ActorContext,
	type PaginatedResult,
	type TaskInfo,
	type TaskLifecycleState,
} from "@vcpdeck/shared";
import type { Prisma } from "../../generated/client/index.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { AgentRegistryService } from "../agent-registry/agent-registry.service.js";

export type TaskServiceErrorCode =
	| "TASK_NOT_FOUND"
	| "TASK_TERMINAL"
	| "TASK_BUSY"
	| "INVALID_TASK_TRANSITION"
	| "TASK_NOT_CANCELABLE";

/** Task 域稳定错误；Controller 原样映射 code 与 statusCode。 */
export class TaskServiceError extends Error {
	constructor(
		readonly code: TaskServiceErrorCode,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "TaskServiceError";
	}
}

export interface CreateTaskInput {
	agentId: string;
	intent: string;
	acceptanceCriteria: string[];
	constraints: A2aTaskConstraints;
	contextId?: string;
}

export interface TaskListFilter {
	contextId?: string;
	agentId?: string;
	state?: TaskLifecycleState;
}

export interface TaskTurnInfo {
	id: string;
	taskId: string;
	seq: number;
	direction: "inbound" | "outbound";
	messageId: string;
	summary: string | null;
	content: string | null;
	contentHash: string;
	createdAt: string;
}

export interface TaskServiceDeps {
	prisma: PrismaService;
	registry: Pick<AgentRegistryService, "resolve">;
	now?: () => Date;
}

interface TaskRow {
	id: string;
	contextId: string;
	state: string;
	agentPlacementId: string;
	intent: string;
	acceptanceCriteria: string;
	constraints: string;
	verdict: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
	agentPlacement?: { agentId: string };
	artifacts?: Array<{
		id: string;
		name: string;
		mimeType: string;
		uri: string;
		sha256: string | null;
		size: number | null;
	}>;
}

const TERMINAL_STATES: readonly TaskLifecycleState[] = [
	"completed",
	"canceled",
	"rejected",
	"failed",
];

const ALLOWED: Record<TaskLifecycleState, readonly TaskLifecycleState[]> = {
	submitted: ["working", "canceled", "failed", "rejected"],
	working: ["input-required", "auth-required", "completed", "canceled", "failed"],
	"input-required": ["working", "canceled", "failed"],
	"auth-required": ["working", "canceled", "failed"],
	completed: [],
	canceled: [],
	rejected: [],
	failed: [],
};

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function taskId(): string {
	return `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function turnId(): string {
	return `turn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function attemptId(): string {
	return `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function toTaskInfo(row: TaskRow): TaskInfo {
	return {
		id: row.id,
		contextId: row.contextId,
		state: row.state as TaskLifecycleState,
		agentId: row.agentPlacement?.agentId ?? "",
		agentPlacementId: row.agentPlacementId,
		intent: row.intent,
		acceptanceCriteria: parseJson<string[]>(row.acceptanceCriteria, []),
		constraints: parseJson<A2aTaskConstraints>(row.constraints, {}),
		artifacts: (row.artifacts ?? []).map((artifact) => ({
			id: artifact.id,
			name: artifact.name,
			mimeType: artifact.mimeType,
			uri: artifact.uri,
			...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
			...(artifact.size !== null ? { size: artifact.size } : {}),
		})),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		verdict: (row.verdict as TaskInfo["verdict"]) ?? null,
		...(row.errorCode
			? { error: { code: row.errorCode, message: row.errorMessage ?? "" } }
			: {}),
	};
}

/** Task 域：多轮、状态机与内部投影；不拥有 Job/AgentSession。 */
@Injectable()
export class TaskService {
	private readonly deps: TaskServiceDeps;

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(AgentRegistryService) registry: AgentRegistryService,
	) {
		this.deps = { prisma, registry };
	}

	/** 测试构造：注入 fake Prisma/registry。 */
	static withDeps(deps: TaskServiceDeps): TaskService {
		const service = new TaskService(
			null as unknown as PrismaService,
			null as unknown as AgentRegistryService,
		);
		(service as unknown as { deps: TaskServiceDeps }).deps = deps;
		return service;
	}

	private get prisma(): PrismaService {
		return this.deps.prisma;
	}

	private get now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	private async row(taskIdValue: string): Promise<TaskRow> {
		const row = await this.prisma.task.findUnique({
			where: { id: taskIdValue },
			include: {
				artifacts: true,
				agentPlacement: { select: { agentId: true } },
			},
		});
		if (!row) {
			throw new TaskServiceError("TASK_NOT_FOUND", "Task 不存在", 404);
		}
		return row as TaskRow;
	}

	/** 创建 Task；agent placement 必须能唯一解析。 */
	async createTask(input: CreateTaskInput, actor: ActorContext): Promise<TaskInfo> {
		const placement = await this.deps.registry.resolve(input.agentId);
		const data: Prisma.TaskUncheckedCreateInput = {
			id: taskId(),
			contextId: input.contextId ?? `ctx_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
			state: "submitted",
			ownerIdentityId: actor.identityId,
			agentPlacementId: placement.id,
			intent: input.intent,
			acceptanceCriteria: JSON.stringify(input.acceptanceCriteria),
			constraints: JSON.stringify(input.constraints),
		};
		const row = await this.prisma.task.create({
			data,
			include: {
				artifacts: true,
				agentPlacement: { select: { agentId: true } },
			},
		});
		return toTaskInfo(row as TaskRow);
	}

	/** 追加调用方 Turn；只存短摘要与 hash。 */
	async appendUserTurn(
		taskIdValue: string,
		message: A2aMessage,
		_actor: ActorContext,
	): Promise<TaskTurnInfo> {
		const row = await this.row(taskIdValue);
		const state = row.state as TaskLifecycleState;
		if (TERMINAL_STATES.includes(state)) {
			throw new TaskServiceError("TASK_TERMINAL", "Task 已到终态", 409);
		}
		if (state === "working") {
			throw new TaskServiceError("TASK_BUSY", "Task 正在执行", 409);
		}
		const text = message.parts.map((part) => part.text).join("");
		const summary = text.slice(0, 200);
		const last = await this.prisma.taskTurn.findFirst({
			where: { taskId: taskIdValue },
			orderBy: { seq: "desc" },
		});
		const seq = (last?.seq ?? 0) + 1;
		const data: Prisma.TaskTurnUncheckedCreateInput = {
			id: turnId(),
			taskId: taskIdValue,
			seq,
			direction: "inbound",
			messageId: message.messageId,
			summary,
			// 输入侧刻意只存摘要 + hash（安全决策，见 task.service.test）：
			// 需要完整正文的是 agent 的输出（outbound），不是操作者的 prompt。
			contentHash: sha256(text),
			createdAt: this.now,
		};
		const turn = await this.prisma.taskTurn.create({ data });
		return {
			id: turn.id,
			taskId: turn.taskId,
			seq: turn.seq,
			direction: "inbound",
			messageId: turn.messageId,
			summary: turn.summary,
			content: turn.content ?? null,
			contentHash: turn.contentHash,
			createdAt: turn.createdAt.toISOString(),
		};
	}

	/** agent 输出正文的上限（与 RDS transcript 同一量级的截断策略）。 */
	static readonly AGENT_TURN_MAX_CHARS = 64 * 1024;

	/**
	 * 追加 agent 回复轮（正文入库，供 A2A 结果回传）。
	 *
	 * 与 appendUserTurn 对称：inbound 存用户输入，outbound 存 agent 输出。
	 */
	async appendAgentTurn(
		taskIdValue: string,
		messageId: string,
		text: string,
	): Promise<TaskTurnInfo> {
		const content = text.slice(0, TaskService.AGENT_TURN_MAX_CHARS);
		const summary = content.slice(0, 200);
		const last = await this.prisma.taskTurn.findFirst({
			where: { taskId: taskIdValue },
			orderBy: { seq: "desc" },
		});
		const seq = (last?.seq ?? 0) + 1;
		const turn = await this.prisma.taskTurn.create({
			data: {
				id: turnId(),
				taskId: taskIdValue,
				seq,
				direction: "outbound",
				messageId,
				summary,
				content,
				contentHash: sha256(content),
				createdAt: this.now,
			},
		});
		return {
			id: turn.id,
			taskId: turn.taskId,
			seq: turn.seq,
			direction: "outbound",
			messageId: turn.messageId,
			summary: turn.summary,
			content: turn.content ?? null,
			contentHash: turn.contentHash,
			createdAt: turn.createdAt.toISOString(),
		};
	}

	/** 按 seq 升序列出全部轮次（A2A history 组装用）。 */
	async listTurns(taskIdValue: string): Promise<TaskTurnInfo[]> {
		const turns = await this.prisma.taskTurn.findMany({
			where: { taskId: taskIdValue },
			orderBy: { seq: "asc" },
		});
		return turns.map((turn) => ({
			id: turn.id,
			taskId: turn.taskId,
			seq: turn.seq,
			direction: turn.direction as "inbound" | "outbound",
			messageId: turn.messageId,
			summary: turn.summary,
			content: turn.content ?? null,
			contentHash: turn.contentHash,
			createdAt: turn.createdAt.toISOString(),
		}));
	}

	/** 读取 Task（内部投影）。 */
	async getTask(taskIdValue: string, _historyLength?: number): Promise<TaskInfo> {
		return toTaskInfo(await this.row(taskIdValue));
	}

	/** 分页列出 Task；状态过滤使用内部状态。 */
	async listTasks(
		filter: TaskListFilter,
		page: number,
		pageSize: number,
	): Promise<PaginatedResult<TaskInfo>> {
		const where: Prisma.TaskWhereInput = {
			...(filter.contextId ? { contextId: filter.contextId } : {}),
			...(filter.state ? { state: filter.state } : {}),
			...(filter.agentId ? { agentPlacement: { agentId: filter.agentId } } : {}),
		};
		const [rows, total] = await Promise.all([
			this.prisma.task.findMany({
				where,
				include: {
					artifacts: true,
					agentPlacement: { select: { agentId: true } },
				},
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.task.count({ where }),
		]);
		return {
			data: rows.map((row) => toTaskInfo(row as TaskRow)),
			total,
			page,
			pageSize,
			totalPages: Math.max(1, Math.ceil(total / pageSize)),
		};
	}

	/** 状态转移；同态幂等，终态不可离开。 */
	async transition(
		taskIdValue: string,
		next: TaskLifecycleState,
		patch: { errorCode?: string; errorMessage?: string } = {},
	): Promise<TaskInfo> {
		const row = await this.row(taskIdValue);
		const current = row.state as TaskLifecycleState;
		if (current === next) return toTaskInfo(row);
		if (!ALLOWED[current].includes(next)) {
			throw new TaskServiceError(
				"INVALID_TASK_TRANSITION",
				`非法状态转移 ${current} -> ${next}`,
				409,
			);
		}
		const data: Prisma.TaskUncheckedUpdateInput = {
			state: next,
			...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
			...(patch.errorMessage !== undefined
				? { errorMessage: patch.errorMessage }
				: {}),
			...(TERMINAL_STATES.includes(next) ? { completedAt: this.now } : {}),
		};
		const updated = await this.prisma.task.update({
			where: { id: taskIdValue },
			data,
			include: {
				artifacts: true,
				agentPlacement: { select: { agentId: true } },
			},
		});
		return toTaskInfo(updated as TaskRow);
	}

	/** 取消 Task；终态幂等返回当前状态。 */
	async cancelTask(taskIdValue: string, _actor: ActorContext): Promise<TaskInfo> {
		const row = await this.row(taskIdValue);
		const current = row.state as TaskLifecycleState;
		if (TERMINAL_STATES.includes(current)) return toTaskInfo(row);
		return this.transition(taskIdValue, "canceled");
	}

	/** 创建一次执行尝试。 */
	async createAttempt(
		taskIdValue: string,
		adapter: "acp" | "cli",
	): Promise<{ attemptId: string }> {
		await this.row(taskIdValue);
		const id = attemptId();
		await this.prisma.taskAttempt.create({
			data: {
				id,
				taskId: taskIdValue,
				adapter,
				status: "running",
				startedAt: this.now,
			},
		});
		return { attemptId: id };
	}

	/** 结算执行尝试。 */
	async finishAttempt(
		attemptIdValue: string,
		status: "completed" | "failed" | "canceled",
		errorCode?: string,
	): Promise<void> {
		await this.prisma.taskAttempt.update({
			where: { id: attemptIdValue },
			data: { status, endedAt: this.now, ...(errorCode ? { errorCode } : {}) },
		});
	}
}
