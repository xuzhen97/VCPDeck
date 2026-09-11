"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_NODE_MINOR = exports.MIN_NODE_MAJOR = void 0;
exports.isSupportedNodeVersion = isSupportedNodeVersion;
/** Pi 运行所需的最低 Node 版本（与 Pi Web 一致） */
exports.MIN_NODE_MAJOR = 22;
exports.MIN_NODE_MINOR = 19;
/**
 * 判断 Node 版本是否满足 Pi capability 门槛（>= 22.19.0）。
 * 只做语义化比较，不解析预发布/构建元数据。
 */
function isSupportedNodeVersion(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match)
        return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > exports.MIN_NODE_MAJOR)
        return true;
    if (major < exports.MIN_NODE_MAJOR)
        return false;
    if (minor > exports.MIN_NODE_MINOR)
        return true;
    return minor >= exports.MIN_NODE_MINOR;
}
