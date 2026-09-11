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
exports.PiAttachmentService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const file_service_js_1 = require("../file/file.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
const shared_1 = require("@vcpdeck/shared");
/** prompt 附件 TTL（15 分钟） */
const PROMPT_TTL_MS = 15 * 60 * 1000;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function piError(code, message) {
    return Object.assign(new Error(message), { code });
}
/**
 * Pi 临时附件：Browser 上传到 Storage → FileRef → Client 校验 → prompt。
 * File row 用 purpose=pi_prompt/pi_history、jobId=null、15 分钟 TTL；
 * 不使用临时对象时由 TTL 清理（cleanup scheduler 复用）。
 */
let PiAttachmentService = class PiAttachmentService {
    files;
    storage;
    prisma;
    constructor(files, storage, prisma) {
        this.files = files;
        this.storage = storage;
        this.prisma = prisma;
    }
    /** 校验图片清单（数量/单图/总量/MIME） */
    validateImages(images) {
        if (images.length === 0 || images.length > shared_1.MAX_PI_IMAGES_PER_PROMPT) {
            throw piError("PI_IMAGE_INVALID", `Images count must be 1..${shared_1.MAX_PI_IMAGES_PER_PROMPT}`);
        }
        let total = 0;
        for (const img of images) {
            if (!ALLOWED_MIME.has(img.mimeType)) {
                throw piError("PI_IMAGE_INVALID", `Unsupported image type: ${img.mimeType}`);
            }
            if (!Number.isFinite(img.size) || img.size <= 0) {
                throw piError("PI_IMAGE_INVALID", "Image size must be positive");
            }
            if (img.size > shared_1.MAX_PI_IMAGE_BYTES) {
                throw piError("PI_IMAGE_TOO_LARGE", `Image exceeds ${shared_1.MAX_PI_IMAGE_BYTES} bytes`);
            }
            total += img.size;
        }
        if (total > shared_1.MAX_PI_IMAGES_TOTAL_BYTES) {
            throw piError("PI_IMAGE_TOO_LARGE", `Images total exceeds ${shared_1.MAX_PI_IMAGES_TOTAL_BYTES} bytes`);
        }
    }
    /** 创建 prompt 附件上传会话（返回 PUT 令牌，未 complete 由 TTL 清理） */
    async createPromptUploads(clientId, images) {
        this.validateImages(images);
        const out = [];
        for (const img of images) {
            const pending = await this.files.createPending(undefined, clientId, {
                clientId,
                filename: img.filename,
                mimeType: img.mimeType,
                size: img.size,
            }, { expiresAt: new Date(Date.now() + PROMPT_TTL_MS), purpose: "pi_prompt" });
            out.push({
                fileId: pending.fileId,
                uploadUrl: pending.uploadUrl,
                expiresAt: pending.expiresAt,
            });
        }
        return out;
    }
    /** complete 后返回给 Client 的 transient 描述符（Client 下载并校验 hash/mime/magic） */
    async completePromptUpload(attachmentId, clientId) {
        const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
        if (!file || file.purpose !== "pi_prompt" || file.clientId !== clientId) {
            throw piError("PI_IMAGE_INVALID", "Attachment not found");
        }
        if (file.status !== "completed") {
            throw piError("PI_IMAGE_INVALID", "Attachment upload not completed");
        }
        const dl = await this.storage.createDownloadToken(file.key);
        return {
            fileId: file.id,
            sha256: file.sha256,
            size: file.size,
            mimeType: file.mimeType ?? "application/octet-stream",
            url: dl.url,
            expiresAt: dl.expiresAt,
        };
    }
    /** 清理临时附件（prompt 拒绝/失败/取消时） */
    async deleteAttachment(attachmentId, clientId) {
        const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
        if (!file || file.clientId !== clientId)
            return;
        await this.files.delete(file.id);
    }
    /** 历史媒体三阶段第一步：Client 验证后创建 pi_history 上传会话 */
    async prepareHistoryUpload(clientId, meta) {
        this.validateImages([meta]);
        const pending = await this.files.createPending(undefined, clientId, {
            clientId,
            filename: meta.filename,
            mimeType: meta.mimeType,
            size: meta.size,
        }, { expiresAt: new Date(Date.now() + PROMPT_TTL_MS), purpose: "pi_history" });
        return {
            fileId: pending.fileId,
            uploadUrl: pending.uploadUrl,
            expiresAt: pending.expiresAt,
        };
    }
    /** 历史媒体第三步：Client 上传完成，返回浏览器短期 GET ref */
    async completeHistoryUpload(attachmentId, clientId) {
        const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
        if (!file || file.purpose !== "pi_history" || file.clientId !== clientId) {
            throw piError("PI_IMAGE_INVALID", "History attachment not found");
        }
        if (file.status !== "completed") {
            throw piError("PI_IMAGE_INVALID", "History attachment upload not completed");
        }
        const dl = await this.storage.createDownloadToken(file.key);
        return { url: dl.url, expiresAt: dl.expiresAt };
    }
};
exports.PiAttachmentService = PiAttachmentService;
exports.PiAttachmentService = PiAttachmentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(file_service_js_1.FileService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __param(2, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [file_service_js_1.FileService, storage_service_js_1.StorageService, prisma_service_js_1.PrismaService])
], PiAttachmentService);
