import type { TerminalAuditInfo, TerminalSessionInfo, TerminalSessionStatus } from "@vcpdeck/shared";
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
export declare function toTerminalSessionInfo(record: TerminalSessionRecord): TerminalSessionInfo;
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
export declare function toTerminalAuditInfo(record: TerminalAuditRecord): TerminalAuditInfo;
