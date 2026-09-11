import type { VersionStore } from "./versions.js";
export interface RetentionState {
    successfulVersions: string[];
}
export interface RetentionCleanupResult {
    removed: string[];
    failed: string[];
    disabled: boolean;
}
export interface VersionRetentionFsOps {
    readFile(path: string, encoding: "utf-8"): Promise<string>;
    writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(path: string): Promise<void>;
}
export interface VersionRetentionOptions {
    appsDir: string;
    versions: Pick<VersionStore, "currentVersion" | "listVersions" | "removeVersion">;
    /** 测试注入；生产使用 node:fs/promises。 */
    fs?: VersionRetentionFsOps;
}
export declare class VersionRetention {
    private readonly options;
    private readonly stateFile;
    private readonly tempStateFile;
    private state;
    private initialized;
    private disabled;
    private readonly fs;
    constructor(options: VersionRetentionOptions);
    /** 读取或建立保留状态；状态不可信时停用自动清理。 */
    initialize(): Promise<void>;
    /** 记录一次已通过探活的成功切换，并将其置于历史首位。 */
    recordSuccessful(version: string): Promise<boolean>;
    /** 清理不在 current、最近两个成功历史或调用方保护集合中的版本目录。 */
    cleanup(protectedVersions?: ReadonlySet<string>): Promise<RetentionCleanupResult>;
    private initializeMissingState;
    private writeState;
}
