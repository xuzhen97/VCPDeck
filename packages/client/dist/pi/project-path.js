"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.piError = piError;
exports.canonicalPath = canonicalPath;
exports.projectKeyFor = projectKeyFor;
exports.resolveProjectCwd = resolveProjectCwd;
const node_path_1 = require("node:path");
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
/** 稳定的项目路径错误（与 @vcpdeck/shared PiErrorCode 对齐） */
function piError(code, message) {
    return Object.assign(new Error(message), { code });
}
function canonicalPath(p) {
    const s = (0, node_path_1.resolve)(p).replace(/\\/g, "/");
    return process.platform === "win32" ? s.toLowerCase() : s;
}
function samePath(a, b) {
    return canonicalPath(a) === canonicalPath(b);
}
/**
 * 进程级随机 secret：同一 Client 进程内 projectKey 稳定，重启后变化。
 * 只用于 HMAC 计算，绝不外传。
 */
let processSecret = null;
function getProcessSecret() {
    if (!processSecret)
        processSecret = (0, node_crypto_1.randomBytes)(32).toString("hex");
    return processSecret;
}
/**
 * 计算项目不透明 key：HMAC-SHA-256(canonicalPath, processSecret)。
 * 相同 canonical cwd 的别名得到同 key；不同 cwd 不同；Client 重启后改变。
 */
function projectKeyFor(canonicalPath, secret = getProcessSecret()) {
    return (0, node_crypto_1.createHmac)("sha256", secret).update(canonicalPath).digest("hex");
}
/**
 * 将 Files roots 选择的目录解析为 canonical cwd + 不透明 projectKey。
 * - 请求的 root 必须属于允许 roots（realpath 解析）；
 * - 目标目录 realpath 后必须仍在 root 内（防 symlink 逃逸）；
 * - 目标必须是目录；
 * - Windows 下 canonical 比较大小写不敏感。
 * 不复用会吞掉自身异常的 resolveSafePath()。
 */
async function resolveProjectCwd(ref, roots) {
    const requestedRoot = await (0, promises_1.realpath)((0, node_path_1.resolve)(ref.rootDir)).catch(() => {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project root is not accessible");
    });
    const allowed = await Promise.all(roots.map((root) => (0, promises_1.realpath)((0, node_path_1.resolve)(root)).catch(() => "")));
    if (!allowed.some((root) => root !== "" && samePath(root, requestedRoot))) {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project root is not allowed");
    }
    const cwd = await (0, promises_1.realpath)((0, node_path_1.resolve)(requestedRoot, ref.relativePath)).catch(() => {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project path is not accessible");
    });
    const rel = (0, node_path_1.relative)(requestedRoot, cwd);
    if (rel === ".." || rel.startsWith(`..${node_path_1.sep}`) || (0, node_path_1.isAbsolute)(rel)) {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project path escapes root");
    }
    const st = await (0, promises_1.stat)(cwd).catch(() => {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project path is not accessible");
    });
    if (!st.isDirectory()) {
        throw piError("PI_PROJECT_NOT_ALLOWED", "Project path must be a directory");
    }
    return { cwd, key: projectKeyFor(canonicalPath(cwd)) };
}
