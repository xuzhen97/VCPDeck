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
exports.FileService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
let FileService = class FileService {
    prisma;
    storage;
    // ponytail: logger reserved, add log lines when error handling expands
    constructor(prisma, storage) {
        this.prisma = prisma;
        this.storage = storage;
    }
    /** 创建 pending File 记录 + 签发上传令牌 */
    async createPending(jobId, clientId, meta, options = {}) {
        const fileId = (0, node_crypto_1.randomUUID)();
        const { url, expiresAt: tokenExpiresAt } = await this.storage.createUploadToken(meta);
        // 从 url 中提取 key: /api/storage/upload/:key?...
        const key = url.match(/\/api\/storage\/upload\/(.+?)\?(.+)/)?.[1] ??
            `${(0, node_crypto_1.randomUUID)()}/${meta.filename.replace(/[\\/:*?"<>|]/g, "_")}`;
        await this.prisma.file.create({
            data: {
                id: fileId,
                key,
                jobId: jobId ?? null,
                clientId,
                filename: meta.filename,
                mimeType: meta.mimeType ?? null,
                size: meta.size,
                sha256: "",
                status: "pending",
                storageKind: "local",
                ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
                ...(options.purpose ? { purpose: options.purpose } : {}),
            },
        });
        return { fileId, key, uploadUrl: url, expiresAt: tokenExpiresAt };
    }
    /** 确认上传完成，保留上传阶段持久化的真实 key 并写入 sha256 */
    async confirmUpload(fileId, sha256) {
        const file = await this.prisma.file.update({
            where: { id: fileId },
            data: { sha256, status: "completed" },
        });
        return { key: file.key, size: file.size };
    }
    /** 为已完成的 File 签发下载令牌 */
    async createDownloadToken(fileId) {
        const file = await this.prisma.file.findUniqueOrThrow({
            where: { id: fileId },
        });
        if (file.status !== "completed") {
            throw Object.assign(new Error("File not ready for download"), {
                statusCode: 400,
            });
        }
        const { url } = await this.storage.createDownloadToken(file.key);
        return { downloadUrl: url, size: file.size, sha256: file.sha256 };
    }
    /** 查询已过期且未被有效分享保护的文件。 */
    async getExpiredFiles() {
        return this.prisma.file.findMany({
            where: {
                expiresAt: { lte: new Date() },
                shares: { none: { revokedAt: null, invalidatedAt: null } },
            },
            select: { id: true, key: true },
        });
    }
    /** 删除 File 记录和 Storage 对象，先通过 deleting 状态认领。 */
    async delete(fileId) {
        const claimed = await this.prisma.$transaction(async (tx) => {
            const file = await tx.file.findUnique({ where: { id: fileId } });
            if (!file)
                return null;
            const activeShares = await tx.storageShare.count({
                where: { fileId, revokedAt: null, invalidatedAt: null },
            });
            if (activeShares > 0) {
                throw Object.assign(new Error("File has active storage shares"), {
                    code: "FILE_HAS_ACTIVE_SHARES",
                    statusCode: 409,
                });
            }
            const result = await tx.file.updateMany({
                where: { id: fileId, status: file.status },
                data: { status: "deleting" },
            });
            if (result.count !== undefined && result.count !== 1) {
                throw Object.assign(new Error("File deletion state changed"), {
                    code: "FILE_DELETE_CONFLICT",
                    statusCode: 409,
                });
            }
            return { id: file.id, key: file.key, status: file.status };
        });
        if (!claimed)
            return;
        try {
            await this.storage.delete(claimed.key);
            await this.prisma.file.delete({ where: { id: claimed.id } });
        }
        catch (error) {
            await this.prisma.file.updateMany({
                where: { id: claimed.id, status: "deleting" },
                data: { status: claimed.status },
            });
            throw error;
        }
    }
    /** 按 Storage key 查询已登记 File。 */
    async findByKey(key) {
        return this.prisma.file.findUnique({ where: { key } });
    }
    /** 按 ID 查询 */
    async findById(fileId) {
        return this.prisma.file.findUnique({ where: { id: fileId } });
    }
};
exports.FileService = FileService;
exports.FileService = FileService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, storage_service_js_1.StorageService])
], FileService);
