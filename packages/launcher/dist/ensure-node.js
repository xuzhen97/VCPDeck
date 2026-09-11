"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.satisfiesConstraint = satisfiesConstraint;
exports.parseNodeVersion = parseNodeVersion;
exports.ensureNodeRuntime = ensureNodeRuntime;
exports.normalizeNodeCacheLayout = normalizeNodeCacheLayout;
/**
 * Node 运行时保障（详见 docs/design/release-and-update.md）：
 * 1) 系统 node 满足约束 → 直接用
 * 2) 否则检查缓存目录（launcher/node/node-<version>/）→ 命中即用
 * 3) 否则从 index.json 解析满足约束的最高版本 → 下载解压入缓存
 * 下载源默认官方，可配镜像（npmmirror）；参考 ensure-frpc.cjs 的复用模式。
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const archive_js_1 = require("./archive.js");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const DEFAULT_DOWNLOAD_BASE = "https://nodejs.org/dist";
/** ">=24" 约束只比较主版本；非法返回 false */
function satisfiesConstraint(version, constraint) {
    const major = Number.parseInt(version.replace(/^v/, ""), 10);
    if (Number.isNaN(major))
        return false;
    const m = /^>=(\d+)$/.exec(constraint.trim());
    if (!m)
        return false;
    return major >= Number.parseInt(m[1], 10);
}
/** 解析 `node -v` 输出（"v24.5.0\n" → "24.5.0"） */
function parseNodeVersion(output) {
    const m = /^v?(\d+\.\d+\.\d+)/.exec(output.trim());
    return m ? m[1] : null;
}
/** 探测系统 node 版本 */
async function detectSystemNode() {
    try {
        const { stdout } = await execFileAsync("node", ["-v"], { timeout: 5000 });
        return parseNodeVersion(stdout);
    }
    catch {
        return null;
    }
}
/** 缓存目录中满足约束且二进制存在的最高版本目录名（如 node-24.5.0） */
function findCachedRuntime(cacheDir, constraint, platform) {
    if (!(0, node_fs_1.existsSync)(cacheDir))
        return null;
    let best = null;
    for (const name of (0, node_fs_1.readdirSync)(cacheDir)) {
        const m = /^node-(v?\d+\.\d+\.\d+)$/.exec(name);
        if (!m)
            continue;
        if (!satisfiesConstraint(m[1], constraint))
            continue;
        // 跳过二进制缺失的损坏条目（如历史 bug 留下的半成品），避免选中后 spawn ENOENT
        if (!(0, node_fs_1.existsSync)(nodeBinPath(cacheDir, name, platform)))
            continue;
        if (!best || compareVersions(m[1], best.version) > 0) {
            best = { version: m[1], dir: name };
        }
    }
    return best?.dir ?? null;
}
/** 简单版本比较（x.y.z） */
function compareVersions(a, b) {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0))
            return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
}
function nodeBinPath(cacheDir, dirName, platform) {
    return platform === "win32"
        ? (0, node_path_1.join)(cacheDir, dirName, "node.exe")
        : (0, node_path_1.join)(cacheDir, dirName, "bin", "node");
}
/**
 * 确保 Node 运行时可用，返回当前、系统或缓存内 Node 的可执行文件路径。
 */
async function ensureNodeRuntime(options) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const downloadBase = options.downloadBase ?? DEFAULT_DOWNLOAD_BASE;
    const currentRuntime = options.currentRuntime ?? {
        version: process.version,
        execPath: process.execPath,
    };
    if (satisfiesConstraint(currentRuntime.version, options.constraint)) {
        return currentRuntime.execPath;
    }
    const systemVersion = options.execNodeVersion
        ? await options.execNodeVersion()
        : await detectSystemNode();
    if (systemVersion && satisfiesConstraint(systemVersion, options.constraint)) {
        return "node";
    }
    const cachedDir = findCachedRuntime(options.cacheDir, options.constraint, platform);
    if (cachedDir) {
        return nodeBinPath(options.cacheDir, cachedDir, platform);
    }
    await (0, promises_1.mkdir)(options.cacheDir, { recursive: true });
    const fetchIndex = options.fetchIndex ??
        (async () => {
            const res = await fetch(`${downloadBase}/index.json`, {
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok)
                throw new Error(`index.json HTTP ${res.status}`);
            return (await res.json());
        });
    const index = await fetchIndex();
    const candidates = index
        .map((e) => e.version.replace(/^v/, ""))
        .filter((v) => satisfiesConstraint(v, options.constraint))
        .sort(compareVersions);
    const target = candidates[candidates.length - 1];
    if (!target) {
        throw new Error(`无满足约束 ${options.constraint} 的 Node 版本`);
    }
    const extract = options.downloadAndExtract ??
        ((version, cache, ctx) => downloadNodeArchive(version, cache, ctx));
    return extract(target, options.cacheDir, { platform, arch, downloadBase });
}
/** 下载并解压官方 Node 发行包（zip / tar.gz，复用系统解压工具），返回校验后的二进制路径 */
async function downloadNodeArchive(version, cacheDir, ctx) {
    const plat = ctx.platform.replace("win32", "win");
    const ext = ctx.platform === "win32" ? "zip" : "tar.gz";
    const fileName = `node-v${version}-${plat}-${ctx.arch}.${ext}`;
    const url = `${ctx.downloadBase}/v${version}/${fileName}`;
    const archivePath = (0, node_path_1.join)(cacheDir, fileName);
    if (!(0, node_fs_1.existsSync)(archivePath)) {
        const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
        if (!res.ok)
            throw new Error(`下载失败: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await (0, promises_1.writeFile)(archivePath, buf);
    }
    await (0, archive_js_1.extractArchive)(archivePath, cacheDir);
    return normalizeNodeCacheLayout(version, cacheDir, ctx.platform, ctx.arch);
}
/**
 * 把官方压缩包解压出的顶层目录（node-v<version>-<plat>-<arch>）归一化为缓存
 * 标准布局 node-<version>，并校验二进制存在；与 findCachedRuntime/nodeBinPath
 * 的约定保持一致。返回校验后的可执行文件路径。
 */
function normalizeNodeCacheLayout(version, cacheDir, platform, arch) {
    const plat = platform.replace("win32", "win");
    const extractedDir = (0, node_path_1.join)(cacheDir, `node-v${version}-${plat}-${arch}`);
    const targetBin = nodeBinPath(cacheDir, `node-${version}`, platform);
    if ((0, node_fs_1.existsSync)(targetBin))
        return targetBin;
    if ((0, node_fs_1.existsSync)(extractedDir)) {
        (0, node_fs_1.renameSync)(extractedDir, (0, node_path_1.join)(cacheDir, `node-${version}`));
    }
    if (!(0, node_fs_1.existsSync)(targetBin)) {
        throw new Error(`解压后未找到 Node 可执行文件: ${targetBin}`);
    }
    return targetBin;
}
