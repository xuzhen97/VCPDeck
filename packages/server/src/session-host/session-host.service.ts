import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	type PaginatedResult,
	type SessionHostInstanceRecord,
	type SessionHostKind,
	type SessionHostState,
	type SessionHostStatusReport,
	isSessionHostKind,
	isSessionHostState,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";

/** 审计只允许生命周期事件；正文、输入输出、令牌一律不入审计。 */
export const SESSION_HOST_AUDIT_EVENTS = ["discovered", "unreachable", "stopped", "failed"] as const;
export type SessionHostAuditEvent = (typeof SESSION_HOST_AUDIT_EVENTS)[number];

/** 对账结果：两组都是「当前」集合，不是本次变更量。 */
export interface ReconcileResult {
	/** 当前状态未被确认（宿主不可达或宿主已更换）的实例。 */
	unreachable: string[];
	/** 当前被确认已停止的实例。 */
	stopped: string[];
}

/** 服务依赖（测试注入）。 */
export interface SessionHostServiceDeps {
	prisma: PrismaService;
	now?: () => Date;
	createId?: () => string;
}

interface InstanceRow {
	id: string;
	clientId: string;
	instanceId: string;
	hostId: string;
	kind: string;
	state: string;
	startedAt: Date;
	lastSeq: number;
	lastSeenAt: Date;
	endedAt: Date | null;
	endReason: string | null;
}

const ABSENT_REASON = "host-reported-absent";
const HOST_RESTARTED_REASON = "host-restarted";
const HOST_UNAVAILABLE_REASON = "host-unavailable";

function isTerminalState(state: string): boolean {
	return state === "stopped" || state === "failed";
}

/**
 * 会话宿主对账服务。
 *
 * 唯一铁律：**「暂不可达」不是「已退出」**。
 * - `available: false`（宿主查不到）只能把实例落 `unknown`；
 * - 宿主已更换（hostId 变了）同样只能落 `unknown`，因为旧进程是否退出尚未确认；
 * - 只有「同一 hostId 明确不再持有该实例」或「宿主自报 stopped」才算确认停止。
 *
 * 未知 instanceId 只登记、不清理：Server 从不主动删实例行。
 */
@Injectable()
export class SessionHostService {
	private readonly deps: SessionHostServiceDeps;

	// 显式 @Inject：tsx/esbuild 转译不 emit decorator metadata，无 @Inject 的类型注入会得到 undefined。
	constructor(@Inject(PrismaService) prisma: PrismaService) {
		this.deps = { prisma };
	}

	/** 测试构造：注入 fake prisma 与可复现时钟/ID。 */
	static withDeps(deps: SessionHostServiceDeps): SessionHostService {
		const service = new SessionHostService(null as unknown as PrismaService);
		(service as unknown as { deps: SessionHostServiceDeps }).deps = deps;
		return service;
	}

	private now(): Date {
		return (this.deps.now ?? (() => new Date()))();
	}

	private createId(): string {
		return (this.deps.createId ?? (() => randomUUID()))();
	}

	/** 对账宿主状态报告：更新元数据、必要时写生命周期审计。 */
	async reconcile(clientId: string, report: SessionHostStatusReport): Promise<ReconcileResult> {
		const known = (await this.deps.prisma.sessionHostInstance.findMany({
			where: { clientId },
		})) as unknown as InstanceRow[];
		const knownById = new Map(known.map((item) => [item.instanceId, item]));

		// 宿主演进出：整台主机的状态都未确认，实例只能是 unknown。
		if (!report.available || report.hostId === null) {
			const unreachable: string[] = [];
			for (const row of known) {
				// 已确认终态（stopped/failed）不得被一次「暂时查不到」抹掉：
				// 那是一次已确认的历史事实，降级为 unknown 既失真又会反复刷审计。
				if (isTerminalState(row.state)) continue;
				unreachable.push(row.instanceId);
				if (row.state === "unknown") continue;
				await this.updateInstance(row.id, { state: "unknown" });
				await this.recordAudit(clientId, row.instanceId, "unreachable", HOST_UNAVAILABLE_REASON);
			}
			return { unreachable, stopped: [] };
		}

		const hostId = report.hostId;
		const now = this.now();
		const reported = new Set<string>();
		const unreachable: string[] = [];
		const stopped: string[] = [];

		for (const info of report.instances) {
			reported.add(info.instanceId);
			const existing = knownById.get(info.instanceId);
			const startedAt = new Date(info.startedAt);
			const terminal = isTerminalState(info.state);

			if (existing === undefined) {
				// 未知 instanceId 只登记：不清理、不猜测它属于谁。
				await this.deps.prisma.sessionHostInstance.create({
					data: {
						id: this.createId(),
						clientId,
						instanceId: info.instanceId,
						hostId,
						kind: info.kind,
						state: info.state,
						startedAt,
						lastSeq: info.lastSeq,
						lastSeenAt: now,
						endedAt: terminal ? now : null,
						endReason: terminal ? "host-reported" : null,
					},
				});
				await this.recordAudit(clientId, info.instanceId, "discovered", null);
			} else {
				await this.updateInstance(existing.id, {
					hostId,
					kind: info.kind,
					state: info.state,
					startedAt,
					lastSeq: info.lastSeq,
					lastSeenAt: now,
					endedAt: terminal ? now : null,
					endReason: terminal ? "host-reported" : null,
				});
				if (existing.state !== info.state) {
					const event = auditEventForState(info.state);
					if (event !== null) await this.recordAudit(clientId, info.instanceId, event, "host-reported");
				}
			}

			if (info.state === "stopped") stopped.push(info.instanceId);
			if (info.state === "unknown") unreachable.push(info.instanceId);
		}

		// 宿主报告里缺席的已知实例。
		for (const row of known) {
			if (reported.has(row.instanceId)) continue;
			if (row.hostId === hostId) {
				// 同一个宿主明确列出全部实例，缺席即确认它已不再持有该实例。
				stopped.push(row.instanceId);
				if (row.state === "stopped") continue;
				await this.updateInstance(row.id, { state: "stopped", endedAt: now, endReason: ABSENT_REASON });
				await this.recordAudit(clientId, row.instanceId, "stopped", ABSENT_REASON);
				continue;
			}
			// 换宿主了：旧实例是否退出尚未确认。已确认终态的同样不回退。
			if (isTerminalState(row.state)) continue;
			unreachable.push(row.instanceId);
			if (row.state === "unknown") continue;
			await this.updateInstance(row.id, { state: "unknown" });
			await this.recordAudit(clientId, row.instanceId, "unreachable", HOST_RESTARTED_REASON);
		}

		return { unreachable, stopped };
	}

	/** 分页列出实例元数据（服务端已保存的控制面信息）。 */
	async list(
		filter: { clientId?: string },
		page = 1,
		pageSize = 20,
	): Promise<PaginatedResult<SessionHostInstanceRecord>> {
		const where = filter.clientId === undefined ? {} : { clientId: filter.clientId };
		const [rows, total] = await Promise.all([
			this.deps.prisma.sessionHostInstance.findMany({
				where,
				orderBy: { updatedAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.deps.prisma.sessionHostInstance.count({ where }),
		]);
		return {
			data: (rows as unknown as InstanceRow[]).map(toRecord),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	private async updateInstance(id: string, data: Partial<InstanceRow>): Promise<void> {
		await this.deps.prisma.sessionHostInstance.update({ where: { id }, data });
	}

	private async recordAudit(
		clientId: string,
		instanceId: string,
		event: SessionHostAuditEvent,
		reason: string | null,
	): Promise<void> {
		if (!(SESSION_HOST_AUDIT_EVENTS as readonly string[]).includes(event)) {
			throw new Error("audit event not allowed");
		}
		await this.deps.prisma.sessionHostAuditEvent.create({
			data: {
				id: this.createId(),
				instanceId,
				clientId,
				event,
				identityId: null,
				actorName: null,
				source: "client-report",
				result: event === "failed" ? "error" : "ok",
				reason,
				createdAt: this.now(),
			},
		});
	}
}

function auditEventForState(state: SessionHostState): SessionHostAuditEvent | null {
	switch (state) {
		case "stopped":
			return "stopped";
		case "failed":
			return "failed";
		case "unknown":
			return "unreachable";
		default:
			return null;
	}
}

/** 记录投影：枚举值必须先过共享 allowlist，不得猜测或透传未知值。 */
function toRecord(row: InstanceRow): SessionHostInstanceRecord {
	if (!isSessionHostKind(row.kind)) throw new Error("会话宿主记录 kind 非法");
	if (!isSessionHostState(row.state)) throw new Error("会话宿主记录 state 非法");
	return {
		clientId: row.clientId,
		instanceId: row.instanceId,
		hostId: row.hostId,
		kind: row.kind as SessionHostKind,
		state: row.state as SessionHostState,
		startedAt: row.startedAt.toISOString(),
		lastSeq: row.lastSeq,
		lastSeenAt: row.lastSeenAt.toISOString(),
		endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
		endReason: row.endReason,
	};
}
