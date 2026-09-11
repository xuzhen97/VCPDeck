import { type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type ReleaseCleanupPreview, type ReleaseCleanupRunResult } from "@vcpdeck/shared";
import { ReleaseService } from "./release.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
export interface ReleaseCleanupServiceOptions {
    now?: () => Date;
    removeLocal?: (path: string) => Promise<void>;
}
/** Server Release archive 与直传会话清理协调器。 */
export declare class ReleaseCleanupService implements OnModuleInit, OnModuleDestroy {
    private readonly prisma;
    private readonly releases;
    private readonly storage;
    private readonly logger;
    private readonly now;
    private readonly removeLocal;
    private running;
    private timer;
    constructor(prisma: PrismaService, releases: ReleaseService, storage: StorageService, options?: ReleaseCleanupServiceOptions);
    private get uploadSessions();
    /** Server 启动后执行一次，并以每日扫描作为失败重试兜底。 */
    onModuleInit(): void;
    /** 停止清理定时器；已经开始的 Provider 删除交给 lifecycle 恢复。 */
    onModuleDestroy(): void;
    /** 计算当前固定策略下的可清理候选，不执行删除。 */
    preview(): Promise<ReleaseCleanupPreview>;
    /** 按固定策略执行一次清理；执行时重新 claim，不信任旧预览。 */
    run(): Promise<ReleaseCleanupRunResult>;
    /** 自动触发入口；清理失败只记录日志，不改变 Release 状态。 */
    runAutomatic(trigger: "startup" | "release_done" | "scheduled"): Promise<void>;
    private executeRun;
    private cleanCandidate;
    private recoverDeleting;
    private cleanUploadSessions;
}
