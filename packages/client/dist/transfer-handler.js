"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTransfer = handleTransfer;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
const promises_2 = require("node:stream/promises");
const node_stream_1 = require("node:stream");
const shared_1 = require("@vcpdeck/shared");
const file_handler_js_1 = require("./file-handler.js");
const SERVER_BASE = process.env.VCPDECK_SERVER || "http://localhost:3001";
const CLIENT_PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
const EXPORT_CONTROL_HEADERS = {
    "content-type": "application/json",
    "x-vcpdeck-psk": CLIENT_PSK,
};
/** 将相对 URL 转为绝对 URL；绝对 URL 必须与 Server 同源，防止拉取任意内网地址 */
function absUrl(path) {
    if (path.startsWith("http://") || path.startsWith("https://")) {
        let base;
        let target;
        try {
            base = new URL(SERVER_BASE);
            target = new URL(path);
        }
        catch {
            throw new Error("Invalid transfer URL");
        }
        if (target.origin !== base.origin) {
            throw new Error(`Blocked URL outside server origin: ${target.origin}`);
        }
        return path;
    }
    return `${SERVER_BASE}${path}`;
}
// ── 直传（阿里云 OSS 分片） ──
const PART_CONCURRENCY = 3;
const PART_RETRIES = 2;
/** 按 parts 并发 PUT 分片；403 时调 refreshUrl 续期后重试 */
async function uploadParts(parts, size, opts) {
    const partSize = opts.partSize;
    let loaded = 0;
    const queue = [...parts];
    async function worker() {
        while (queue.length > 0) {
            const part = queue.shift();
            if (part === undefined)
                return;
            const start = (part.partNumber - 1) * partSize;
            const end = Math.min(size, start + partSize);
            let url = part.url;
            for (let attempt = 0;; attempt++) {
                const res = await fetch(url, {
                    method: "PUT",
                    body: await opts.readPart(part.partNumber, start, end),
                    signal: opts.signal,
                    duplex: "half",
                });
                if (res.ok)
                    break;
                if (res.status === 403 && attempt < PART_RETRIES) {
                    url = await opts.refreshUrl(part.partNumber);
                    continue;
                }
                if (attempt < PART_RETRIES)
                    continue;
                throw new Error(`分片 ${part.partNumber} 上传失败: HTTP ${res.status}`);
            }
            loaded += end - start;
            opts.onProgress?.(loaded);
        }
    }
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, () => worker()));
}
/** 协商导出直传会话（Server 建阿里云分片任务） */
async function negotiateExportSession(jobId, size) {
    const res = await fetch(absUrl("/api/files/client-export-sessions"), {
        method: "POST",
        headers: EXPORT_CONTROL_HEADERS,
        body: JSON.stringify({ jobId, size }),
    });
    if (!res.ok)
        throw new Error(`Export session failed: HTTP ${res.status}`);
    return (await res.json());
}
/** 续期指定分片的上传 URL */
async function refreshExportPartUrl(jobId, partNumber) {
    const res = await fetch(absUrl(`/api/files/client-export-sessions/${jobId}/part-urls`), {
        method: "POST",
        headers: EXPORT_CONTROL_HEADERS,
        body: JSON.stringify({ partNumbers: [partNumber] }),
    });
    if (!res.ok)
        throw new Error(`刷新分片 URL 失败: HTTP ${res.status}`);
    const parts = (await res.json());
    const part = parts.find((p) => p.partNumber === partNumber);
    if (!part?.url)
        throw new Error("刷新分片 URL 未返回新地址");
    return part.url;
}
/** 完成导出直传，返回真实 storage key */
async function completeExportUpload(jobId, uploadedBytes) {
    const res = await fetch(absUrl(`/api/files/client-export-sessions/${jobId}/complete`), {
        method: "POST",
        headers: EXPORT_CONTROL_HEADERS,
        body: JSON.stringify({ uploadedBytes }),
    });
    if (!res.ok)
        throw new Error(`Export complete failed: HTTP ${res.status}`);
    const body = (await res.json());
    return body.key ?? "";
}
/** 顺序读整个文件计算 SHA-256（分片并发直传无法在传输中保持哈希顺序）。 */
function computeFileSha256(path) {
    return new Promise((resolve, reject) => {
        const hash = (0, node_crypto_1.createHash)("sha256");
        const stream = (0, node_fs_1.createReadStream)(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
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
async function handleTransfer(job, socket) {
    const { jobId, type, payload } = job;
    try {
        if (type === "file.export") {
            const path = payload.path;
            const rootDir = payload.rootDir;
            const uploadRef = payload.uploadRef;
            await handleExport(jobId, path, rootDir, uploadRef, socket);
            return;
        }
        if (type === "file.import") {
            const targetPath = payload.targetPath;
            const rootDir = payload.rootDir;
            const downloadRef = payload.downloadRef;
            const expectedSize = Number(payload.size ?? 0);
            const overwrite = payload.overwrite === true;
            await handleImport(jobId, targetPath, rootDir, downloadRef, expectedSize, overwrite, socket);
            return;
        }
        throw new Error(`Unknown transfer type: ${type}`);
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
async function handleExport(jobId, path, rootDir, uploadRef, socket) {
    const safe = await (0, file_handler_js_1.resolveSafePath)(rootDir, path);
    const fileStat = await (0, promises_1.stat)(safe);
    const total = fileStat.size;
    // 直连模式：Client stat 文件后协商直传会话，分片 PUT 到 OSS，最后完成导出
    if (uploadRef.direct) {
        const session = await negotiateExportSession(jobId, total);
        await uploadParts(session.parts, total, {
            partSize: session.partSize,
            readPart: async (_n, start, end) => node_stream_1.Readable.toWeb((0, node_fs_1.createReadStream)(safe, { start, end: end - 1 })),
            onProgress: (loaded) => socket.emit(shared_1.Events.JOB_PROGRESS, { jobId, loaded, total }),
            refreshUrl: (partNumber) => refreshExportPartUrl(jobId, partNumber),
        });
        const key = await completeExportUpload(jobId, total);
        const sha256 = await computeFileSha256(safe);
        emitDone(socket, jobId, "file.export", {
            fileId: uploadRef.id,
            key,
            size: total,
            sha256,
        });
        return;
    }
    const fileStream = (0, node_fs_1.createReadStream)(safe);
    // 传输段进度 + sha256：用 Transform 计数（toWeb 与 data 监听器在同一流上互斥，
    // 此前 hash 恒为空摘要且进度无法上报）
    const hash = (0, node_crypto_1.createHash)("sha256");
    let loaded = 0;
    let lastEmitAt = 0;
    let lastEmitBytes = 0;
    const hashTransform = new node_stream_1.Transform({
        transform(chunk, _encoding, callback) {
            hash.update(chunk);
            loaded += chunk.length;
            const now = Date.now();
            if (now - lastEmitAt >= 500 || loaded - lastEmitBytes >= 1024 * 1024) {
                lastEmitAt = now;
                lastEmitBytes = loaded;
                socket.emit(shared_1.Events.JOB_PROGRESS, { jobId, loaded, total });
            }
            callback(null, chunk);
        },
        flush(callback) {
            if (loaded !== lastEmitBytes) {
                lastEmitBytes = loaded;
                socket.emit(shared_1.Events.JOB_PROGRESS, { jobId, loaded, total });
            }
            callback();
        },
    });
    fileStream.pipe(hashTransform);
    // safe: uploadRef.url 由 Server 签发并校验签名，非任意 URL
    const webStream = node_stream_1.Readable.toWeb(hashTransform);
    const res = await fetch(absUrl(uploadRef.url), {
        method: "PUT",
        body: webStream,
        duplex: "half",
    });
    if (!res.ok) {
        emitError(socket, jobId, "file.export", shared_1.FileErrorCode.IO_ERROR, `Upload failed: HTTP ${res.status}`);
        return;
    }
    // 真实存储 key：阿里云盘后端上传后以 fileId 作为 key，由 Server 响应返回；
    // 忽略响应会导致后续下载签名使用错误 key（本地后端响应 key 与原 key 相同）
    const uploaded = (await res.json().catch(() => null));
    const sha256 = hash.digest("hex");
    emitDone(socket, jobId, "file.export", {
        fileId: uploadRef.id,
        key: uploaded?.key || uploadRef.key,
        size: uploaded?.size ?? fileStat.size,
        sha256,
    });
}
async function handleImport(jobId, targetPath, rootDir, downloadRef, expectedSize, overwrite, socket) {
    const safe = await (0, file_handler_js_1.resolveSafePath)(rootDir, targetPath);
    const tmpPath = `${safe}.vcpdeck-tmp-${(0, node_crypto_1.randomUUID)()}`;
    let loaded = 0;
    let lastEmitAt = 0;
    let lastEmitBytes = 0;
    try {
        // safe: downloadRef.url 由 Server 签发（proxy）或由阿里云 getDownloadUrl 生成（direct）
        const res = await fetch(downloadRef.direct ? downloadRef.url : absUrl(downloadRef.url), { method: "GET" });
        if (!res.ok) {
            emitError(socket, jobId, "file.import", shared_1.FileErrorCode.IO_ERROR, `Download failed: HTTP ${res.status}`);
            return;
        }
        const tracker = new node_stream_1.Transform({
            transform(chunk, _encoding, callback) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                loaded += buffer.length;
                const now = Date.now();
                if (now - lastEmitAt >= 500 || loaded - lastEmitBytes >= 1024 * 1024) {
                    lastEmitAt = now;
                    lastEmitBytes = loaded;
                    socket.emit(shared_1.Events.JOB_PROGRESS, {
                        jobId,
                        loaded,
                        total: expectedSize,
                    });
                }
                callback(null, buffer);
            },
            flush(callback) {
                if (loaded !== lastEmitBytes) {
                    lastEmitBytes = loaded;
                    socket.emit(shared_1.Events.JOB_PROGRESS, {
                        jobId,
                        loaded,
                        total: expectedSize,
                    });
                }
                callback();
            },
        });
        // fetch body 是 web ReadableStream，转为 Node stream 后再写入临时文件。
        const webBody = res.body;
        if (!webBody)
            throw new Error("Download response has no body");
        const nodeBody = node_stream_1.Readable.fromWeb(webBody);
        await (0, promises_2.pipeline)(nodeBody, tracker, (0, node_fs_1.createWriteStream)(tmpPath));
        if (loaded !== expectedSize) {
            await (0, promises_1.unlink)(tmpPath).catch(() => { });
            emitError(socket, jobId, "file.import", shared_1.FileErrorCode.IO_ERROR, `Size mismatch: expected ${expectedSize}, got ${loaded}`);
            return;
        }
        const existing = await (0, promises_1.stat)(safe).catch(() => null);
        if (existing?.isDirectory() || (existing && !overwrite)) {
            await (0, promises_1.unlink)(tmpPath).catch(() => { });
            emitError(socket, jobId, "file.import", shared_1.FileErrorCode.PATH_CONFLICT, "Destination exists; set overwrite=true");
            return;
        }
        if (existing && overwrite)
            await (0, promises_1.unlink)(safe);
        await (0, promises_1.rename)(tmpPath, safe);
        emitDone(socket, jobId, "file.import", {
            path: safe,
            key: downloadRef.key,
            size: loaded,
        });
    }
    catch (err) {
        await (0, promises_1.unlink)(tmpPath).catch(() => { });
        throw err;
    }
}
