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
exports.StorageController = void 0;
const common_1 = require("@nestjs/common");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const storage_service_js_1 = require("./storage.service.js");
const DEFAULT_TTL = 3600; // 1 小时
let StorageController = class StorageController {
    storageService;
    constructor(storageService) {
        this.storageService = storageService;
    }
    /** 签发上传令牌 */
    async createUploadToken(body) {
        const ref = await this.storageService.createUploadToken({
            jobId: body.jobId,
            clientId: body.clientId,
            filename: body.filename,
            size: body.size,
            mimeType: body.mimeType,
        }, body.ttlSeconds ?? DEFAULT_TTL);
        return { url: ref.url, expiresAt: ref.expiresAt };
    }
    /** 签发下载令牌 */
    async createDownloadToken(body) {
        const ref = await this.storageService.createDownloadToken(body.key, body.ttlSeconds ?? DEFAULT_TTL);
        return { url: ref.url, expiresAt: ref.expiresAt };
    }
    /** 受鉴权的稳定下载入口；每次请求实时签发后端 URL */
    async redirectDownload(key, res) {
        const ref = await this.storageService.createDownloadToken(key);
        res.status(302);
        res.setHeader("Location", ref.url);
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Cache-Control", "private, no-store");
        res.end();
    }
    /** 接收文件上传（预签名 URL） */
    async receiveUpload(key, expires, sig, req) {
        const entry = await this.storageService.receiveUpload(key, req, parseInt(expires, 10), sig);
        return { key: entry.key, size: entry.size };
    }
    /** 下载文件（预签名 URL） */
    async download(key, expires, sig, res) {
        const { stream, meta } = await this.storageService.downloadVerified(key, parseInt(expires, 10), sig);
        // 优先用 DB File 记录的真实文件名（阿里云盘后端 meta.filename 为 fileId）
        const filename = (await this.storageService.resolveFilename(key)) ?? meta.filename;
        res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader("Content-Length", meta.size);
        // 上游流中断时销毁响应，避免浏览器挂起等待直到超时报错
        stream.on("error", () => {
            res.destroy();
        });
        stream.pipe(res);
    }
    /** 查看当前存储后端配置 */
    async getConfig() {
        return this.storageService.getBackendConfig();
    }
    /** 切换存储后端 */
    async updateConfig(body) {
        await this.storageService.updateBackendConfig(body);
        return this.storageService.getBackendConfig();
    }
};
exports.StorageController = StorageController;
__decorate([
    (0, common_1.Post)("upload-token"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "createUploadToken", null);
__decorate([
    (0, common_1.Post)("download-token"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "createDownloadToken", null);
__decorate([
    (0, common_1.Get)("download-redirect/:key(*)"),
    __param(0, (0, common_1.Param)("key")),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "redirectDownload", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Put)("upload/:key(*)"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Param)("key")),
    __param(1, (0, common_1.Query)("expires")),
    __param(2, (0, common_1.Query)("sig")),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "receiveUpload", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("download/:key(*)"),
    __param(0, (0, common_1.Param)("key")),
    __param(1, (0, common_1.Query)("expires")),
    __param(2, (0, common_1.Query)("sig")),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "download", null);
__decorate([
    (0, common_1.Get)("config"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "getConfig", null);
__decorate([
    (0, common_1.Put)("config"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], StorageController.prototype, "updateConfig", null);
exports.StorageController = StorageController = __decorate([
    (0, common_1.Controller)("api/storage"),
    __param(0, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [storage_service_js_1.StorageService])
], StorageController);
