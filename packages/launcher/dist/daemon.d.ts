import type { UpdateManifest } from "@vcpdeck/shared";
import { type RetentionCleanupResult } from "./version-retention.js";
export interface DaemonConfig {
    /** launcher 应用目录（默认 ~/.vcpdeck/launcher） */
    appDir: string;
    /** 被守护构件：server | client */
    artifact: "server" | "client";
    /** server 探活 URL（默认 http://127.0.0.1:3001/api/status） */
    probeUrl?: string;
    log?: (msg: string) => void;
    /** 测试或宿主注入的本地版本保留器 */
    retention?: VersionRetentionLike;
}
export interface VersionRetentionLike {
    initialize(): Promise<void>;
    recordSuccessful(version: string): Promise<boolean>;
    cleanup(protectedVersions?: ReadonlySet<string>): Promise<RetentionCleanupResult>;
}
/** 读取版本目录下的 manifest.json；缺失/损坏返回 null */
export declare function readManifest(versionDir: string): UpdateManifest | null;
/** 下载更新包，瞬时网络失败和 502/503/504 最多重试三次。 */
export declare function downloadWithRetry(url: string, destPath: string, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void>): Promise<void>;
export declare class Daemon {
    private readonly appDir;
    private readonly artifact;
    private readonly probeUrl;
    private readonly log;
    private readonly versions;
    private readonly retention;
    private retentionTimer;
    private child;
    private childStartedAt;
    private updating;
    private stopping;
    private crashCount;
    private pendingVersion;
    /** 后台 prepare 任务（受理后下载/校验/解压）；apply 前必须等待完成 */
    private prepareTask;
    private nodePath;
    private updater;
    constructor(config: DaemonConfig);
    start(): Promise<void>;
    /** 优雅停机：置停机标志并停掉被守护进程 */
    private shutdown;
    /** 更新流程：preStart 钩子 → stop/switch/start/probe/回退 */
    private applyUpdate;
    /** 启动 current 版本进程（含 ensure-node） */
    private startCurrent;
    /** 崩溃退避拉起（运行满 30s 视为稳定，计数清零；超上限放弃） */
    private scheduleRestart;
    private stableSinceMs;
    private lastStartAt;
    private stopChild;
    /** 健康探活：server 走 HTTP + 版本匹配；client 需存活超过稳定窗口（秒退进程判失败） */
    private probe;
    private initializeRetention;
    private scheduleRetentionStartupCleanup;
    private cancelRetentionStartupCleanup;
    private runRetentionCleanup;
    private onSuccessfulApply;
    private buildUpdater;
}
/** 从环境变量加载配置 */
export declare function loadConfigFromEnv(): DaemonConfig;
