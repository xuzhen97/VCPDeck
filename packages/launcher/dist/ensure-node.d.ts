export interface NodeRuntimeOptions {
    /** 版本约束，如 ">=24"（只比较主版本） */
    constraint: string;
    /** Node 运行时缓存目录（launcher/node/） */
    cacheDir: string;
    platform?: NodeJS.Platform;
    arch?: string;
    /** 下载源基址，默认 https://nodejs.org/dist，可配镜像 */
    downloadBase?: string;
    /** 当前运行 Launcher 的 Node；默认使用 process.version/process.execPath。 */
    currentRuntime?: {
        version: string;
        execPath: string;
    };
    /** 测试注入 */
    execNodeVersion?: () => Promise<string | null>;
    fetchIndex?: () => Promise<Array<{
        version: string;
    }>>;
    downloadAndExtract?: (version: string, cacheDir: string, ctx: {
        platform: string;
        arch: string;
        downloadBase: string;
    }) => Promise<string>;
}
/** ">=24" 约束只比较主版本；非法返回 false */
export declare function satisfiesConstraint(version: string, constraint: string): boolean;
/** 解析 `node -v` 输出（"v24.5.0\n" → "24.5.0"） */
export declare function parseNodeVersion(output: string): string | null;
/**
 * 确保 Node 运行时可用，返回当前、系统或缓存内 Node 的可执行文件路径。
 */
export declare function ensureNodeRuntime(options: NodeRuntimeOptions): Promise<string>;
/**
 * 把官方压缩包解压出的顶层目录（node-v<version>-<plat>-<arch>）归一化为缓存
 * 标准布局 node-<version>，并校验二进制存在；与 findCachedRuntime/nodeBinPath
 * 的约定保持一致。返回校验后的可执行文件路径。
 */
export declare function normalizeNodeCacheLayout(version: string, cacheDir: string, platform: string, arch: string): string;
