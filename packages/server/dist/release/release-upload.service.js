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
exports.ReleaseUploadService = exports.ReleaseUploadError = exports.ReleaseUploadContract = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
const release_service_js_1 = require("./release.service.js");
const release_orchestrator_js_1 = require("./release.orchestrator.js");
const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
/** Server Controller 使用的 Shared Release 上传 parser。 */
exports.ReleaseUploadContract = {
    parseCreate: shared_1.parseReleaseUploadCreateInput,
    parseRefresh: shared_1.parseReleaseUploadPartRefresh,
    parseComplete: shared_1.parseReleaseUploadComplete,
};
/** Release 直传会话领域错误。 */
class ReleaseUploadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ReleaseUploadError";
    }
}
exports.ReleaseUploadError = ReleaseUploadError;
/** Release 外部 Provider 直传会话、完成登记与编排入口。 */
let ReleaseUploadService = class ReleaseUploadService {
    prisma;
    storage;
    releases;
    orchestrator;
    constructor(prisma, storage, releases, orchestrator) {
        this.prisma = prisma;
        this.storage = storage;
        this.releases = releases;
        this.orchestrator = orchestrator;
    }
    get uploadSessions() {
        return this.prisma.releaseUploadSession;
    }
    /** 协商上传模式；Alibaba 返回直传分片，Local 保留 Server 流式上传。 */
    async createSession(input, actor) {
        const backend = await this.storage.getBackendConfig();
        if (backend.kind !== "alibaba")
            return { mode: "server" };
        const platform = input.platform;
        const existingRelease = await this.releases.findByVersion(input.version);
        const existingArchive = existingRelease?.archives[platform];
        if (existingArchive) {
            if (existingArchive.availability !== "deleting" &&
                existingArchive.availability !== "cleaned" &&
                existingArchive.sha256 === input.sha256 &&
                existingArchive.size === input.size) {
                return { mode: "existing", release: existingRelease };
            }
            throw new release_service_js_1.ReleaseError("RELEASE_ARCHIVE_EXISTS", `release ${input.version} 已存在 ${input.platform} 构件`);
        }
        const existing = await this.uploadSessions.findUnique({
            where: {
                version_platform: {
                    version: input.version,
                    platform: input.platform,
                },
            },
        });
        if (existing) {
            if (existing.sha256 !== input.sha256 ||
                existing.size !== input.size ||
                existing.provider !== "alibaba") {
                throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "同版本平台已有不同构件的上传会话");
            }
            if (existing.status === "completed" ||
                existing.status === "provider_completed") {
                throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, existing.status === "completed"
                    ? "上传会话已经完成"
                    : "上传会话已完成 Provider 合并，请继续完成登记");
            }
            if (existing.expiresAt.getTime() > Date.now()) {
                return this.resumeSession(existing);
            }
            await this.providerCall(() => this.storage.delete(existing.providerKey));
            await this.uploadSessions.delete({ where: { id: existing.id } });
        }
        const fileName = this.fileName(input.version, input.platform);
        const provider = await this.providerCall(() => this.storage.createReleaseDirectUpload(input.size, fileName));
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        const row = await this.uploadSessions.create({
            data: {
                id: (0, node_crypto_1.randomUUID)(),
                version: input.version,
                platform: input.platform,
                sha256: input.sha256,
                size: input.size,
                provider: "alibaba",
                providerKey: provider.fileId,
                providerUploadId: provider.uploadId,
                partSize: provider.partSize,
                status: "pending",
                createdByIdentityId: actor?.identityId ?? null,
                createdByName: actor?.displayName ?? null,
                createdVia: actor?.source ?? null,
                expiresAt,
            },
        });
        return {
            mode: "direct",
            sessionId: row.id,
            partSize: row.partSize,
            parts: provider.parts,
            expiresAt: row.expiresAt.toISOString(),
        };
    }
    /** 刷新指定分片 URL；URL 只返回调用方，不持久化。 */
    async refreshParts(sessionId, partNumbers) {
        const row = await this.requirePendingSession(sessionId);
        this.assertPartNumbers(row.size, row.partSize, partNumbers);
        const parts = await this.providerCall(() => this.storage.refreshReleaseDirectUploadParts(row.providerKey, row.providerUploadId, partNumbers));
        if (parts.length !== partNumbers.length) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "Provider 未返回全部请求分片");
        }
        return { parts };
    }
    /** 完成 Provider 分片合并并登记 Release；重复完成幂等返回已登记 Release。 */
    async completeSession(sessionId, uploadedBytes) {
        const row = await this.uploadSessions.findUnique({
            where: { id: sessionId },
        });
        if (!row) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_NOT_FOUND, "Release 上传会话不存在");
        }
        if (uploadedBytes !== row.size) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SIZE_MISMATCH, "上传字节数与创建会话时声明值不一致");
        }
        const already = await this.releases.findByVersionWithStorage(row.version);
        const platform = row.platform;
        const registered = already?.archives[platform];
        if (row.status === "completed" || registered) {
            if (!already || !registered) {
                throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "上传会话与已登记 Release 构件不一致");
            }
            if (registered.availability === "deleting" ||
                registered.availability === "cleaned" ||
                registered.sha256 !== row.sha256 ||
                registered.size !== row.size ||
                registered.storage?.key !== row.providerKey) {
                throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "上传会话与已登记 Release 构件不一致");
            }
            if (row.status !== "completed") {
                await this.markCompleted(row.id, (0, release_service_js_1.toPublicReleaseInfo)(already));
            }
            return { release: (0, release_service_js_1.toPublicReleaseInfo)(already) };
        }
        if (row.status !== "provider_completed") {
            this.assertNotExpired(row.expiresAt);
            // Provider 创建上传任务时已固定总大小；CLI 完成上报也必须与会话大小一致。
            // 构件内容完整性由 Launcher 下载后的独立 SHA-256 复核兜底。
            await this.providerCall(() => this.storage.completeReleaseDirectUpload(row.providerKey, row.providerUploadId));
            await this.markProviderCompleted(row.id);
        }
        const archive = {
            sha256: row.sha256,
            size: row.size,
            fileName: this.fileName(row.version, platform),
            availability: "available",
            storage: {
                provider: row.provider,
                key: row.providerKey,
                mode: "direct",
            },
        };
        const current = await this.releases.findByVersionWithStorage(row.version);
        let release;
        if (current?.archives[platform]) {
            const stored = current.archives[platform];
            if (stored.availability === "deleting" ||
                stored.availability === "cleaned" ||
                stored.sha256 !== archive.sha256 ||
                stored.size !== archive.size ||
                stored.storage?.key !== archive.storage?.key) {
                throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "Release 已登记不同构件");
            }
            release = (0, release_service_js_1.toPublicReleaseInfo)(current);
        }
        else {
            release = current
                ? await this.releases.addArchive(row.version, platform, archive)
                : await this.releases.create({
                    version: row.version,
                    archives: { [platform]: archive },
                    createdByName: row.createdByName ?? undefined,
                    createdVia: row.createdVia ?? undefined,
                });
        }
        await this.markCompleted(row.id, release);
        return { release };
    }
    async resumeSession(row) {
        const partNumbers = Array.from({ length: Math.ceil(row.size / row.partSize) }, (_, index) => index + 1);
        const parts = await this.providerCall(() => this.storage.refreshReleaseDirectUploadParts(row.providerKey, row.providerUploadId, partNumbers));
        if (parts.length !== partNumbers.length) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "Provider 未返回全部上传分片");
        }
        return {
            mode: "direct",
            sessionId: row.id,
            partSize: row.partSize,
            parts,
            expiresAt: row.expiresAt.toISOString(),
        };
    }
    async requirePendingSession(sessionId) {
        const row = await this.uploadSessions.findUnique({
            where: { id: sessionId },
        });
        if (!row) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_NOT_FOUND, "Release 上传会话不存在");
        }
        if (row.status !== "pending") {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "Release 上传会话不可刷新");
        }
        this.assertNotExpired(row.expiresAt);
        return row;
    }
    async markProviderCompleted(sessionId) {
        await this.uploadSessions.update({
            where: { id: sessionId },
            data: { status: "provider_completed" },
        });
    }
    async markCompleted(sessionId, release) {
        await this.uploadSessions.update({
            where: { id: sessionId },
            data: { status: "completed" },
        });
        if (this.releases.hasAllArchives(release)) {
            void this.orchestrator.startRelease(release.version).catch((error) => {
                console.error("[release] 触发更新失败", release.version, error);
            });
        }
    }
    async providerCall(operation) {
        try {
            return await operation();
        }
        catch {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.PROVIDER_FAILED, "外部存储操作失败，请稍后重试");
        }
    }
    assertNotExpired(expiresAt) {
        if (expiresAt.getTime() <= Date.now()) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_EXPIRED, "Release 上传会话已过期，请重新创建");
        }
    }
    assertPartNumbers(size, partSize, partNumbers) {
        const count = Math.ceil(size / partSize);
        if (partNumbers.some((part) => part > count)) {
            throw new ReleaseUploadError(shared_1.ReleaseUploadErrorCode.SESSION_CONFLICT, "请求的分片编号超出会话范围");
        }
    }
    fileName(version, platform) {
        return `vcpdeck-${version}-${platform}.zip`;
    }
};
exports.ReleaseUploadService = ReleaseUploadService;
exports.ReleaseUploadService = ReleaseUploadService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __param(2, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __param(3, (0, common_1.Inject)(release_orchestrator_js_1.ReleaseOrchestrator)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, storage_service_js_1.StorageService, release_service_js_1.ReleaseService, release_orchestrator_js_1.ReleaseOrchestrator])
], ReleaseUploadService);
