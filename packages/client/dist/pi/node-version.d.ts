/** Pi 运行所需的最低 Node 版本（与 Pi Web 一致） */
export declare const MIN_NODE_MAJOR = 22;
export declare const MIN_NODE_MINOR = 19;
/**
 * 判断 Node 版本是否满足 Pi capability 门槛（>= 22.19.0）。
 * 只做语义化比较，不解析预发布/构建元数据。
 */
export declare function isSupportedNodeVersion(version: string): boolean;
