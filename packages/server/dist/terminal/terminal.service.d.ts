import type { ActorContext, PaginatedResult, TerminalClientResponse, TerminalOutputChunk, TerminalSessionInfo, TerminalSessionStatus, TerminalShellInfo, TerminalStateAck, TerminalStateReport } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TerminalRequestBroker } from "./terminal-request-broker.js";
import { TerminalAuditService, type TerminalAuditRecordRequest } from "./terminal-audit.service.js";
export declare const TERMINAL_SESSION_END_STATUSES: readonly TerminalSessionStatus[];
/** 服务依赖（测试注入）。 */
export interface TerminalServiceDeps {
    prisma: PrismaService;
    broker: TerminalRequestBroker;
    audit: {
        record: (request: TerminalAuditRecordRequest) => Promise<void>;
    };
    now?: () => number;
    hashToken?: (token: string) => string;
}
/** 稳定终端错误。 */
/** 终端会话服务：元数据、单写多读、重连保护、输出同步与状态对账。 */
export declare class TerminalService {
    private readonly runtimes;
    private readonly syncPromises;
    private readonly browserEmitter;
    private readonly createChains;
    private now;
    private hashToken;
    private deps;
    /**
     * Nest 注入构造。测试请用 TerminalService.withDeps()。
     */
    constructor(prisma: PrismaService, broker: TerminalRequestBroker, audit: TerminalAuditService);
    /** 测试构造：注入 fake prisma/broker/audit。 */
    static withDeps(deps: TerminalServiceDeps): TerminalService;
    /** AppGateway afterInit 时绑定浏览器事件发射器。 */
    bindBrowserEmitter(fn: (socketId: string, event: string, payload: unknown) => void): void;
    private emitBrowser;
    private runtime;
    private ensureRuntime;
    /** 串行化同一 Client 的创建/对账操作。 */
    private withClientChain;
    private clientSocketId;
    private requireClientLease;
    private sendRequest;
    private recordAudit;
    /** 列出 Client 可用 Shell（安全 DTO）。 */
    listShells(clientId: string): Promise<TerminalShellInfo[]>;
    /** 会话列表：非终态 + 最近 24h 内已中断的会话（设计 13.2：默认返回非终态会话和最近的已中断会话）。 */
    listSessions(clientId: string, page?: number, pageSize?: number): Promise<PaginatedResult<TerminalSessionInfo>>;
    /** 会话详情（仅限本 Client 范围）。 */
    getSession(clientId: string, sessionId: string): Promise<TerminalSessionInfo>;
    /** 创建会话（Server 生成 sessionId；串行化 5 会话限制）。 */
    createSession(clientId: string, request: {
        shellId: string;
        cols: number;
        rows: number;
    }, actor: ActorContext): Promise<TerminalSessionInfo>;
    /** 关闭会话（幂等；终态不改写首次原因）。 */
    closeSession(clientId: string, sessionId: string, actor: ActorContext): Promise<TerminalSessionInfo>;
    /** 浏览器 attach：首个为 operator；token 匹配时恢复操作权。 */
    attachBrowser(args: {
        clientId?: string;
        sessionId: string;
        actor: ActorContext;
        socketId: string;
        reconnectToken?: string;
    }): Promise<{
        attachmentId: string;
        reconnectToken: string;
        mode: "operator" | "viewer";
        controlProtectedUntil: string | null;
    }>;
    /** attach 同步完成 promise（测试与内部追踪用）。 */
    whenAttachSettled(sessionId: string): Promise<void>;
    private trackSync;
    /** attach 同步：请求 Client snapshot，随后按 seq 发送增量。 */
    private syncAttachment;
    /** 浏览器 socket 断开：清理其全部 attachment。 */
    detachBrowserSocket(socketId: string): Promise<void>;
    /** 浏览器显式 detach（单会话）。 */
    detachBrowser(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
    }): Promise<void>;
    private removeAttachment;
    private afterAttachmentRemoved;
    private broadcastControl;
    /** 输入：仅 operator。 */
    browserInput(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
        data: string;
    }): Promise<void>;
    /** resize：仅 operator。 */
    browserResize(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
        cols: number;
        rows: number;
    }): Promise<void>;
    /** 接管：保护期结束后原子生效。 */
    browserTakeover(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
    }): Promise<{
        mode: "operator" | "viewer";
    }>;
    /** 输出 ack（慢消费者跟踪）。 */
    browserAckOutput(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
        seq: number;
    }): Promise<void>;
    /** resync：重新获取 snapshot。 */
    browserResync(args: {
        socketId: string;
        sessionId: string;
        attachmentId: string;
    }): Promise<void>;
    handleClientResponse(_clientId: string, _socketId: string, response: TerminalClientResponse): Promise<void>;
    /** Client 输出：按序转发到 live attachment；syncing 期间进入 backlog。 */
    handleClientOutput(clientId: string, chunk: TerminalOutputChunk): Promise<void>;
    /** Shell 自行退出。 */
    handleClientExit(clientId: string, exit: {
        sessionId: string;
        exitCode: number;
    }): Promise<void>;
    /** 状态对账：接受存活、标记 interrupted、返回孤儿 close。 */
    handleClientState(clientId: string, socketId: string, report: TerminalStateReport): Promise<TerminalStateAck>;
    /** Client 断线：不终结会话（Client 侧 30 分钟保留计时兜底）。 */
    handleClientDisconnect(_clientId: string, _socketId: string): Promise<void>;
    /** Client REGISTER 成功：绑定 socket（对账由 Client 上报状态触发）。 */
    handleClientRegistered(_clientId: string, _socketId: string): Promise<void>;
}
