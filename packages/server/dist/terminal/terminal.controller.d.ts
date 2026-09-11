import { TerminalService } from "./terminal.service.js";
import { TerminalAuditService } from "./terminal-audit.service.js";
import type { ActorContext, PaginatedResult, TerminalAuditInfo, TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";
/** 终端会话 REST API（机器范围内）。 */
export declare class TerminalController {
    private readonly service;
    private readonly auditService;
    constructor(service: TerminalService, auditService: TerminalAuditService);
    shells(clientId: string, _actor: ActorContext): Promise<TerminalShellInfo[]>;
    list(clientId: string, pageStr: string | undefined, pageSizeStr: string | undefined, _actor: ActorContext): Promise<PaginatedResult<TerminalSessionInfo>>;
    create(clientId: string, body: unknown, actor: ActorContext): Promise<TerminalSessionInfo>;
    get(clientId: string, sessionId: string, _actor: ActorContext): Promise<TerminalSessionInfo>;
    remove(clientId: string, sessionId: string, actor: ActorContext): Promise<TerminalSessionInfo>;
    audit(clientId: string, sessionId: string, pageStr: string | undefined, pageSizeStr: string | undefined, _actor: ActorContext): Promise<PaginatedResult<TerminalAuditInfo>>;
}
