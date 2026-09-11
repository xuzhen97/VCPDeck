import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { JobStatus } from "@vcpdeck/shared";
import { createAuthenticatedClient } from "./authenticated-client.js";
import { parseCommandArgs, stringOption } from "./arguments.js";
import { resolveClientId } from "./client-resolver.js";
import { formatEnvironmentSummary, resolveEnvironment } from "./environment.js";
import { waitForTerminalJob } from "./jobs-command.js";
const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;
const POLL_INTERVAL_MS = 1_000;
/** 执行 Files 命令组（当前只读：roots/list/stat/read）。 */
export async function runFilesCommand(subcommand, argv, context = {}) {
    const helpRequested = subcommand === "--help" ||
        subcommand === "-h" ||
        ((subcommand === "roots" ||
            subcommand === "list" ||
            subcommand === "stat" ||
            subcommand === "read" ||
            subcommand === "write" ||
            subcommand === "mkdir" ||
            subcommand === "delete" ||
            subcommand === "move" ||
            subcommand === "download" ||
            subcommand === "upload" ||
            subcommand === undefined) &&
            hasHelp(argv));
    if (helpRequested) {
        (context.log ?? console.log)(filesUsage());
        return;
    }
    if (subcommand === "roots") {
        await runRoots(argv, context);
        return;
    }
    if (subcommand === "list") {
        await runList(argv, context);
        return;
    }
    if (subcommand === "stat") {
        await runStat(argv, context);
        return;
    }
    if (subcommand === "read") {
        await runRead(argv, context);
        return;
    }
    if (subcommand === "write") {
        await runWrite(argv, context);
        return;
    }
    if (subcommand === "mkdir") {
        await runMkdir(argv, context);
        return;
    }
    if (subcommand === "delete") {
        await runDelete(argv, context);
        return;
    }
    if (subcommand === "move") {
        await runMove(argv, context);
        return;
    }
    if (subcommand === "download") {
        await runDownload(argv, context);
        return;
    }
    if (subcommand === "upload") {
        await runUpload(argv, context);
        return;
    }
    throw new Error(filesUsage());
}
function hasHelp(argv) {
    return argv.includes("--help") || argv.includes("-h");
}
function filesUsage() {
    return [
        "Files 命令:",
        "  只读:",
        "  vcpdeck files roots <client> [--env=<name>] [--json]",
        "  vcpdeck files list <client> <path> [--root=<dir>] [--env=<name>] [--json]",
        "  vcpdeck files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]",
        "  vcpdeck files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]",
        "  # 缺省 --root 时自动探测：唯一根直接使用，多根要求显式指定",
        "  写操作（调用方须先取得用户确认）:",
        "  vcpdeck files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]  # 覆盖写；缺省 --input 时读 stdin",
        "  vcpdeck files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]  # 递归创建",
        "  vcpdeck files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]  # 不可恢复",
        "  vcpdeck files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
        "  传输（调用方须先取得用户确认；字节流走 Storage Provider 直传，不经 Server 中转）:",
        "  vcpdeck files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]",
        "  vcpdeck files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
    ].join("\n");
}
/** 创建只读文件 Job 并等待终态；非 done 终态转为带稳定错误码的异常。 */
async function runFileJob(client, clientId, type, payload, context) {
    const created = await client.jobs.create({ clientId, type, payload });
    const job = await waitForTerminalJob(client, created.jobId, DEFAULT_WAIT_TIMEOUT_SECONDS, () => { }, context.pollIntervalMs ?? POLL_INTERVAL_MS);
    if (job.status !== JobStatus.DONE)
        throw formatFileJobFailure(job);
    return job.result;
}
function formatFileJobFailure(job) {
    const result = (job.result ?? {});
    const code = job.errorCode ??
        (typeof result.errorCode === "string" ? result.errorCode : null);
    const message = job.errorMessage ??
        (typeof result.errorMessage === "string" ? result.errorMessage : null);
    return new Error(`文件操作失败（${job.status}${code ? `/${code}` : ""}）${message ? `：${message}` : ""}`);
}
/** 解析授权根：显式 --root 优先；缺省时探测唯一根，多根 fail closed。 */
async function resolveRootDir(client, clientId, explicitRoot, context) {
    if (explicitRoot)
        return explicitRoot;
    const roots = await fetchRoots(client, clientId, context);
    if (roots.length === 1)
        return roots[0];
    if (roots.length === 0)
        throw new Error("目标机未报告可用根目录");
    throw new Error(`目标机有多个可用根（${roots.join("、")}）；请用 --root=<dir> 指定授权根`);
}
/** file.roots 的 Job result 形状为 { roots: string[] }。 */
async function fetchRoots(client, clientId, context) {
    const result = await runFileJob(client, clientId, "file.roots", {}, context);
    return Array.isArray(result?.roots) ? result.roots : [];
}
function parseMaxBytes(raw) {
    if (raw === undefined)
        return undefined;
    const bytes = Number(raw);
    if (!Number.isInteger(bytes) || bytes < 1) {
        throw new Error("--max-bytes 必须是不小于 1 的整数");
    }
    return bytes;
}
function parseFileArgs(argv, extraValueOptions = [], booleanOptions = [], requirePath = false) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "root", ...extraValueOptions],
        boolean: ["json", ...booleanOptions],
    });
    const [clientFilter, path] = positionals;
    if (!clientFilter || (requirePath && !path))
        throw new Error(filesUsage());
    return { clientFilter, path, options };
}
/** 子命令公共前半段：环境解析、认证客户端与 clientId 解析。 */
async function openContext(context, options) {
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    return { environment, client };
}
async function runRoots(argv, context) {
    const { clientFilter, options } = parseFileArgs(argv, [], [], false);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const roots = await fetchRoots(client, clientId, context);
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(roots, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log(`可用根目录（${roots.length}）：`);
    for (const root of roots)
        log(`  ${root}`);
}
async function runList(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const entries = await runFileJob(client, clientId, "file.list", { rootDir, path }, context);
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(entries, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log(formatListing(rootDir, path, entries.entries));
}
function formatListing(rootDir, path, entries) {
    if (entries.length === 0)
        return `${joinDisplayPath(rootDir, path)}：空目录`;
    const sorted = [...entries].sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    const dirCount = sorted.filter((entry) => entry.kind === "dir").length;
    const lines = sorted.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        size: entry.kind === "dir" ? "-" : String(entry.size),
        mtime: entry.mtime,
    }));
    return [
        `${joinDisplayPath(rootDir, path)}：共 ${sorted.length} 项 · 目录 ${dirCount} · 文件 ${sorted.length - dirCount}`,
        formatTable(lines, ["name", "kind", "size", "mtime"]),
    ].join("\n");
}
function joinDisplayPath(rootDir, path) {
    return `${rootDir.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}
async function runStat(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const stat = await runFileJob(client, clientId, "file.stat", { rootDir, path }, context);
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(stat, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log([
        `Path: ${joinDisplayPath(rootDir, path)}`,
        `Kind: ${stat.kind}`,
        `Size: ${stat.size}`,
        `Mtime: ${stat.mtime}`,
    ].join("\n"));
}
async function runRead(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, ["max-bytes"], [], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const maxBytes = parseMaxBytes(stringOption(options, "max-bytes"));
    const result = await runFileJob(client, clientId, "file.readText", { rootDir, path, ...(maxBytes === undefined ? {} : { maxBytes }) }, context);
    if (options.json === true) {
        (context.log ?? console.log)(JSON.stringify(result, null, 2));
        return;
    }
    const log = context.log ?? console.log;
    log(formatEnvironmentSummary(environment));
    log(`── ${joinDisplayPath(rootDir, path)}（${result.size} bytes）──`);
    log(result.content.trimEnd());
}
/** 写操作公共尾部：输出结果摘要。 */
function logChangeResult(log, action, displayPath, result, xtra) {
    log(`[vcpdeck] 已${action}: ${result.path ?? displayPath}${xtra ? `（${xtra}）` : ""}`);
}
/** 读取写入内容：--input 本地文件优先，否则读 stdin（避免秘密进 argv）。 */
async function readWriteContent(options) {
    const input = stringOption(options, "input");
    if (input)
        return readFile(input, "utf8");
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}
/** 在目标机上写入文本文件（写操作；原子覆盖写）。 */
async function runWrite(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, ["input"], [], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const content = await readWriteContent(options);
    const bytes = Buffer.byteLength(content, "utf8");
    const log = context.log ?? console.log;
    if (options.json !== true) {
        log(formatEnvironmentSummary(environment));
        log(`[vcpdeck] 写入 ${clientFilter}:${joinDisplayPath(rootDir, path)}（${bytes} bytes，覆盖已有文件）`);
    }
    const result = await runFileJob(client, clientId, "file.writeText", { rootDir, path, content }, context);
    if (options.json === true) {
        log(JSON.stringify({ ...result, bytes }, null, 2));
        return;
    }
    logChangeResult(log, "写入", joinDisplayPath(rootDir, path), result, `${bytes} bytes`);
}
/** 递归创建目录（写操作）。 */
async function runMkdir(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const log = context.log ?? console.log;
    if (options.json !== true)
        log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] 创建目录 ${clientFilter}:${joinDisplayPath(rootDir, path)}（递归）`);
    const result = await runFileJob(client, clientId, "file.mkdir", { rootDir, path }, context);
    if (options.json === true) {
        log(JSON.stringify(result, null, 2));
        return;
    }
    logChangeResult(log, "创建目录", joinDisplayPath(rootDir, path), result);
}
/** 删除文件或目录（写操作、不可恢复）；非递归遇非空目录由 Server 报 PATH_CONFLICT。 */
async function runDelete(argv, context) {
    const { clientFilter, path, options } = parseFileArgs(argv, [], ["recursive"], true);
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const recursive = options.recursive === true;
    const payload = { rootDir, path };
    if (recursive)
        payload.recursive = true;
    const log = context.log ?? console.log;
    if (options.json !== true)
        log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] 删除 ${clientFilter}:${joinDisplayPath(rootDir, path)}${recursive ? "（递归删除整个目录树，不可恢复）" : "（不可恢复）"}`);
    const result = await runFileJob(client, clientId, "file.delete", payload, context);
    if (options.json === true) {
        log(JSON.stringify(result, null, 2));
        return;
    }
    logChangeResult(log, "删除", joinDisplayPath(rootDir, path), result);
}
/** 移动/重命名（写操作）；目标存在时默认拒绝，--overwrite 解锁。 */
async function runMove(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "root"],
        boolean: ["json", "overwrite"],
    });
    const [clientFilter, source, destination] = positionals;
    if (!clientFilter || !source || !destination)
        throw new Error(filesUsage());
    const { environment, client } = await openContext(context, options);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const overwrite = options.overwrite === true;
    const payload = { rootDir, source, destination };
    if (overwrite)
        payload.overwrite = true;
    const log = context.log ?? console.log;
    if (options.json !== true)
        log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] 移动 ${clientFilter}:${joinDisplayPath(rootDir, source)} → ${joinDisplayPath(rootDir, destination)}${overwrite ? "（覆盖目标）" : ""}`);
    const result = await runFileJob(client, clientId, "file.move", payload, context);
    if (options.json === true) {
        log(JSON.stringify(result, null, 2));
        return;
    }
    logChangeResult(log, "移动", joinDisplayPath(rootDir, source), result);
}
/** 从目标机导出文件并经 Storage 签名 URL 拉取到本地（写本地磁盘；URL 不输出不落盘）。 */
async function runDownload(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "root"],
        boolean: ["json"],
    });
    const [clientFilter, remotePath, localPath] = positionals;
    if (!clientFilter || !remotePath || !localPath) {
        throw new Error(filesUsage());
    }
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const log = context.log ?? console.log;
    if (options.json !== true) {
        log(formatEnvironmentSummary(environment));
        log(`[vcpdeck] 导出 ${clientFilter}:${joinDisplayPath(rootDir, remotePath)} → ${localPath}（Storage 直传链路）`);
    }
    const transfer = await runFileJob(client, clientId, "file.export", { rootDir, path: remotePath }, context);
    // Server 只签发短期下载令牌：阿里云为 Provider 直链，Local 为签名中转（相对地址需拼 Server）
    const token = await client.storage.createDownloadToken({ key: transfer.key });
    const actualSha256 = await fetchToFile(resolveServerUrl(environment.server, token.url), localPath, context);
    if (actualSha256 !== transfer.sha256) {
        await unlink(localPath).catch(() => { });
        throw new Error(`下载文件 SHA-256 不一致（期望 ${transfer.sha256}，实际 ${actualSha256}），已删除本地半成品`);
    }
    if (options.json === true) {
        log(JSON.stringify({ ...transfer, localPath }, null, 2));
        return;
    }
    log(`[vcpdeck] 已下载 ${localPath}（${transfer.size} bytes，sha256 校验通过）`);
}
/** 流式下载到本地文件并计算 sha256；签名 URL 不输出、不落盘。 */
async function fetchToFile(url, localPath, context) {
    const fetcher = context.directFetch ?? globalThis.fetch;
    const response = await fetcher(url);
    if (!response.ok || !response.body) {
        throw new Error(`文件下载失败：HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
        for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
        }
    }, createWriteStream(localPath));
    return hash.digest("hex");
}
/** 上传本地文件到目标机（写操作）：先直传 Storage 再由 Client 拉取导入。 */
async function runUpload(argv, context) {
    const { positionals, options } = parseCommandArgs(argv, {
        value: ["env", "environment", "root"],
        boolean: ["json", "overwrite"],
    });
    const [clientFilter, localPath, remotePath] = positionals;
    if (!clientFilter || !localPath || !remotePath) {
        throw new Error(filesUsage());
    }
    const fileStat = await stat(localPath).catch(() => null);
    if (!fileStat?.isFile()) {
        throw new Error(`本地文件不存在或不是普通文件: ${localPath}`);
    }
    const size = fileStat.size;
    const filename = localPath.split(/[\\/]/).pop() ?? "upload.bin";
    const environment = await resolveEnvironment({
        environment: exclusiveAlias(options, "env", "environment"),
        paths: context.paths,
        processEnv: context.processEnv,
    });
    const client = await createAuthenticatedClient(environment);
    const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
    const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
    const overwrite = options.overwrite === true;
    const log = context.log ?? console.log;
    const progressLog = options.json === true ? () => { } : log;
    if (options.json !== true) {
        log(formatEnvironmentSummary(environment));
        log(`[vcpdeck] 上传 ${localPath} → ${clientFilter}:${joinDisplayPath(rootDir, remotePath)}（${size} bytes，Storage 直传链路）`);
    }
    const session = await client.files.createUploadSession({
        clientId,
        rootDir,
        targetPath: remotePath,
        filename,
        size,
        ...(overwrite ? { overwrite: true } : {}),
    });
    progressLog(`[vcpdeck] 上传模式: ${session.upload.kind}`);
    await uploadToTarget(client, localPath, size, session.upload, environment.server, session.jobId, progressLog, context);
    const created = await client.files.completeUpload(session.jobId, {
        uploadedBytes: size,
    });
    progressLog(`[vcpdeck] 导入 Job: ${created.jobId}（${created.status}），等待目标机拉取…`);
    const job = await waitForTerminalJob(client, created.jobId, DEFAULT_WAIT_TIMEOUT_SECONDS, () => { }, context.pollIntervalMs ?? POLL_INTERVAL_MS);
    if (job.status !== JobStatus.DONE)
        throw formatFileJobFailure(job);
    const imported = job.result;
    if (options.json === true) {
        log(JSON.stringify({ fileId: session.fileId, jobId: created.jobId, ...imported, localPath }, null, 2));
        return;
    }
    log(`[vcpdeck] 已上传 ${localPath} → ${imported.path ?? remotePath}（${imported.size} bytes，sha256=${imported.sha256.slice(0, 12)}…）`);
}
/** 按 UploadTarget 分派：proxy 整体 PUT 签名 URL；direct 分片 PUT 预签名 URL。 */
async function uploadToTarget(client, localPath, size, upload, baseUrl, jobId, progressLog, context) {
    if (upload.kind === "proxy") {
        const fetcher = context.directFetch ?? globalThis.fetch;
        const response = await fetcher(resolveServerUrl(baseUrl, upload.url), {
            method: "PUT",
            headers: { "Content-Length": String(size) },
            body: createReadStream(localPath),
            duplex: "half",
        });
        if (!response.ok)
            throw new Error(`文件上传失败：HTTP ${response.status}`);
        return;
    }
    if (upload.kind !== "direct")
        throw new Error("Server 返回未知上传模式");
    const parts = [...upload.parts].sort((a, b) => a.partNumber - b.partNumber);
    const expectedParts = Math.ceil(size / upload.partSize);
    if (upload.partSize < 1 ||
        parts.length !== expectedParts ||
        parts.some((part, index) => part.partNumber !== index + 1)) {
        throw new Error("Server 返回的上传分片不完整");
    }
    const handle = await open(localPath, "r");
    try {
        for (const part of parts) {
            const start = (part.partNumber - 1) * upload.partSize;
            const length = Math.min(upload.partSize, size - start);
            const bytes = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(bytes, 0, length, start);
            if (bytesRead !== length) {
                throw new Error(`读取分片 ${part.partNumber} 不完整`);
            }
            await putFilePart(client, jobId, part.partNumber, part.url, bytes, context);
            progressLog(`[vcpdeck] 直传进度 ${Math.min(100, ((start + length) / size) * 100).toFixed(1)}%`);
        }
    }
    finally {
        await handle.close();
    }
}
function resolveServerUrl(baseUrl, url) {
    try {
        new URL(url); // 绝对地址原样使用
        return url;
    }
    catch {
        return `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 分片直传；403 时经 Server 刷新该分片 URL 后重试（构件不经过 Server）。 */
async function putFilePart(client, jobId, partNumber, initialUrl, bytes, context) {
    const fetcher = context.directFetch ?? globalThis.fetch;
    let url = initialUrl;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetcher(url, {
                method: "PUT",
                headers: {
                    "Content-Type": "",
                    "Content-Length": String(bytes.length),
                },
                body: bytes,
            });
            if (response.ok)
                return;
            if (response.status === 403 && attempt < 2) {
                const refreshed = await client.files.refreshUploadPartUrls(jobId, [
                    partNumber,
                ]);
                url = refreshed.find((part) => part.partNumber === partNumber)?.url ?? "";
                if (!url)
                    throw new Error(`分片 ${partNumber} URL 刷新失败`);
                continue;
            }
            lastError = new Error(`分片 ${partNumber} 上传失败：HTTP ${response.status}`);
            if (response.status < 500)
                break;
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
        if (attempt < 2)
            await sleep(500 * (attempt + 1));
    }
    throw lastError ?? new Error(`分片 ${partNumber} 上传失败`);
}
function exclusiveAlias(options, first, second) {
    const firstValue = stringOption(options, first);
    const secondValue = stringOption(options, second);
    if (firstValue && secondValue) {
        throw new Error(`--${first} 与 --${second} 不能同时使用`);
    }
    return firstValue ?? secondValue;
}
/** 无依赖的简易对齐表格；首行为表头。 */
function formatTable(rows, columns) {
    const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
    const line = (cells) => cells
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .trimEnd();
    return [
        line(columns.map((column) => column.toUpperCase())),
        ...rows.map((row) => line(columns.map((column) => row[column]))),
    ].join("\n");
}
