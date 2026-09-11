"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveSafePath = resolveSafePath;
exports.handleFileOp = handleFileOp;
const node_path_1 = require("node:path");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const filesystem_roots_js_1 = require("./filesystem-roots.js");
const isWin = (0, node_os_1.platform)() === "win32";
const normPath = (p) => {
    const s = (0, node_path_1.resolve)(p).replace(/\\/g, "/");
    return isWin ? s.toLowerCase() : s;
};
/** 路径安全校验 + 规范化 */
async function resolveSafePath(rootDir, userPath) {
    const resolvedRoot = normPath(rootDir);
    const resolved = normPath((0, node_path_1.resolve)(resolvedRoot, userPath));
    // root = "/" 时前缀就是 "/"，不用补斜杠
    const prefix = resolvedRoot.endsWith("/") ? resolvedRoot : resolvedRoot + "/";
    if (!resolved.startsWith(prefix) && resolved !== resolvedRoot) {
        throw {
            code: shared_1.FileErrorCode.PATH_NOT_ALLOWED,
            message: "Path escapes rootDir",
        };
    }
    // realpath 防 symlink 逃逸（仅在文件已存在时有效）
    try {
        const real = normPath(await (0, promises_1.realpath)(resolved));
        if (!real.startsWith(prefix) && real !== resolvedRoot) {
            throw {
                code: shared_1.FileErrorCode.PATH_NOT_ALLOWED,
                message: "Symlink escapes rootDir",
            };
        }
    }
    catch {
        // 文件不存在时 realpath 抛错，前缀检查已覆盖
    }
    return resolved;
}
function emitDone(socket, jobId, type, result) {
    socket.emit(shared_1.Events.JOB_DONE, { jobId, type, result });
}
function emitError(socket, jobId, type, code, message) {
    socket.emit(shared_1.Events.JOB_DONE, {
        jobId,
        type,
        error: { code, message },
    });
}
/** 处理轻量 fs 操作 */
async function handleFileOp(job, socket) {
    const { jobId, type, payload } = job;
    const rootDir = payload.rootDir;
    try {
        switch (type) {
            case "file.list": {
                const safe = await resolveSafePath(rootDir, payload.path);
                const dirents = await (0, promises_1.readdir)(safe, { withFileTypes: true });
                const results = await Promise.allSettled(dirents.map(async (d) => {
                    const st = await (0, promises_1.stat)((0, node_path_1.resolve)(safe, d.name));
                    return {
                        name: d.name,
                        kind: (d.isDirectory() ? "dir" : "file"),
                        size: st.size,
                        mtime: st.mtime.toISOString(),
                    };
                }));
                const entries = results
                    .filter((r) => r.status === "fulfilled")
                    .map((r) => r.value);
                emitDone(socket, jobId, type, { entries });
                return;
            }
            case "file.stat": {
                const safe = await resolveSafePath(rootDir, payload.path);
                const st = await (0, promises_1.stat)(safe);
                emitDone(socket, jobId, type, {
                    name: payload.path.split(/[/\\]/).pop() || "",
                    kind: (st.isDirectory() ? "dir" : "file"),
                    size: st.size,
                    mtime: st.mtime.toISOString(),
                });
                return;
            }
            case "file.readText": {
                const maxBytes = payload.maxBytes ?? 262144;
                const safe = await resolveSafePath(rootDir, payload.path);
                const st = await (0, promises_1.stat)(safe);
                if (st.size > maxBytes) {
                    emitError(socket, jobId, type, shared_1.FileErrorCode.SIZE_EXCEEDED, `File larger than ${maxBytes} bytes`);
                    return;
                }
                const content = await (0, promises_1.readFile)(safe, "utf8");
                emitDone(socket, jobId, type, { content, size: st.size });
                return;
            }
            case "file.writeText": {
                const safe = await resolveSafePath(rootDir, payload.path);
                const content = payload.content;
                const tmpPath = `${safe}.vcpdeck-tmp-${(0, node_crypto_1.randomUUID)()}`;
                await (0, promises_1.writeFile)(tmpPath, content, "utf8");
                await (0, promises_1.rename)(tmpPath, safe);
                emitDone(socket, jobId, type, { path: safe });
                return;
            }
            case "file.mkdir": {
                const safe = await resolveSafePath(rootDir, payload.path);
                await (0, promises_1.mkdir)(safe, { recursive: true });
                emitDone(socket, jobId, type, { path: safe });
                return;
            }
            case "file.delete": {
                const safe = await resolveSafePath(rootDir, payload.path);
                const recursive = payload.recursive === true;
                if (!recursive) {
                    const st = await (0, promises_1.stat)(safe).catch(() => null);
                    if (st?.isDirectory()) {
                        const ents = await (0, promises_1.readdir)(safe);
                        if (ents.length > 0) {
                            emitError(socket, jobId, type, shared_1.FileErrorCode.PATH_CONFLICT, "Directory not empty; set recursive=true");
                            return;
                        }
                    }
                }
                await (0, promises_1.rm)(safe, { recursive, force: true });
                emitDone(socket, jobId, type, { path: safe });
                return;
            }
            case "file.move": {
                const src = await resolveSafePath(rootDir, payload.source);
                const dest = await resolveSafePath(rootDir, payload.destination);
                const overwrite = payload.overwrite === true;
                if (!overwrite) {
                    try {
                        await (0, promises_1.stat)(dest);
                        emitError(socket, jobId, type, shared_1.FileErrorCode.PATH_CONFLICT, "Destination exists; set overwrite=true");
                        return;
                    }
                    catch {
                        // dest 不存在，OK
                    }
                }
                await (0, promises_1.rename)(src, dest);
                emitDone(socket, jobId, type, { path: dest });
                return;
            }
            case "file.roots": {
                const roots = await (0, filesystem_roots_js_1.discoverRoots)();
                emitDone(socket, jobId, type, { roots });
                return;
            }
            default:
                throw new Error(`Unknown file op: ${type}`);
        }
    }
    catch (err) {
        if (err.code && typeof err.code === "string") {
            emitError(socket, jobId, type, err.code, err.message);
            return;
        }
        const code = err.code === "ENOENT"
            ? shared_1.FileErrorCode.PATH_NOT_FOUND
            : shared_1.FileErrorCode.IO_ERROR;
        emitError(socket, jobId, type, code, code === shared_1.FileErrorCode.PATH_NOT_FOUND ? "Path not found" : err.message);
    }
}
