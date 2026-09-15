import { type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type ActorContext, type TunnelSessionCreated } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TunnelConfigService } from "./tunnel-config.service.js";
/** 隧道 Session 领域错误；code 稳定，statusCode 映射 HTTP。 */
export declare class TunnelSessionError extends Error {
    readonly code: string;
    readonly statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
/** 精确 socket emitter 回调（由 Gateway 绑定）。 */
export type TunnelSender = (socketId: string, event: string, payload: unknown) => void;
/**
 * 管理活动 P2P 隧道 Session：创建、绑定、信令转发与幂等清理。
 * 全部只存内存；SDP/candidate/HTTP 正文不落日志。
 */
export declare class TunnelSessionService implements OnModuleInit, OnModuleDestroy {
    private readonly config;
    private readonly prisma;
    private sessions;
    private timer;
    private sendClient;
    private sendBrowser;
    constructor(config: TunnelConfigService, prisma: PrismaService);
    onModuleInit(): void;
    onModuleDestroy(): void;
    /** 由 ClientGateway 绑定 /client 精确 socket emitter。 */
    bindClientSender(fn: TunnelSender): void;
    /** 由 AppGateway 绑定 /app 精确 socket emitter。 */
    bindBrowserSender(fn: TunnelSender): void;
    has(sessionId: string): boolean;
    /** 创建临时 Session：校验 Client 在线 + p2pTunnel 能力，并签发短期凭据。 */
    create(raw: unknown, actor: ActorContext): Promise<TunnelSessionCreated>;
    /** 绑定 Browser socket 到 Session，并向目标 Client lease 下发 prepare。 */
    attachBrowser(sessionId: string, actor: ActorContext, browserSocketId: string): Promise<void>;
    /** 转发 Browser 信令（offer/candidate）到目标 Client lease。 */
    signalFromBrowser(browserSocketId: string, raw: unknown): Promise<void>;
    /** 转发 Client 信令（answer/candidate）到已绑定 Browser。 */
    signalFromClient(clientSocketId: string, raw: unknown): Promise<void>;
    /** Client 上报数据面状态；failed/closed 时先通知 Browser 再释放。 */
    clientState(clientSocketId: string, raw: unknown): Promise<void>;
    /** 创建者显式关闭（幂等）。 */
    close(sessionId: string, actor: ActorContext): Promise<{
        closed: true;
    }>;
    /** Client 侧显式关闭（校验 lease 后幂等释放）。 */
    closeFromClient(clientId: string, clientSocketId: string, sessionId: string): Promise<void>;
    /** Browser socket 断开：只清理绑定该 socket 的 Session。 */
    disconnectBrowser(browserSocketId: string): void;
    /** Client socket 断开：只清理匹配 lease 的 Session。 */
    disconnectClient(clientId: string, clientSocketId: string): void;
    private sweep;
    private release;
    private requireOwned;
    private parseBrowserSignal;
    private parseClientSignal;
    /** 从持久化 capabilityDetails 严格读取 p2pTunnel 摘要；损坏/缺失返回 null。 */
    private readP2pCapability;
}
