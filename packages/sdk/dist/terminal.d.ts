import type { PaginatedResult, TerminalAuditInfo, TerminalSessionCreateRequest, TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** 终端 REST API（机器范围内）。 */
export declare function createTerminalsApi(client: Pick<VcpDeckClient, "request">): {
    /** 列出 Client 实际可用 Shell。 */
    shells: (clientId: string, signal?: AbortSignal) => Promise<TerminalShellInfo[]>;
    /** 会话列表（分页）。 */
    list: (clientId: string, options?: {
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<TerminalSessionInfo>>;
    /** 创建终端会话（只允许 shellId/cols/rows）。 */
    create: (clientId: string, body: TerminalSessionCreateRequest, signal?: AbortSignal) => Promise<TerminalSessionInfo>;
    /** 会话详情。 */
    get: (clientId: string, sessionId: string, signal?: AbortSignal) => Promise<TerminalSessionInfo>;
    /** 关闭会话（幂等）。 */
    remove: (clientId: string, sessionId: string, signal?: AbortSignal) => Promise<TerminalSessionInfo>;
    /** 会话审计分页。 */
    audit: (clientId: string, sessionId: string, options?: {
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<TerminalAuditInfo>>;
};
