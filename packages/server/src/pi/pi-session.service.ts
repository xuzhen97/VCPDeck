/**
 * Agent 会话控制面服务(ADR-0041)。
 *
 * 职责边界:
 * - 会话元数据、固定 Owner、归档/恢复、执行模式覆盖、删除预约与最小审计;
 * - 不负责 Worker 执行、Run 状态机、项目锁与结算(属于 PiRunService);
 * - 不保存 Prompt、正文、thinking、路径或任何对话内容;
 * - 删除保留墓碑与 Run/审计,不级联清除历史。
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	isPiToolExecutionMode,
	isPiRunTerminal,
	type ActorContext,
	type PaginatedResult,
	type PiAuditEventInfo,
	type PiErrorCode,
	type PiRunInfo,
	type PiSessionSnapshot,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { PiRuntimeService } from "./pi-runtime.service.js";

/** 会话行(与 Prisma AgentSession 对齐)。 */
interface AgentSessionRow {
	id: string;
	clientId: string;
	status: string;
	ownerIdentityId?: string | null;
	ownerName?: string | null;
	activeRunId?: string | null;
	toolExecutionModeOverride?: string | null;
	executionModeNeedsConfirmation?: boolean;
	legacyExecutionModeOverride?: string | null;
	deleteToken?: string | null;
	deletePreviousStatus?: string | null;
}

interface AgentRunRow {
	id: string;
	sessionId: string;
	status: string;
	kind: string;
	executionMode?: string | null;
	createdByName?: string | null;
	createdVia?: string | null;
	createdAt: Date | string;
	acceptedAt?: Date | string | null;
	startedAt?: Date | string | null;
	finishedAt?: Date | string | null;
	errorCode?: string | null;
}

interface AgentAuditRow {
	id: string;
	sessionId: string;
	event: string;
	result: string;
	actorName?: string | null;
	source?: string | null;
	createdAt: Date | string;
	errorCode?: string | null;
	oldExecutionMode?: string | null;
	newExecutionMode?: string | null;
}

export type SessionAuditEvent =
	| "created"
	| "imported"
	| "renamed"
	| "archived"
	| "restored"
	| "deleted"
	| "execution_mode_changed";

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

const SESSION_ID_MAX = 256;
const PAGE_SIZE_MAX = 100;
const DEFAULT_PAGE_SIZE = 20;

function iso(value: Date | string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseStoredMode(raw: unknown): PiToolExecutionMode | null {
	if (raw === null || raw === undefined) return null;
	if (!isPiToolExecutionMode(raw)) throw piError("PI_CONFIG_UNAVAILABLE", "Session execution mode is invalid");
	return raw;
}

/** 会话控制面服务:Owner、归档、模式、删除预约与最小审计。 */
@Injectable()
export class PiSessionService {
	private readonly profileForClient: (clientId: string) => Promise<PiToolExecutionMode | null>;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Optional() @Inject(PiRuntimeService) runtimeSource?: PiRuntimeService,
	) {
		this.profileForClient = async (clientId) => {
			if (!runtimeSource) return null;
			return runtimeSource.effectiveExecutionMode(clientId);
		};
	}

	private sessions() {
		return (this.prisma as unknown as { agentSession: AgentSessionQueries }).agentSession;
	}

	private runs() {
		return (this.prisma as unknown as { agentRun: AgentRunQueries }).agentRun;
	}

	private audits() {
		return (this.prisma as unknown as { agentAuditEvent: AgentAuditQueries }).agentAuditEvent;
	}

	private async findSession(sessionId: string): Promise<AgentSessionRow> {
		if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX) {
			throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
		}
		const row = await this.sessions().findUnique({ where: { id: sessionId } }) as AgentSessionRow | null;
		if (!row) throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
		return row;
	}

	/** 幂等创建会话控制面行;owner 由首次创建者固定,后续补齐只读打开不夺权。 */
	async ensureSession(
		actor: ActorContext,
		input: { clientId: string; sessionId: string; event?: "created" | "imported" },
	): Promise<void> {
		const existing = await this.sessions().findUnique({ where: { id: input.sessionId } }) as AgentSessionRow | null;
		if (existing) {
			if (existing.clientId !== input.clientId) {
				throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
			}
			return;
		}
		const id = randomUUID();
		try {
			await this.sessions().create({
				data: {
					id: input.sessionId,
					clientId: input.clientId,
					status: "available",
					ownerIdentityId: actor.identityId ?? null,
					ownerName: actor.displayName ?? null,
				},
			});
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "P2002")) throw error;
			const winner = await this.sessions().findUnique({ where: { id: input.sessionId } }) as AgentSessionRow | null;
			if (!winner || winner.clientId !== input.clientId) {
				throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
			}
			return;
		}
		if (input.event) {
			await this.recordAudit({
				sessionId: input.sessionId,
				clientId: input.clientId,
				event: input.event,
				result: "ok",
				actor,
				auditId: id,
			});
		}
	}

	/** 会话快照:Owner 视图与当前活跃 Run;不暴露 deleteToken 或任何正文。 */
	async snapshot(sessionId: string, identityId: string): Promise<PiSessionSnapshot> {
		const row = await this.findSession(sessionId);
		const override = parseStoredMode(row.toolExecutionModeOverride);
		const activeRun = row.activeRunId
			? await this.runInfo(sessionId, row.activeRunId)
			: null;
		let effective: PiToolExecutionMode | null = override;
		if (activeRun) {
			effective = activeRun.executionMode;
		} else if (override === null) {
			try {
				effective = await this.profileForClient(row.clientId);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "PI_CONFIG_UNAVAILABLE")) throw error;
			}
		}
		return {
			sessionId: row.id,
			status: row.status as PiSessionSnapshot["status"],
			activeRun,
			ownerName: row.ownerName ?? null,
			isOwner: identityId != null && row.ownerIdentityId === identityId,
			executionModeOverride: override,
			effectiveExecutionMode: effective,
			executionModeNeedsConfirmation: row.executionModeNeedsConfirmation === true,
		};
	}

	/** 单轮执行摘要:不符合已登记 Run 时抛 PI_SESSION_NOT_FOUND。 */
	async runInfo(sessionId: string, runId: string): Promise<PiRunInfo> {
		const run = await this.runs().findUnique({ where: { id: runId } }) as AgentRunRow | null;
		if (!run || run.sessionId !== sessionId) {
			throw piError("PI_SESSION_NOT_FOUND", "Pi run was not found");
		}
		return this.toRunInfo(run);
	}

	/** 归档/恢复:幂等;归档不删除远端内容也不结算 Run。 */
	async setArchived(
		actor: ActorContext,
		input: { clientId: string; sessionId: string; archived: boolean },
	): Promise<PiSessionSnapshot> {
		const row = await this.assertOwner(input.sessionId, actor.identityId);
		if (row.clientId !== input.clientId) throw piError("PI_SESSION_NOT_FOUND", "Session belongs to a different client");
		if (row.status === "deleted") throw piError("PI_PROJECT_BUSY", "Session is deleted");
		const desired = input.archived ? "archived" : "available";
		if (row.status !== desired) {
			const updated = await this.sessions().updateMany({
				where: { id: input.sessionId, status: { in: ["available", "archived"] }, deleteToken: null },
				data: input.archived
					? { status: "archived", archivedAt: new Date() }
					: { status: "available", archivedAt: null },
			});
			if (updated.count !== 1) throw piError("PI_PROJECT_BUSY", "Session state changed while updating archive");
			await this.recordAudit({
				sessionId: input.sessionId,
				clientId: input.clientId,
				event: input.archived ? "archived" : "restored",
				result: "ok",
				actor,
			});
		}
		return this.snapshot(input.sessionId, actor.identityId);
	}

	/** 会话级执行模式覆盖:仅 Owner 且无活跃 Run 时可改,审计与状态同事务。 */
	async setExecutionMode(
		actor: ActorContext,
		input: { clientId: string; sessionId: string; mode: PiToolExecutionMode | null },
	): Promise<PiSessionSnapshot> {
		if (input.mode !== null && !isPiToolExecutionMode(input.mode)) {
			throw piError("PI_PROTOCOL_INVALID", "Execution mode is invalid");
		}
		const row = await this.assertOwner(input.sessionId, actor.identityId);
		if (row.clientId !== input.clientId) throw piError("PI_SESSION_NOT_FOUND", "Session belongs to a different client");
		if (row.status === "deleted") throw piError("PI_PROJECT_BUSY", "Session is deleted");
		if (row.activeRunId) throw piError("PI_PROJECT_BUSY", "Execution mode can only change while the session is idle");
		const previous = parseStoredMode(row.toolExecutionModeOverride);
		if (previous === input.mode && row.executionModeNeedsConfirmation !== true) {
			return this.snapshot(input.sessionId, actor.identityId);
		}
		const tx = await this.prisma.$transaction(async (client) => {
			const scoped = client as unknown as {
				agentSession: AgentSessionQueries;
				agentAuditEvent: AgentAuditQueries;
			};
			const updated = await scoped.agentSession.updateMany({
				where: {
					id: input.sessionId,
					clientId: input.clientId,
					activeRunId: null,
					status: { in: ["available", "archived"] },
				},
				data: {
					toolExecutionModeOverride: input.mode,
					executionModeNeedsConfirmation: false,
					legacyExecutionModeOverride: null,
				},
			});
			if (updated.count !== 1) throw piError("PI_PROJECT_BUSY", "Session changed while updating execution mode");
			await scoped.agentAuditEvent.create({
				data: {
					id: randomUUID(),
					sessionId: input.sessionId,
					clientId: input.clientId,
					event: "execution_mode_changed",
					result: "ok",
					identityId: actor.identityId ?? null,
					actorName: actor.displayName ?? null,
					source: actor.source ?? null,
					oldExecutionMode: previous,
					newExecutionMode: input.mode,
				},
			});
			return true;
		});
		void tx;
		return this.snapshot(input.sessionId, actor.identityId);
	}

	/**
	 * 删除预约:仅无活跃 Run 且无既有预约时固定 token;
	 * 已有预约幂等返回,不重复写事件、不泄露 token 到快照。
	 */
	async beginDelete(
		sessionId: string,
		identityId: string,
		audit?: { actor?: ActorContext },
	): Promise<{ deleteToken: string; previousStatus: "available" | "archived"; existingReservation: boolean }> {
		const row = await this.assertOwner(sessionId, identityId);
		if (row.status === "deleted") throw piError("PI_PROJECT_BUSY", "Session is already deleted");
		if (row.deleteToken && row.deletePreviousStatus) {
			// 结果不确定时的幂等重试:预约已在,审计按 operationId 幂等补写。
			await this.recordAudit({
				sessionId,
				clientId: row.clientId,
				event: "deleted",
				result: "requested",
				...(audit?.actor ? { actor: audit.actor } : {}),
				operationId: row.deleteToken,
			});
			return {
				deleteToken: row.deleteToken,
				previousStatus: row.deletePreviousStatus as "available" | "archived",
				existingReservation: true,
			};
		}
		if (row.activeRunId) throw piError("PI_PROJECT_BUSY", "Session has an active run");
		if (row.status !== "available" && row.status !== "archived") {
			throw piError("PI_PROJECT_BUSY", "Session state does not allow deletion");
		}
		const deleteToken = randomUUID();
		const previousStatus = row.status;
		const updated = await this.sessions().updateMany({
			where: {
				id: sessionId,
				activeRunId: null,
				deleteToken: null,
				status: { in: ["available", "archived"] },
			},
			data: { deleteToken, deletePreviousStatus: previousStatus },
		});
		if (updated.count !== 1) throw piError("PI_PROJECT_BUSY", "Session state changed during deletion");
		// 跨网络操作:先记"已请求",确认后才写 ok(ADR-0041 决策 5)。
		await this.recordAudit({
			sessionId,
			clientId: row.clientId,
			event: "deleted",
			result: "requested",
			...(audit?.actor ? { actor: audit.actor } : {}),
			operationId: deleteToken,
		});
		return { deleteToken, previousStatus: previousStatus as "available" | "archived", existingReservation: false };
	}

	/** 明确失败/确定未删除时回滚预约,并记 failed(结果不确定时不调用本方法)。 */
	async rollbackDelete(
		sessionId: string,
		deleteToken: string,
		audit?: { actor?: ActorContext; errorCode?: PiErrorCode },
	): Promise<boolean> {
		const row = await this.findSession(sessionId);
		const updated = await this.sessions().updateMany({
			where: { id: sessionId, deleteToken },
			data: { deleteToken: null, deletePreviousStatus: null },
		});
		if (updated.count > 0) {
			await this.recordAudit({
				sessionId,
				clientId: row.clientId,
				event: "deleted",
				result: "failed",
				...(audit?.actor ? { actor: audit.actor } : {}),
				...(audit?.errorCode ? { errorCode: audit.errorCode } : {}),
				operationId: deleteToken,
			});
		}
		return updated.count > 0;
	}

	/** 确认删除:保留墓碑、Run 与审计,只清预约并标记 deleted。 */
	async commitDelete(
		sessionId: string,
		deleteToken: string,
		audit?: { actor?: ActorContext },
	): Promise<boolean> {
		const row = await this.findSession(sessionId);
		const updated = await this.sessions().updateMany({
			where: { id: sessionId, deleteToken },
			data: {
				status: "deleted",
				deletedAt: new Date(),
				deleteToken: null,
				deletePreviousStatus: null,
				archivedAt: null,
				activeRunId: null,
			},
		});
		if (updated.count > 0) {
			await this.recordAudit({
				sessionId,
				clientId: row.clientId,
				event: "deleted",
				result: "ok",
				...(audit?.actor ? { actor: audit.actor } : {}),
				operationId: deleteToken,
			});
		}
		return updated.count > 0;
	}

	async assertSessionOwner(sessionId: string, identityId: string): Promise<void> {
		await this.assertOwner(sessionId, identityId);
	}

	/** 校验会话归属该 Client(控制器外部入口用);不存在则 404。 */
	async requireClientSession(sessionId: string, clientId: string): Promise<void> {
		const row = await this.findSession(sessionId);
		if (row.clientId !== clientId) {
			throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
		}
	}

	/**
	 * 批量读取有界会话 ID 的控制状态(归档/删除),供会话列表合并。
	 * 未登记的 ID 不出现在结果中,调用方不得以此隐式创建 Owner。
	 */
	async controlStatusFor(
		clientId: string,
		sessionIds: string[],
	): Promise<Map<string, "available" | "archived" | "deleted">> {
		if (sessionIds.length === 0) return new Map();
		const rows = await this.sessions().findMany({
			where: { id: { in: sessionIds }, clientId },
		}) as AgentSessionRow[];
		return new Map(
			rows.map((row) => [row.id, row.status as "available" | "archived" | "deleted"]),
		);
	}

	private async assertOwner(sessionId: string, identityId: string): Promise<AgentSessionRow> {
		const row = await this.findSession(sessionId);
		if (identityId == null || row.ownerIdentityId !== identityId) {
			throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can control it");
		}
		return row;
	}

	/** 每轮执行摘要(分页,倒序)。 */
	async listRuns(
		sessionId: string,
		options: { page?: number; pageSize?: number } = {},
	): Promise<PaginatedResult<PiRunInfo>> {
		const page = normalizePage(options.page);
		const pageSize = normalizePageSize(options.pageSize);
		const where = { sessionId };
		const [rows, total] = await Promise.all([
			this.runs().findMany({
				where,
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}) as Promise<AgentRunRow[]>,
			this.runs().count({ where }),
		]);
		return {
			data: rows.map((row) => this.toRunInfo(row)),
			total,
			page,
			pageSize,
			totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
		};
	}

	/** 会话操作审计(分页,倒序);删除后仍可查询。 */
	async listAudit(
		sessionId: string,
		options: { page?: number; pageSize?: number } = {},
	): Promise<PaginatedResult<PiAuditEventInfo>> {
		const page = normalizePage(options.page);
		const pageSize = normalizePageSize(options.pageSize);
		const where = { sessionId };
		const [rows, total] = await Promise.all([
			this.audits().findMany({
				where,
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}) as Promise<AgentAuditRow[]>,
			this.audits().count({ where }),
		]);
		return {
			data: rows.map((row) => this.toAuditInfo(row)),
			total,
			page,
			pageSize,
			totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
		};
	}

	/** 写最小审计;operationId+event+result 唯一,重复调用静默幂等。 */
	async recordAudit(input: {
		sessionId: string;
		clientId: string;
		event: SessionAuditEvent;
		result: "requested" | "ok" | "failed";
		actor?: ActorContext;
		operationId?: string;
		errorCode?: PiErrorCode;
		oldExecutionMode?: PiToolExecutionMode | null;
		newExecutionMode?: PiToolExecutionMode | null;
		auditId?: string;
	}): Promise<void> {
		try {
			await this.audits().create({
				data: {
					id: input.auditId ?? randomUUID(),
					sessionId: input.sessionId,
					clientId: input.clientId,
					event: input.event,
					result: input.result,
					identityId: input.actor?.identityId ?? null,
					actorName: input.actor?.displayName ?? null,
					source: input.actor?.source ?? null,
					operationId: input.operationId ?? null,
					oldExecutionMode: input.oldExecutionMode ?? null,
					newExecutionMode: input.newExecutionMode ?? null,
					errorCode: input.errorCode ?? null,
				},
			});
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "P2002") return;
			throw error;
		}
	}

	private toRunInfo(row: AgentRunRow): PiRunInfo {
		const mode = row.executionMode ?? null;
		if (mode !== null && !isPiToolExecutionMode(mode)) {
			throw piError("PI_PROTOCOL_INVALID", "Stored run execution mode is invalid");
		}
		const terminal = row.status === "succeeded" || row.status === "failed" || row.status === "aborted";
		return {
			runId: row.id,
			sessionId: row.sessionId,
			status: row.status as PiRunInfo["status"],
			kind: row.kind as PiRunInfo["kind"],
			executionMode: (mode ?? "supervised") as PiToolExecutionMode,
			actorName: row.createdByName ?? null,
			source: row.createdVia ?? null,
			createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
			acceptedAt: iso(row.acceptedAt),
			startedAt: iso(row.startedAt),
			finishedAt: terminal ? iso(row.finishedAt) : null,
			errorCode: row.errorCode ? (row.errorCode as PiErrorCode) : null,
		};
	}

	private toAuditInfo(row: AgentAuditRow): PiAuditEventInfo {
		return {
			id: row.id,
			sessionId: row.sessionId,
			event: row.event as PiAuditEventInfo["event"],
			result: row.result as PiAuditEventInfo["result"],
			actorName: row.actorName ?? null,
			source: row.source ?? null,
			createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
			errorCode: row.errorCode ? (row.errorCode as PiErrorCode) : null,
			oldExecutionMode: (row.oldExecutionMode ?? null) as PiToolExecutionMode | null,
			newExecutionMode: (row.newExecutionMode ?? null) as PiToolExecutionMode | null,
		};
	}
}

function normalizePage(page: number | undefined): number {
	if (page === undefined) return 1;
	if (!Number.isSafeInteger(page) || page < 1) throw piError("PI_PROTOCOL_INVALID", "page must be a positive integer");
	return page;
}

function normalizePageSize(pageSize: number | undefined): number {
	if (pageSize === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
		throw piError("PI_PROTOCOL_INVALID", `pageSize must be 1-${PAGE_SIZE_MAX}`);
	}
	return pageSize;
}

/** 仅声明本服务实际使用的 Prisma 查询面,避免测试 mock 与生成类型强耦合。 */
interface AgentSessionQueries {
	findUnique(args: { where: { id: string } }): Promise<unknown>;
	create(args: { data: Record<string, unknown> }): Promise<unknown>;
	findMany(args: { where: Record<string, unknown> }): Promise<unknown>;
	updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}
interface AgentRunQueries {
	findUnique(args: { where: { id: string } }): Promise<unknown>;
	findMany(args: Record<string, unknown>): Promise<unknown>;
	count(args: Record<string, unknown>): Promise<number>;
}
interface AgentAuditQueries {
	create(args: { data: Record<string, unknown> }): Promise<unknown>;
	findMany(args: Record<string, unknown>): Promise<unknown>;
	count(args: Record<string, unknown>): Promise<number>;
}

export { isPiRunTerminal };
