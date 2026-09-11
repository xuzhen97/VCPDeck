import { type TerminalAuditEventName, type PaginatedResult, type TerminalAuditInfo } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
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
export declare class TerminalAuditService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    record(request: TerminalAuditRecordRequest): Promise<void>;
    /** 分页审计列表（遵循 PaginatedResult 规范）。 */
    list(filter: {
        sessionId?: string;
        clientId?: string;
    }, page?: number, pageSize?: number): Promise<PaginatedResult<TerminalAuditInfo>>;
}
