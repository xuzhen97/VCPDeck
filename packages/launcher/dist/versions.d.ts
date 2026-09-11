export interface VersionStoreOptions {
    /** 应用目录下的 apps/ 目录 */
    appsDir: string;
    /** 切换策略：win32 用指针文件，其余用 symlink */
    platform?: NodeJS.Platform;
    /** 测试注入 */
    fs?: VersionFsOps;
}
/** VersionStore 用到的最小 fs 操作集（同步项用于原子切换） */
export interface VersionFsOps {
    readFile(path: string, encoding: "utf-8"): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readlink(path: string): Promise<string>;
    symlinkSync(target: string, path: string): void;
    renameSync(oldPath: string, newPath: string): void;
    unlinkSync(path: string): void;
    existsSync(path: string): boolean;
    rm(path: string): Promise<void>;
}
export declare class VersionStore {
    private readonly appsDir;
    private readonly isWindows;
    private readonly stateFile;
    private readonly fs;
    constructor(options: VersionStoreOptions);
    /** 当前生效版本；未切换过返回 null */
    currentVersion(): Promise<string | null>;
    /** 切换 current 到指定版本（原子） */
    switchTo(version: string): Promise<void>;
    /** 全部已解压版本目录（x.y.z 命名） */
    listVersions(): Promise<string[]>;
    /** 版本目录路径（解压目标） */
    versionDir(version: string): string;
    /** 判断指定构件的版本目录是否完整可启动 */
    isPrepared(version: string, artifact: "server" | "client"): Promise<boolean>;
    /** 删除不完整版本目录 */
    removeVersion(version: string): Promise<void>;
    /** 版本目录存在性（解压结果校验用） */
    exists(version: string): boolean;
    private writeStateFileAtomic;
}
