import type { VersionStore } from "./versions.js";
export interface UpdaterDeps {
    versions: VersionStore;
    artifact: "server" | "client";
    /** 下载 zip 到目标路径 */
    downloadZip(url: string, destPath: string): Promise<void>;
    /** 流式 sha256 校验 */
    verifySha256(filePath: string, expected: string): Promise<boolean>;
    /** 解压 zip 到目标目录 */
    extractZip(zipPath: string, destDir: string): Promise<void>;
    /** 停止当前被守护进程 */
    stopProcess(): Promise<void>;
    /** 启动 current 版本进程 */
    startProcess(): Promise<unknown>;
    /** 健康探活（服务端：GET /api/status；客户端：进程存活） */
    probe(version: string): Promise<boolean>;
    /** 成功切换后的尽力记录钩子；失败不得影响已经健康的版本 */
    onSuccessfulApply?: (version: string, previous: string | null) => Promise<void>;
    probeRetries?: number;
    probeIntervalMs?: number;
}
export declare class Updater {
    private readonly deps;
    constructor(deps: UpdaterDeps);
    /** 第一阶段：准备新版本（完整版本目录幂等跳过） */
    prepare(input: {
        url: string;
        sha256: string;
        version: string;
    }): Promise<void>;
    /** 第二阶段：切换并启动新版本；探活失败自动回退 */
    apply(version: string): Promise<void>;
    private probeWithRetry;
}
