"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Daemon = void 0;
exports.readManifest = readManifest;
exports.downloadWithRetry = downloadWithRetry;
exports.loadConfigFromEnv = loadConfigFromEnv;
/**
 * 守护进程编排（详见 docs/design/release-and-update.md）：
 * - ensure-node 保障运行时 → 启动 current 版本 → 崩溃退避拉起（更新期间抑制）
 * - 控制通道 /prepare、/apply → Updater 两阶段更新 + preStart 钩子 + 探活回退
 */
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const promises_2 = require("node:stream/promises");
const archive_js_1 = require("./archive.js");
const ensure_node_js_1 = require("./ensure-node.js");
const versions_js_1 = require("./versions.js");
const updater_js_1 = require("./updater.js");
const control_js_1 = require("./control.js");
const version_retention_js_1 = require("./version-retention.js");
const MAX_CRASH_RETRIES = 5;
const STABLE_WINDOW_MS = 30_000;
/** client 探活稳定窗口：启动后至少存活此时长才判健康（秒退进程判失败） */
const CLIENT_PROBE_STABLE_MS = 3000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [500, 1000];
const RETENTION_STARTUP_DELAY_MS = STABLE_WINDOW_MS;
function isTransientDownloadStatus(status) {
    return status === 502 || status === 503 || status === 504;
}
/** 读取版本目录下的 manifest.json；缺失/损坏返回 null */
function readManifest(versionDir) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(versionDir, "manifest.json"), "utf-8"));
    }
    catch {
        return null;
    }
}
function streamSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = (0, node_crypto_1.createHash)("sha256");
        (0, node_fs_1.createReadStream)(filePath)
            .on("error", reject)
            .on("data", (c) => hash.update(c))
            .on("end", () => resolve(hash.digest("hex")));
    });
}
/**
 * 更新包下载 URL 校验：仅允许 http/https 且带主机名。
 * 信任边界：控制通道为 127.0.0.1 + token（服务端自更新）；
 * 客户端场景 URL 来自经 PSK 认证的 WS 连接（服务端下发）。
 */
function validateUpdateUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`更新包 URL 无效`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`更新包 URL 协议不允许: ${parsed.protocol}`);
    }
    if (!parsed.hostname) {
        throw new Error(`更新包 URL 缺少主机名`);
    }
    return parsed.toString();
}
/** 下载更新包，瞬时网络失败和 502/503/504 最多重试三次。 */
async function downloadWithRetry(url, destPath, fetchImpl = fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const fullUrl = validateUpdateUrl(url);
    let lastError;
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
        let res;
        try {
            res = await fetchImpl(fullUrl, {
                signal: AbortSignal.timeout(900_000),
            });
        }
        catch (error) {
            lastError = error;
            if (attempt >= DOWNLOAD_ATTEMPTS - 1) {
                throw new Error("下载失败: 网络错误");
            }
            await sleepImpl(DOWNLOAD_RETRY_DELAYS_MS[attempt] ?? 1000);
            continue;
        }
        if (!res.ok) {
            const error = new Error(`下载失败: HTTP ${res.status}`);
            if (!isTransientDownloadStatus(res.status))
                throw error;
            lastError = error;
            if (attempt >= DOWNLOAD_ATTEMPTS - 1)
                throw error;
            await sleepImpl(DOWNLOAD_RETRY_DELAYS_MS[attempt] ?? 1000);
            continue;
        }
        // 响应已成功后，写盘/流处理错误是本地或数据面错误，不重试。
        await (0, promises_2.pipeline)(res.body, (0, node_fs_1.createWriteStream)(destPath));
        return;
    }
    throw lastError instanceof Error ? lastError : new Error("下载失败: 网络错误");
}
class Daemon {
    appDir;
    artifact;
    probeUrl;
    log;
    versions;
    retention;
    retentionTimer = null;
    child = null;
    childStartedAt = 0;
    updating = false;
    stopping = false;
    crashCount = 0;
    pendingVersion = null;
    /** 后台 prepare 任务（受理后下载/校验/解压）；apply 前必须等待完成 */
    prepareTask = null;
    nodePath = null;
    updater;
    constructor(config) {
        this.appDir = config.appDir;
        this.artifact = config.artifact;
        this.probeUrl = config.probeUrl ?? "http://127.0.0.1:3001/api/status";
        this.log = config.log ?? ((msg) => console.log(`[launcher] ${msg}`));
        this.versions = new versions_js_1.VersionStore({
            appsDir: (0, node_path_1.join)(this.appDir, "apps"),
        });
        this.retention =
            config.retention ??
                new version_retention_js_1.VersionRetention({
                    appsDir: (0, node_path_1.join)(this.appDir, "apps"),
                    versions: this.versions,
                });
    }
    async start() {
        await (0, promises_1.mkdir)(this.appDir, { recursive: true });
        this.updater = this.buildUpdater();
        // 优雅停机：先停被守护进程再退出（Windows kill() 不触发 handler，Ctrl+C 有效）
        const shutdown = () => {
            void this.shutdown();
        };
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
        const control = await (0, control_js_1.createControlServer)({
            controlFile: (0, node_path_1.join)(this.appDir, "control.json"),
            handlers: {
                prepare: (input) => {
                    // 立即受理：下载/校验/解压可能耗时数分钟，先行返回 200，
                    // 避免请求方 fetch 默认超时在下载完成前切断连接。
                    // 从受理开始就保护目标，避免启动补扫删除正在解压的目录。
                    this.pendingVersion = input.version;
                    this.prepareTask = this.updater.prepare(input).catch((error) => {
                        if (this.pendingVersion === input.version)
                            this.pendingVersion = null;
                        throw error;
                    });
                    this.prepareTask.catch(() => undefined);
                    return Promise.resolve();
                },
                apply: async () => {
                    if (this.prepareTask)
                        await this.prepareTask;
                    const version = this.pendingVersion;
                    if (!version)
                        throw new Error("尚未 prepare");
                    await this.applyUpdate(version);
                },
            },
            log: this.log,
        });
        await this.startCurrent(control.port, control.token);
        await this.initializeRetention();
        this.scheduleRetentionStartupCleanup();
        this.log(`守护中: ${this.artifact} (control port ${control.port})`);
    }
    /** 优雅停机：置停机标志并停掉被守护进程 */
    async shutdown() {
        this.stopping = true;
        this.cancelRetentionStartupCleanup();
        this.log("收到停机信号，停止被守护进程");
        await this.stopChild();
        process.exit(0);
    }
    /** 更新流程：preStart 钩子 → stop/switch/start/probe/回退 */
    async applyUpdate(version) {
        // apply 全程保留 pendingVersion，避免启动补扫删除正在切换的目标。
        const versionDir = (0, node_path_1.join)(this.appDir, "apps", version);
        const manifest = readManifest(versionDir);
        const artifact = manifest?.artifacts[this.artifact];
        try {
            // preStart 仅 server 构件支持（如 prisma db push）
            const preStart = this.artifact === "server"
                ? manifest?.artifacts.server?.preStart
                : undefined;
            if (artifact && preStart) {
                await (0, control_js_1.runPreStart)(preStart, (0, node_path_1.join)(versionDir, artifact.dir));
            }
            await this.updater.apply(version);
        }
        finally {
            if (this.pendingVersion === version)
                this.pendingVersion = null;
        }
    }
    /** 启动 current 版本进程（含 ensure-node） */
    async startCurrent(port, token) {
        const version = await this.versions.currentVersion();
        if (!version) {
            throw new Error("尚未部署任何版本（apps/current 不存在）；请先手动安装初始版本");
        }
        const versionDir = (0, node_path_1.join)(this.appDir, "apps", version);
        const manifest = readManifest(versionDir);
        const artifact = manifest?.artifacts[this.artifact];
        if (!artifact) {
            throw new Error(`manifest 缺少 artifacts.${this.artifact}: ${version}`);
        }
        this.nodePath = await (0, ensure_node_js_1.ensureNodeRuntime)({
            constraint: manifest?.nodeVersion ?? ">=24",
            cacheDir: (0, node_path_1.join)(this.appDir, "node"),
        });
        const child = (0, node_child_process_1.spawn)(this.nodePath, [artifact.entry], {
            cwd: (0, node_path_1.join)(versionDir, artifact.dir),
            stdio: "inherit",
            // Windows 下必须隐藏子进程控制台，否则 client 会弹可见黑窗
            windowsHide: true,
            env: {
                ...process.env,
                VCPDECK_LAUNCHER_PORT: port ? String(port) : undefined,
                VCPDECK_LAUNCHER_TOKEN: token,
            },
        });
        this.child = child;
        this.childStartedAt = Date.now();
        child.on("exit", (code) => {
            if (this.child !== child)
                return;
            this.child = null;
            if (this.updating || this.stopping)
                return; // 更新/停机期间的退出是预期的
            this.scheduleRestart(code);
        });
        this.log(`已启动 ${this.artifact} ${version}`);
    }
    /** 崩溃退避拉起（运行满 30s 视为稳定，计数清零；超上限放弃） */
    scheduleRestart(code) {
        if (Date.now() - this.stableSinceMs() > STABLE_WINDOW_MS) {
            this.crashCount = 0;
        }
        this.crashCount++;
        this.log(`进程退出（code=${code}），第 ${this.crashCount} 次崩溃`);
        if (this.crashCount > MAX_CRASH_RETRIES) {
            this.log("连续崩溃超过上限，放弃拉起（等待手动处理或新版本）");
            return;
        }
        const delay = Math.min(1000 * 2 ** (this.crashCount - 1), 30_000);
        setTimeout(() => {
            if (!this.updating && !this.stopping && !this.child) {
                void this.startCurrent().catch((e) => this.log(`拉起失败: ${e.message}`));
            }
        }, delay);
    }
    stableSinceMs() {
        // 进程启动时间近似：崩溃退避以最近一次 startCurrent 为基准
        return this.lastStartAt;
    }
    lastStartAt = 0;
    async stopChild() {
        const child = this.child;
        if (!child)
            return;
        this.child = null;
        child.kill("SIGTERM");
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    // 进程可能已退出
                }
                resolve();
            }, 10_000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    /** 健康探活：server 走 HTTP + 版本匹配；client 需存活超过稳定窗口（秒退进程判失败） */
    async probe(version) {
        if (this.artifact === "server") {
            try {
                const res = await fetch(this.probeUrl, {
                    signal: AbortSignal.timeout(5000),
                });
                if (!res.ok)
                    return false;
                const body = (await res.json());
                return body.serverVersion === version;
            }
            catch {
                return false;
            }
        }
        return (this.child !== null &&
            this.child.exitCode === null &&
            Date.now() - this.childStartedAt > CLIENT_PROBE_STABLE_MS);
    }
    async initializeRetention() {
        try {
            await this.retention.initialize();
        }
        catch {
            this.log("版本保留状态初始化失败，已跳过自动清理");
        }
    }
    scheduleRetentionStartupCleanup() {
        this.cancelRetentionStartupCleanup();
        this.retentionTimer = setTimeout(() => {
            this.retentionTimer = null;
            if (this.stopping)
                return;
            const protectedVersions = this.pendingVersion
                ? new Set([this.pendingVersion])
                : undefined;
            void this.runRetentionCleanup(protectedVersions);
        }, RETENTION_STARTUP_DELAY_MS);
    }
    cancelRetentionStartupCleanup() {
        if (this.retentionTimer === null)
            return;
        clearTimeout(this.retentionTimer);
        this.retentionTimer = null;
    }
    async runRetentionCleanup(protectedVersions) {
        try {
            const result = await this.retention.cleanup(protectedVersions);
            this.log(`版本清理完成: 删除 ${result.removed.length} 项，失败 ${result.failed.length} 项`);
        }
        catch {
            this.log("版本清理失败，保留本地版本目录供人工处理");
        }
    }
    async onSuccessfulApply(version, previous) {
        const recorded = await this.retention.recordSuccessful(version);
        if (!recorded)
            return;
        const protectedVersions = new Set([version]);
        if (previous)
            protectedVersions.add(previous);
        await this.runRetentionCleanup(protectedVersions);
    }
    buildUpdater() {
        return new updater_js_1.Updater({
            versions: this.versions,
            artifact: this.artifact,
            downloadZip: async (url, destPath) => {
                // 相对路径（服务端自更新）拼本机服务地址
                const fullUrl = url.startsWith("http")
                    ? url
                    : new URL(url, this.probeUrl).toString();
                this.log("下载更新包");
                await downloadWithRetry(fullUrl, destPath, fetch, async (ms) => {
                    this.log(`下载更新包重试等待: ${ms}ms`);
                    await new Promise((resolve) => setTimeout(resolve, ms));
                });
            },
            verifySha256: async (filePath, expected) => (await streamSha256(filePath)) === expected,
            extractZip: (zipPath, destDir) => (0, archive_js_1.extractArchive)(zipPath, destDir),
            stopProcess: async () => {
                this.updating = true;
                await this.stopChild();
            },
            startProcess: async () => {
                this.lastStartAt = Date.now();
                await this.startCurrent();
                this.updating = false;
            },
            probe: (version) => this.probe(version),
            onSuccessfulApply: (version, previous) => this.onSuccessfulApply(version, previous),
        });
    }
}
exports.Daemon = Daemon;
/** 从环境变量加载配置 */
function loadConfigFromEnv() {
    const appDir = process.env.VCPDECK_APP_DIR ?? (0, node_path_1.join)((0, node_os_1.homedir)(), ".vcpdeck", "launcher");
    const artifact = process.env.VCPDECK_ARTIFACT;
    if (artifact !== "server" && artifact !== "client") {
        throw new Error("VCPDECK_ARTIFACT 必须为 server 或 client");
    }
    return {
        appDir,
        artifact,
        probeUrl: process.env.VCPDECK_PROBE_URL,
    };
}
