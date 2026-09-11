"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toTerminalSessionInfo = toTerminalSessionInfo;
exports.toTerminalAuditInfo = toTerminalAuditInfo;
const shared_1 = require("@vcpdeck/shared");
/** 映射会话记录到 REST DTO（DB id → DTO sessionId；日期转 ISO 字符串，null 保留）。 */
function toTerminalSessionInfo(record) {
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
/** 映射审计记录到 REST DTO（非法值安全降级，不允许正文类字段）。 */
function toTerminalAuditInfo(record) {
    return {
        id: record.id,
        sessionId: record.sessionId,
        clientId: record.clientId,
        event: (0, shared_1.isTerminalAuditEventName)(record.event) ? record.event : "attached",
        identityId: record.identityId,
        actorName: record.actorName,
        source: record.source,
        result: record.result === "error" ? "error" : "ok",
        reason: record.reason,
        createdAt: record.createdAt.toISOString(),
    };
}
