import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { TERMINAL_AUDIT_EVENTS, type TerminalAuditEventName, type PaginatedResult, type TerminalAuditInfo } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { toTerminalAuditInfo, type TerminalAuditRecord } from "./terminal-records.js";

/** 审计记录请求（窄 DTO；不允许携带正文类字段）。 */
export interface TerminalAuditRecordRequest {
	sessionId: string;
	clientId: string;
	event: TerminalAuditEventName;
	identityId: string | null;
	actorName: string | null;
	source: string | null;
	result: "ok" | "error";
	reason?: string;
}

/** 终端最小审计：只记录生命周期事件，不记录输入输出。 */
@Injectable()
export class TerminalAuditService {
	// 显式 @Inject：tsx/esbuild 转译不 emit decorator metadata，无 @Inject 的类型注入会得到 undefined
	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	async record(request: TerminalAuditRecordRequest): Promise<void> {
		if (!(TERMINAL_AUDIT_EVENTS as readonly string[]).includes(request.event)) {
			throw new Error("audit event not allowed");
		}
		await this.prisma.terminalAuditEvent.create({
			data: {
				id: `ta_${randomUUID()}`,
				sessionId: request.sessionId,
				clientId: request.clientId,
				event: request.event,
				identityId: request.identityId,
				actorName: request.actorName,
				source: request.source,
				result: request.result,
				reason: request.reason ?? null,
			},
		});
	}

	/** 分页审计列表（遵循 PaginatedResult 规范）。 */
	async list(
		filter: { sessionId?: string; clientId?: string },
		page = 1,
		pageSize = 20,
	): Promise<PaginatedResult<TerminalAuditInfo>> {
		const where: Record<string, string> = {};
		if (filter.sessionId) where.sessionId = filter.sessionId;
		if (filter.clientId) where.clientId = filter.clientId;
		const [list, total] = await Promise.all([
			this.prisma.terminalAuditEvent.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.terminalAuditEvent.count({ where }),
		]);
		return {
			data: list.map((r) => toTerminalAuditInfo(r as unknown as TerminalAuditRecord)),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}
}
