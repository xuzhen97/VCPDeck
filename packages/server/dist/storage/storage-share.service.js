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
exports.StorageShareService = void 0;
exports.previewMime = previewMime;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const storage_service_js_1 = require("./storage.service.js");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_SHARE_PATH = "/api/public/storage-shares/";
const PREVIEW_MIME = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
};
function shareError(code, message, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}
function sha256(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
/** 根据文件名返回固定的图片 MIME；不信任上传 MIME。 */
function previewMime(filename) {
    const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return extension ? PREVIEW_MIME[extension] ?? null : null;
}
function statusOf(row) {
    if (row.revokedAt)
        return "revoked";
    if (row.invalidatedAt || !row.fileId)
        return "invalid";
    return "active";
}
let StorageShareService = class StorageShareService {
    prisma;
    storage;
    constructor(prisma, storage) {
        this.prisma = prisma;
        this.storage = storage;
    }
    /** 创建独立的长期公开分享；数据库只保存 Token 哈希。 */
    async create(request, actor) {
        const currentKind = this.storage.currentKind();
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
            try {
                const row = await this.prisma.$transaction(async (tx) => {
                    const file = await tx.file.findUnique({ where: { id: request.fileId } });
                    if (!file || file.status !== "completed") {
                        throw shareError("FILE_NOT_SHAREABLE", "File cannot be shared", 409);
                    }
                    if (file.storageKind !== currentKind) {
                        throw shareError("STORAGE_PROVIDER_MISMATCH", "Storage provider is temporarily unavailable", 503);
                    }
                    return tx.storageShare.create({
                        data: {
                            id: (0, node_crypto_1.randomUUID)(),
                            tokenHash: sha256(token),
                            fileId: file.id,
                            filename: file.filename,
                            mimeType: file.mimeType,
                            storageKind: file.storageKind,
                            createdByIdentityId: actor.identityId,
                            createdByName: actor.displayName,
                            createdVia: actor.source,
                        },
                    });
                });
                return { ...this.toInfo(row), sharePath: `${PUBLIC_SHARE_PATH}${token}` };
            }
            catch (error) {
                if (attempt === 1 || !this.isUniqueError(error))
                    throw error;
            }
        }
        throw new Error("Unable to create storage share");
    }
    /** 分页查询分享管理信息。 */
    async list(options = {}) {
        const page = options.page ?? 1;
        const pageSize = options.pageSize ?? 20;
        let where = {};
        if (options.fileId)
            where.fileId = options.fileId;
        if (options.status === "active") {
            where.revokedAt = null;
            where.invalidatedAt = null;
        }
        if (options.status === "revoked")
            where.revokedAt = { not: null };
        if (options.status === "invalid")
            where = { ...where, revokedAt: null, OR: [{ invalidatedAt: { not: null } }, { fileId: null }] };
        const [rows, total] = await Promise.all([
            this.prisma.storageShare.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
            this.prisma.storageShare.count({ where }),
        ]);
        return { data: rows.map((row) => this.toInfo(row)), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
    }
    /** 查询单条分享，不恢复公开路径。 */
    async get(id) {
        const row = await this.prisma.storageShare.findUnique({ where: { id } });
        if (!row)
            throw shareError("STORAGE_SHARE_NOT_FOUND", "Storage share not found", 404);
        return this.toInfo(row);
    }
    /** 幂等软撤销分享。 */
    async revoke(id, actor) {
        const row = await this.prisma.storageShare.findUnique({ where: { id } });
        if (!row)
            throw shareError("STORAGE_SHARE_NOT_FOUND", "Storage share not found", 404);
        if (row.revokedAt)
            return this.toInfo(row);
        const updated = await this.prisma.storageShare.update({
            where: { id },
            data: { revokedAt: new Date(), revokedByIdentityId: actor.identityId },
        });
        return this.toInfo(updated);
    }
    /** 查询 File 是否仍被有效分享保护。 */
    async hasActiveShares(fileId) {
        const count = await this.prisma.storageShare.count({
            where: { fileId, revokedAt: null, invalidatedAt: null },
        });
        return count > 0;
    }
    /** 按公开 Token 哈希查找内部分享记录。 */
    async resolvePublic(token) {
        if (!TOKEN_RE.test(token))
            throw shareError("STORAGE_SHARE_NOT_FOUND", "Not found", 404);
        const row = await this.prisma.storageShare.findUnique({
            where: { tokenHash: sha256(token) },
            include: { file: true },
        });
        if (!row)
            throw shareError("STORAGE_SHARE_NOT_FOUND", "Not found", 404);
        return row;
    }
    /** 标记 Provider 已确认永久缺失的分享。 */
    async markInvalid(id, reason) {
        await this.prisma.storageShare.updateMany({
            where: { id, revokedAt: null, invalidatedAt: null },
            data: { invalidatedAt: new Date(), invalidReason: reason },
        });
    }
    /** 将数据库行映射为不含 Token 的管理 DTO。 */
    toInfo(row) {
        return {
            id: row.id,
            fileId: row.fileId,
            filename: row.filename,
            mimeType: row.mimeType,
            storageKind: row.storageKind,
            status: statusOf(row),
            previewable: previewMime(row.filename) !== null,
            createdByIdentityId: row.createdByIdentityId,
            createdByName: row.createdByName,
            createdVia: row.createdVia,
            createdAt: row.createdAt.toISOString(),
            revokedAt: row.revokedAt?.toISOString() ?? null,
            revokedByIdentityId: row.revokedByIdentityId,
            invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
            invalidReason: row.invalidReason,
        };
    }
    isUniqueError(error) {
        return typeof error === "object" && error !== null && error.code === "P2002";
    }
};
exports.StorageShareService = StorageShareService;
exports.StorageShareService = StorageShareService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, storage_service_js_1.StorageService])
], StorageShareService);
