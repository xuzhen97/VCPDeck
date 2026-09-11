"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseOrchestrator = void 0;
/**
 * 更新编排器：Server 先更新，启动恢复后再逐台更新 Client。
 * 详见 docs/design/release-and-update.md。
 *
 * - startRelease：上传后触发服务端自更新（prepare → drain → 广播 → apply）
 * - resumeAfterStartup：服务启动时从 DB 恢复（launcher 回退判定 / 客户端阶段续跑）
 * - onClientRegistered / onUpdateFailed / onUpdateReady：来自网关的事件钩子
 */
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const release_service_js_1 = require("./release.service.js");
const update_channel_js_1 = require("./update-channel.js");
const launcher_client_js_1 = require("./launcher-client.js");
const server_drain_js_1 = require("../job/server-drain.js");
const release_cleanup_service_js_1 = require("./release-cleanup.service.js");
const DEFAULT_CLIENT_TIMEOUT_MS = 10 * 60 * 1000;
let ReleaseOrchestrator = class ReleaseOrchestrator {
    releases;
    channel;
    launcher;
    drain;
    cleanup;
    serverVersion;
    clientTimeoutMs;
    activePhase = null;
    pendingClients = new Map();
    queuedCatchUpClients = new Set();
    constructor(releases, channel, launcher, drain, cleanup, 
    // 可调参数不是 DI 依赖
    options = {}) {
        this.releases = releases;
        this.channel = channel;
        this.launcher = launcher;
        this.drain = drain;
        this.cleanup = cleanup;
        this.serverVersion = options.serverVersion ?? shared_1.VERSION;
        this.clientTimeoutMs =
            options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    }
    /**
     * 上传后触发：uploaded → updating_server。
     * 服务端按本机平台选择构件；applyUpdate 正常返回（launcher 未接管）视为失败。
     */
    async startRelease(version) {
        const release = await this.releases.findByVersion(version);
        if (!release) {
            throw new release_service_js_1.ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
        }
        const active = await this.releases.getActiveRelease();
        if (active) {
            throw new release_service_js_1.ReleaseError("RELEASE_ORCHESTRATOR_BUSY", `已有进行中的 release ${active.version}`);
        }
        const serverPlatform = (0, shared_1.platformFromOs)(process.platform);
        const serverArchive = serverPlatform
            ? release.archives[serverPlatform]
            : undefined;
        if (!serverPlatform || !(0, shared_1.isReleaseArchiveAvailable)(serverArchive)) {
            await this.releases.markFailed(version, `缺少 ${serverPlatform ?? "未知平台"} 构件，无法更新服务端`);
            return;
        }
        await this.releases.transitionStatus(version, shared_1.ReleaseStatus.UPDATING_SERVER);
        try {
            await this.launcher.prepareUpdate({
                version,
                url: `/api/releases/${version}/file?platform=${serverPlatform}`,
                sha256: serverArchive.sha256,
            });
            await this.drain.drain();
            this.channel.broadcastShutdown({ expectedVersion: version });
            await this.launcher.applyUpdate();
            // apply 后本进程应被 launcher 停止；连接被掐断与「进程仍存活」无法
            // 可靠区分，不在此落库失败——终局以新进程重启后的版本对账为准。
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            await this.releases.markFailed(version, `服务端更新失败: ${message}`);
        }
    }
    /** 服务启动时恢复编排状态（由 main 引导调用） */
    async resumeAfterStartup() {
        const active = await this.releases.getActiveRelease();
        if (!active)
            return;
        if (active.status === shared_1.ReleaseStatus.UPDATING_SERVER) {
            if (this.serverVersion !== active.version) {
                await this.releases.markFailed(active.version, "服务端更新后版本不符（launcher 已回退）");
                return;
            }
            await this.releases.transitionStatus(active.version, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            await this.runClientPhase(active.version);
        }
        else if (active.status === shared_1.ReleaseStatus.UPDATING_CLIENTS) {
            await this.runClientPhase(active.version);
        }
    }
    /** 网关注册钩子：推进等待中的客户端，或触发离线补更 */
    onClientRegistered(clientId, clientVersion) {
        const waiter = this.pendingClients.get(clientId);
        if (waiter) {
            if (clientVersion === waiter.targetVersion) {
                waiter.resolve("done");
            }
            else if (waiter.retryCount < 1) {
                // Server 重启期间，旧 Client 可能先以旧版本重连；重发一次，避免
                // 更新请求落在已断开的旧 Socket 上就被误判为回退。
                waiter.retryCount++;
                this.channel.sendUpdateRequest(clientId, waiter.request);
            }
            else {
                waiter.resolve("failed", "注册版本不符（launcher 已回退）");
            }
            return;
        }
        void this.triggerCatchUp(clientId, clientVersion).catch((e) => {
            console.error(`[release] 客户端补更触发失败: ${e}`);
        });
    }
    /** 客户端明确上报更新失败（等待中的立即失败，其余仅记录） */
    onUpdateFailed(clientId, _version, reason) {
        const waiter = this.pendingClients.get(clientId);
        if (waiter) {
            const safeReason = reason.slice(0, 200) || "未知原因";
            console.warn(`[release] 客户端 ${clientId} 更新失败: ${safeReason}`);
            waiter.resolve("failed", safeReason);
        }
    }
    /** 客户端优雅停机完成、launcher 即将接管（终局信号是重连注册，这里仅记录） */
    onUpdateReady(clientId, version) {
        console.log(`[release] 客户端 ${clientId} 已就绪，等待 launcher 接管 ${version}`);
    }
    /** 离线补更：落后客户端注册后触发客户端阶段 */
    async triggerCatchUp(clientId, clientVersion) {
        const target = (await this.releases.getLatestActiveTarget()) ?? null;
        if (!target || clientVersion === target.version)
            return;
        if (target.clientStates[clientId]?.state === shared_1.ReleaseClientState.FAILED)
            return;
        if (this.activePhase) {
            this.queuedCatchUpClients.add(clientId);
            return;
        }
        await this.runClientPhase(target.version);
    }
    /** 客户端阶段互斥入口（重入时复用进行中的循环） */
    runClientPhase(version) {
        if (!this.activePhase) {
            this.activePhase = this.runClientPhaseLoop(version);
        }
        return this.activePhase;
    }
    /** 阶段收尾后在同一个 Promise 中消费登记的补更 Client。 */
    async runClientPhaseLoop(version) {
        try {
            let currentVersion = version;
            while (true) {
                await this.runClientLoop(currentVersion);
                const queued = [...this.queuedCatchUpClients];
                this.queuedCatchUpClients.clear();
                if (queued.length === 0)
                    return;
                const target = await this.releases.getLatestActiveTarget();
                if (!target)
                    return;
                if (queued.every((clientId) => target.clientStates[clientId]?.state ===
                    shared_1.ReleaseClientState.FAILED))
                    return;
                currentVersion = target.version;
            }
        }
        catch (e) {
            console.error(`[release] 客户端更新循环失败: ${e}`);
        }
        finally {
            this.activePhase = null;
            this.pendingClients.clear();
        }
    }
    /** 全量依次更新：逐个等待「重连注册新版本 / 超时 / 失败」；按客户端 os 选择平台包 */
    async runClientLoop(version) {
        const processedClientIds = new Set();
        while (true) {
            const release = await this.releases.findByVersion(version);
            if (!release)
                return;
            const online = await this.channel.listOnlineClients();
            const outdated = online.filter((client) => client.clientVersion !== version &&
                !processedClientIds.has(client.clientId) &&
                release.clientStates[client.clientId]?.state !==
                    shared_1.ReleaseClientState.FAILED);
            if (outdated.length === 0) {
                if (this.queuedCatchUpClients.size > 0) {
                    this.queuedCatchUpClients.clear();
                    continue;
                }
                if (release.status === shared_1.ReleaseStatus.UPDATING_CLIENTS) {
                    await this.releases.transitionStatus(version, shared_1.ReleaseStatus.DONE);
                    void this.cleanup?.runAutomatic("release_done");
                }
                return;
            }
            for (const client of outdated) {
                processedClientIds.add(client.clientId);
                await this.updateOneClient(version, release, client);
            }
        }
    }
    async updateOneClient(version, release, client) {
        if (!release)
            return;
        const platform = (0, shared_1.platformFromOs)(client.os);
        const clientArchive = platform ? release.archives[platform] : undefined;
        if (!platform || !(0, shared_1.isReleaseArchiveAvailable)(clientArchive)) {
            await this.releases.markClientState(version, client.clientId, shared_1.ReleaseClientState.FAILED, `平台不受支持或构件缺失: ${client.os || "unknown"}`);
            return;
        }
        await this.releases.markClientState(version, client.clientId, shared_1.ReleaseClientState.UPDATING);
        const request = {
            releaseVersion: version,
            url: `/api/releases/${version}/file?platform=${platform}`,
            sha256: clientArchive.sha256,
            timeoutMs: this.clientTimeoutMs,
        };
        const outcomePromise = this.waitClientOutcome(client.clientId, version, request);
        try {
            // 先登记 waiter，再发事件，避免重连竞态丢失更新请求。
            this.channel.sendUpdateRequest(client.clientId, request);
        }
        catch (e) {
            this.onUpdateFailed(client.clientId, version, e instanceof Error ? e.message : String(e));
        }
        const outcome = await outcomePromise;
        await this.releases.markClientState(version, client.clientId, outcome.outcome === "done"
            ? shared_1.ReleaseClientState.DONE
            : shared_1.ReleaseClientState.FAILED, outcome.reason);
    }
    waitClientOutcome(clientId, targetVersion, request) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingClients.delete(clientId);
                resolve({
                    outcome: "failed",
                    reason: "等待重连注册超时",
                });
            }, this.clientTimeoutMs);
            this.pendingClients.set(clientId, {
                targetVersion,
                request,
                retryCount: 0,
                resolve: (outcome, reason) => {
                    clearTimeout(timer);
                    this.pendingClients.delete(clientId);
                    resolve({ outcome, ...(reason ? { reason } : {}) });
                },
            });
        });
    }
};
exports.ReleaseOrchestrator = ReleaseOrchestrator;
exports.ReleaseOrchestrator = ReleaseOrchestrator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __param(1, (0, common_1.Inject)(update_channel_js_1.GatewayUpdateChannel)),
    __param(2, (0, common_1.Inject)(launcher_client_js_1.LauncherHttpClient)),
    __param(3, (0, common_1.Inject)(server_drain_js_1.ServerDrain)),
    __param(4, (0, common_1.Optional)()),
    __param(4, (0, common_1.Inject)(release_cleanup_service_js_1.ReleaseCleanupService)),
    __param(5, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [release_service_js_1.ReleaseService, Object, Object, Object, release_cleanup_service_js_1.ReleaseCleanupService, Object])
], ReleaseOrchestrator);
