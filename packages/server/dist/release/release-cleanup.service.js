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
var ReleaseCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseCleanupService = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const release_service_js_1 = require("./release.service.js");
const release_paths_js_1 = require("./release-paths.js");
const release_cleanup_policy_js_1 = require("./release-cleanup.policy.js");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
/** Server Release archive 与直传会话清理协调器。 */
let ReleaseCleanupService = ReleaseCleanupService_1 = class ReleaseCleanupService {
    prisma;
    releases;
    storage;
    logger = new common_1.Logger(ReleaseCleanupService_1.name);
    now;
    removeLocal;
    running = null;
    timer = null;
    constructor(prisma, releases, storage, options = {}) {
        this.prisma = prisma;
        this.releases = releases;
        this.storage = storage;
        this.now = options.now ?? (() => new Date());
        this.removeLocal = options.removeLocal ?? ((path) => (0, promises_1.rm)(path, { force: true }));
    }
    get uploadSessions() {
        return this.prisma.releaseUploadSession;
    }
    /** Server 启动后执行一次，并以每日扫描作为失败重试兜底。 */
    onModuleInit() {
        void this.runAutomatic("startup");
        this.timer = setInterval(() => {
            void this.runAutomatic("scheduled");
        }, 24 * 60 * 60 * 1_000);
    }
    /** 停止清理定时器；已经开始的 Provider 删除交给 lifecycle 恢复。 */
    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /** 计算当前固定策略下的可清理候选，不执行删除。 */
    async preview() {
        const [releases, latestTarget, active, backend, sessions] = await Promise.all([
            this.releases.listForCleanup(),
            this.releases.getLatestActiveTarget(),
            this.releases.getActiveRelease(),
            this.storage.getBackendConfig(),
            this.uploadSessions.findMany(),
        ]);
        const plan = (0, release_cleanup_policy_js_1.computeReleaseCleanupPlan)({
            releases,
            now: this.now(),
            currentServerVersion: shared_1.VERSION,
            latestTargetVersion: latestTarget?.version ?? null,
            activeReleaseVersion: active?.version ?? null,
            backendKind: backend.kind,
        });
        const candidates = (0, release_cleanup_policy_js_1.summarizeCleanupCandidates)(plan.candidates);
        const expiredUploadSessions = sessions.filter((session) => session.status === "pending" &&
            session.provider === backend.kind &&
            session.expiresAt.getTime() +
                release_cleanup_policy_js_1.RELEASE_CLEANUP_POLICY.uploadSessionGraceHours * 60 * 60 * 1_000 <=
                this.now().getTime());
        const sessionBytes = expiredUploadSessions.reduce((total, session) => total + session.size, 0);
        return {
            policy: release_cleanup_policy_js_1.RELEASE_CLEANUP_POLICY,
            candidates,
            expiredUploadSessions: {
                count: expiredUploadSessions.length,
                bytes: sessionBytes,
            },
            estimatedReclaimableBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0) +
                sessionBytes,
        };
    }
    /** 按固定策略执行一次清理；执行时重新 claim，不信任旧预览。 */
    async run() {
        if (this.running) {
            throw new release_service_js_1.ReleaseError("RELEASE_CLEANUP_BUSY", "Release 清理任务正在运行");
        }
        const task = this.executeRun();
        this.running = task;
        void task.then(() => {
            if (this.running === task)
                this.running = null;
        }, () => {
            if (this.running === task)
                this.running = null;
        });
        return task;
    }
    /** 自动触发入口；清理失败只记录日志，不改变 Release 状态。 */
    async runAutomatic(trigger) {
        try {
            await this.run();
        }
        catch (error) {
            if (error instanceof release_service_js_1.ReleaseError && error.code === "RELEASE_CLEANUP_BUSY") {
                return;
            }
            this.logger.warn(`Release cleanup failed (trigger=${trigger})`);
        }
    }
    async executeRun() {
        const startedAt = this.now().toISOString();
        const result = {
            startedAt,
            finishedAt: startedAt,
            cleanedItems: 0,
            cleanedBytes: 0,
            alreadyMissing: 0,
            failed: 0,
            skipped: 0,
            providerUnavailable: 0,
            retryable: false,
            issues: [],
        };
        const [releases, latestTarget, active, backend] = await Promise.all([
            this.releases.listForCleanup(),
            this.releases.getLatestActiveTarget(),
            this.releases.getActiveRelease(),
            this.storage.getBackendConfig(),
        ]);
        const plan = (0, release_cleanup_policy_js_1.computeReleaseCleanupPlan)({
            releases,
            now: this.now(),
            currentServerVersion: shared_1.VERSION,
            latestTargetVersion: latestTarget?.version ?? null,
            activeReleaseVersion: active?.version ?? null,
            backendKind: backend.kind,
        });
        await this.recoverDeleting(plan.deleting, backend.kind, result);
        for (const candidate of plan.candidates) {
            if (candidate.providerState === "provider_unavailable") {
                result.providerUnavailable++;
                result.issues.push({
                    version: candidate.version,
                    platform: candidate.platform,
                    code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
                });
                continue;
            }
            await this.cleanCandidate(candidate, result);
        }
        await this.cleanUploadSessions(backend.kind, result);
        result.finishedAt = this.now().toISOString();
        return result;
    }
    async cleanCandidate(candidate, result) {
        const claimed = await this.releases.claimArchiveForCleanup(candidate.version, candidate.platform);
        if (!claimed) {
            result.skipped++;
            return;
        }
        const localPath = (0, release_paths_js_1.releaseZipPath)(candidate.version, candidate.platform);
        try {
            if (claimed.storage) {
                await this.storage.delete(claimed.storage.key);
            }
            else {
                if (!(0, node_fs_1.existsSync)(localPath))
                    result.alreadyMissing++;
                await this.removeLocal(localPath);
            }
            const finished = await this.releases.finishArchiveCleanup(candidate.version, candidate.platform, this.now().toISOString());
            if (!finished) {
                result.skipped++;
                return;
            }
            result.cleanedItems++;
            result.cleanedBytes += candidate.archive.size;
        }
        catch {
            await this.releases.restoreArchiveAfterCleanup(candidate.version, candidate.platform);
            result.failed++;
            result.retryable = true;
            result.issues.push({
                version: candidate.version,
                platform: candidate.platform,
                code: "RELEASE_CLEANUP_DELETE_FAILED",
            });
        }
    }
    async recoverDeleting(entries, backendKind, result) {
        for (const entry of entries) {
            const release = await this.releases.findByVersionWithStorage(entry.version);
            const archive = release?.archives[entry.platform];
            if (!archive || archive.availability !== "deleting") {
                result.skipped++;
                continue;
            }
            const provider = archive.storage?.provider ?? "local";
            if (provider !== backendKind) {
                result.providerUnavailable++;
                result.issues.push({
                    version: entry.version,
                    platform: entry.platform,
                    code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
                });
                continue;
            }
            try {
                if (archive.storage) {
                    await this.storage.delete(archive.storage.key);
                }
                else {
                    await this.removeLocal((0, release_paths_js_1.releaseZipPath)(entry.version, entry.platform));
                }
                if (await this.releases.finishArchiveCleanup(entry.version, entry.platform, this.now().toISOString())) {
                    result.cleanedItems++;
                    result.cleanedBytes += archive.size;
                }
            }
            catch {
                await this.releases.restoreArchiveAfterCleanup(entry.version, entry.platform);
                result.failed++;
                result.retryable = true;
                result.issues.push({
                    version: entry.version,
                    platform: entry.platform,
                    code: "RELEASE_CLEANUP_DELETE_FAILED",
                });
            }
        }
    }
    async cleanUploadSessions(backendKind, result) {
        const sessions = await this.uploadSessions.findMany();
        const cutoff = this.now().getTime();
        for (const session of sessions) {
            if (session.status !== "pending" ||
                session.expiresAt.getTime() +
                    release_cleanup_policy_js_1.RELEASE_CLEANUP_POLICY.uploadSessionGraceHours * 60 * 60 * 1_000 >
                    cutoff) {
                continue;
            }
            if (session.provider !== backendKind) {
                result.providerUnavailable++;
                result.issues.push({
                    version: session.version,
                    code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
                });
                continue;
            }
            try {
                await this.storage.delete(session.providerKey);
                await this.uploadSessions.delete({ where: { id: session.id } });
                result.cleanedItems++;
                result.cleanedBytes += session.size;
            }
            catch {
                result.failed++;
                result.retryable = true;
                result.issues.push({
                    version: session.version,
                    code: "RELEASE_UPLOAD_SESSION_DELETE_FAILED",
                });
            }
        }
        for (const session of sessions) {
            if (session.status !== "completed")
                continue;
            const release = await this.releases.findByVersion(session.version);
            const archive = release?.archives[session.platform];
            if (archive?.availability !== "cleaned")
                continue;
            try {
                await this.uploadSessions.delete({ where: { id: session.id } });
                result.cleanedItems++;
            }
            catch {
                result.failed++;
                result.retryable = true;
                result.issues.push({
                    version: session.version,
                    code: "RELEASE_UPLOAD_SESSION_DELETE_FAILED",
                });
            }
        }
    }
};
exports.ReleaseCleanupService = ReleaseCleanupService;
exports.ReleaseCleanupService = ReleaseCleanupService = ReleaseCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __param(2, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __param(3, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, release_service_js_1.ReleaseService, storage_service_js_1.StorageService, Object])
], ReleaseCleanupService);
