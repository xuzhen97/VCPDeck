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
exports.ReleaseUploadController = void 0;
const common_1 = require("@nestjs/common");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const release_service_js_1 = require("./release.service.js");
const release_upload_service_js_1 = require("./release-upload.service.js");
const ERROR_STATUS = {
    RELEASE_DUPLICATE_VERSION: 409,
    RELEASE_ARCHIVE_EXISTS: 409,
    RELEASE_UPLOAD_SESSION_NOT_FOUND: 404,
    RELEASE_UPLOAD_SESSION_EXPIRED: 410,
    RELEASE_UPLOAD_SESSION_CONFLICT: 409,
    RELEASE_UPLOAD_SIZE_MISMATCH: 400,
    RELEASE_UPLOAD_PROVIDER_FAILED: 502,
};
/** Release 外部 Provider 直传控制面 API；不接收构件正文。 */
let ReleaseUploadController = class ReleaseUploadController {
    uploads;
    constructor(uploads) {
        this.uploads = uploads;
    }
    async create(raw, actor) {
        const input = this.parse(() => release_upload_service_js_1.ReleaseUploadContract.parseCreate(raw));
        try {
            return await this.uploads.createSession(input, actor);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    async refreshParts(sessionId, raw) {
        const { partNumbers } = this.parse(() => release_upload_service_js_1.ReleaseUploadContract.parseRefresh(raw));
        try {
            return await this.uploads.refreshParts(sessionId, partNumbers);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    async complete(sessionId, raw) {
        const { uploadedBytes } = this.parse(() => release_upload_service_js_1.ReleaseUploadContract.parseComplete(raw));
        try {
            return await this.uploads.completeSession(sessionId, uploadedBytes);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    parse(operation) {
        try {
            return operation();
        }
        catch (error) {
            throw new common_1.BadRequestException(error instanceof Error ? error.message : "请求无效");
        }
    }
    toHttp(error) {
        if (error instanceof release_upload_service_js_1.ReleaseUploadError || error instanceof release_service_js_1.ReleaseError) {
            return new common_1.HttpException({ code: error.code, message: error.message }, ERROR_STATUS[error.code] ?? 500);
        }
        return new common_1.InternalServerErrorException("Release 上传处理失败");
    }
};
exports.ReleaseUploadController = ReleaseUploadController;
__decorate([
    (0, common_1.Post)(),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ReleaseUploadController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(":sessionId/parts"),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Param)("sessionId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseUploadController.prototype, "refreshParts", null);
__decorate([
    (0, common_1.Post)(":sessionId/complete"),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Param)("sessionId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], ReleaseUploadController.prototype, "complete", null);
exports.ReleaseUploadController = ReleaseUploadController = __decorate([
    (0, common_1.Controller)("api/releases/uploads"),
    __param(0, (0, common_1.Inject)(release_upload_service_js_1.ReleaseUploadService)),
    __metadata("design:paramtypes", [release_upload_service_js_1.ReleaseUploadService])
], ReleaseUploadController);
