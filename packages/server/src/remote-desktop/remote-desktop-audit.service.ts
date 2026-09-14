import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	REMOTE_DESKTOP_AUDIT_EVENTS,
	type ActorContext,
	type PaginatedResult,
	type RemoteDesktopAuditEventName,
	type RemoteDesktopAuditInfo,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import {
	toRemoteDesktopAuditInfo,
	type RemoteDesktopAuditRecord,
} from "./remote-desktop-records.js";

/** 远程桌面审计请求：只允许生命周期元数据，不接受信令、输入或剪贴板正文。 */
export interface RemoteDesktopAuditRecordRequest {
	sessionId: string;
	clientId: string;
	event: RemoteDesktopAuditEventName;
	identityId: string | null;
	actorName: string | null;
	attachmentId: string | null;
	role: "operator" | "viewer" | null;
	result: "ok" | "error";
	reason?: string;
}

/**
 * 远程桌面最小审计服务。
 * 只保存会话、附件、角色和结果等控制面元数据，不保存媒体、输入、信令或剪贴板内容。
 */
@Injectable()
export class RemoteDesktopAuditService {
	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	async record(request: RemoteDesktopAuditRecordRequest): Promise<void> {
		if (!(REMOTE_DESKTOP_AUDIT_EVENTS as readonly string[]).includes(request.event)) {
			throw new Error("remote desktop audit event not allowed");
		}
		await this.prisma.remoteDesktopAuditEvent.create({
			data: {
				id: `rda_${randomUUID()}`,
				sessionId: request.sessionId,
				clientId: request.clientId,
				event: request.event,
				identityId: request.identityId,
				actorName: request.actorName,
				attachmentId: request.attachmentId,
				role: request.role,
				result: request.result,
				reason: request.reason ?? null,
			},
		});
	}

	/** 分页返回安全审计 DTO；actor 仅保留签名，便于 Controller 统一鉴权。 */
	async list(
		filter: { sessionId?: string; clientId?: string },
		page = 1,
		pageSize = 20,
	): Promise<PaginatedResult<RemoteDesktopAuditInfo>> {
		const where: Record<string, string> = {};
		if (filter.sessionId) where.sessionId = filter.sessionId;
		if (filter.clientId) where.clientId = filter.clientId;
		const [list, total] = await Promise.all([
			this.prisma.remoteDesktopAuditEvent.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.prisma.remoteDesktopAuditEvent.count({ where }),
		]);
		return {
			// SAFETY: Prisma select is the audited model row; projection validates every persisted enum/date field.
			data: list.map((record: RemoteDesktopAuditRecord) =>
				toRemoteDesktopAuditInfo(record as unknown as RemoteDesktopAuditRecord),
			),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	/** 保持与控制面调用方一致的 actor 形状；审计主体字段由调用方显式传入。 */
	static actorFields(actor: ActorContext | null): Pick<RemoteDesktopAuditRecordRequest, "identityId" | "actorName"> {
		return {
			identityId: actor?.identityId ?? null,
			actorName: actor?.displayName ?? null,
		};
	}
}
