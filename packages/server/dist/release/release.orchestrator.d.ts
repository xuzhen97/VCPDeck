import { type ServerShutdownNotice, type UpdateRequest } from "@vcpdeck/shared";
import { ReleaseService } from "./release.service.js";
import { ReleaseCleanupService } from "./release-cleanup.service.js";
/** 向客户端发送更新事件与查询在线客户端（由网关适配器实现） */
export interface ClientUpdateChannel {
    /** 在线客户端及其版本与注册 os（用于选择对应平台的更新包） */
    listOnlineClients(): Promise<Array<{
        clientId: string;
        clientVersion: string;
        os: string;
    }>>;
    sendUpdateRequest(clientId: string, req: UpdateRequest): void;
    broadcastShutdown(notice: ServerShutdownNotice): void;
}
/** 本机 launcher 控制通道客户端（B6 实现） */
export interface LauncherClient {
    /** 第一阶段：launcher 下载/校验/解压新版本（服务端此时仍在运行） */
    prepareUpdate(input: {
        version: string;
        url: string;
        sha256: string;
    }): Promise<void>;
    /** 第二阶段：launcher 停掉本进程并切换版本（正常情况不会返回） */
    applyUpdate(): Promise<void>;
}
/** 优雅停机协调（B4 实现）：停派发并等待 job 收敛 */
export interface DrainCoordinator {
    drain(timeoutMs?: number): Promise<void>;
}
export interface ReleaseOrchestratorOptions {
    /** 服务端自身版本（默认取 @vcpdeck/shared 构建注入值） */
    serverVersion?: string;
    /** 单客户端更新等待上限（ms），默认 10 分钟 */
    clientTimeoutMs?: number;
}
export declare class ReleaseOrchestrator {
    private readonly releases;
    private readonly channel;
    private readonly launcher;
    private readonly drain;
    private readonly cleanup?;
    private readonly serverVersion;
    private readonly clientTimeoutMs;
    private activePhase;
    private pendingClients;
    private readonly queuedCatchUpClients;
    constructor(releases: ReleaseService, channel: ClientUpdateChannel, launcher: LauncherClient, drain: DrainCoordinator, cleanup?: ReleaseCleanupService | undefined, options?: ReleaseOrchestratorOptions);
    /**
     * 上传后触发：uploaded → updating_server。
     * 服务端按本机平台选择构件；applyUpdate 正常返回（launcher 未接管）视为失败。
     */
    startRelease(version: string): Promise<void>;
    /** 服务启动时恢复编排状态（由 main 引导调用） */
    resumeAfterStartup(): Promise<void>;
    /** 网关注册钩子：推进等待中的客户端，或触发离线补更 */
    onClientRegistered(clientId: string, clientVersion: string): void;
    /** 客户端明确上报更新失败（等待中的立即失败，其余仅记录） */
    onUpdateFailed(clientId: string, _version: string, reason: string): void;
    /** 客户端优雅停机完成、launcher 即将接管（终局信号是重连注册，这里仅记录） */
    onUpdateReady(clientId: string, version: string): void;
    /** 离线补更：落后客户端注册后触发客户端阶段 */
    private triggerCatchUp;
    /** 客户端阶段互斥入口（重入时复用进行中的循环） */
    private runClientPhase;
    /** 阶段收尾后在同一个 Promise 中消费登记的补更 Client。 */
    private runClientPhaseLoop;
    /** 全量依次更新：逐个等待「重连注册新版本 / 超时 / 失败」；按客户端 os 选择平台包 */
    private runClientLoop;
    private updateOneClient;
    private waitClientOutcome;
}
