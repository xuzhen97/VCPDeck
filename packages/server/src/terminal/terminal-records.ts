import type { TerminalAuditInfo, TerminalAuditEventName, TerminalSessionInfo, TerminalSessionStatus } from "@vcpdeck/shared";
import { isTerminalAuditEventName, isTerminalSessionStatus } from "@vcpdeck/shared";

// ── 终端记录映射：DB 行 ⇄ 安全 API DTO ──
// 只映射批准字段；终端正文（input/output/snapshot）、token、路径和环境变量不进入 DTO。

/** TerminalSession 行（与 Prisma 结构兼容的最小接口，主键为 id）。 */
export interface TerminalSessionRecord {
	id: string;
	clientId: string;
	shellId: string;
	shellLabel: string;
	status: TerminalSessionStatus;
	cols: number;
	rows: number;
	createdByIdentityId: string | null;
	createdByName: string | null;
	createdAt: Date;
	lastAttachedAt: Date | null;
	detachedAt: Date | null;
	expiresAt: Date | null;
	endedAt: Date | null;
	endReason: string | null;
	errorCode: string | null;
}

/** 映射会话记录到 REST DTO（DB id → DTO sessionId；日期转 ISO 字符串，null 保留）。 */
export function toTerminalSessionInfo(record: TerminalSessionRecord): TerminalSessionInfo {
	return {
		sessionId: record.id,
		clientId: record.clientId,
		shellId: record.shellId,
		shellLabel: record.shellLabel,
		status: record.status,
		cols: record.cols,
		rows: record.rows,
		createdByIdentityId: record.createdByIdentityId,
		createdByName: record.createdByName,
		createdAt: record.createdAt.toISOString(),
		lastAttachedAt: record.lastAttachedAt?.toISOString() ?? null,
		detachedAt: record.detachedAt?.toISOString() ?? null,
		expiresAt: record.expiresAt?.toISOString() ?? null,
		endedAt: record.endedAt?.toISOString() ?? null,
		endReason: record.endReason,
		errorCode: record.errorCode,
	};
}

/** TerminalAuditEvent 行（与 Prisma 结构兼容的最小接口）。 */
export interface TerminalAuditRecord {
	id: string;
	sessionId: string;
	clientId: string;
	event: string;
	identityId: string | null;
	actorName: string | null;
	source: string | null;
	result: string;
	reason: string | null;
	createdAt: Date;
}

/** 映射审计记录到 REST DTO（非法值安全降级，不允许正文类字段）。 */
export function toTerminalAuditInfo(record: TerminalAuditRecord): TerminalAuditInfo {
	return {
		id: record.id,
		sessionId: record.sessionId,
		clientId: record.clientId,
		event: isTerminalAuditEventName(record.event) ? record.event : "attached",
		identityId: record.identityId,
		actorName: record.actorName,
		source: record.source,
		result: record.result === "error" ? "error" : "ok",
		reason: record.reason,
		createdAt: record.createdAt.toISOString(),
	};
}
