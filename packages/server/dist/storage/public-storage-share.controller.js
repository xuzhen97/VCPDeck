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
exports.PublicStorageShareController = void 0;
const common_1 = require("@nestjs/common");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const storage_provider_interface_js_1 = require("./providers/storage-provider.interface.js");
const storage_share_service_js_1 = require("./storage-share.service.js");
const storage_service_js_1 = require("./storage.service.js");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
function publicError(status, message) {
    if (status === 404)
        return new common_1.NotFoundException({ code: "NOT_FOUND", message });
    if (status === 410)
        return new common_1.GoneException({ code: "GONE", message });
    if (status === 503) {
        return new common_1.ServiceUnavailableException({ code: "UNAVAILABLE", message });
    }
    return new common_1.BadGatewayException({ code: "STORAGE_UNAVAILABLE", message });
}
let PublicStorageShareController = class PublicStorageShareController {
    shares;
    storage;
    constructor(shares, storage) {
        this.shares = shares;
        this.storage = storage;
    }
    /** 无认证公开读取分享文件。 */
    async download(token, response) {
        if (!TOKEN_RE.test(token))
            throw publicError(404, "Not found");
        let resolved;
        try {
            resolved = await this.shares.resolvePublic(token);
        }
        catch (error) {
            throw this.mapPublicError(error);
        }
        const file = resolved.file;
        if (!file || resolved.revokedAt || resolved.invalidatedAt) {
            throw publicError(410, "Share is no longer available");
        }
        if (file.status !== "completed")
            throw publicError(404, "Not found");
        if (file.storageKind !== this.storage.currentKind()) {
            throw publicError(503, "Storage is temporarily unavailable");
        }
        try {
            const ref = await this.storage.createDownloadToken(file.key);
            response.status(302);
            response.setHeader("Location", ref.url);
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("Cache-Control", "private, no-store");
            response.end();
        }
        catch (error) {
            if (error instanceof storage_provider_interface_js_1.StorageObjectNotFoundError) {
                await this.shares.markInvalid(resolved.id, "OBJECT_NOT_FOUND");
                throw publicError(410, "Share is no longer available");
            }
            throw publicError(502, "Storage is temporarily unavailable");
        }
    }
    mapPublicError(error) {
        const status = error.statusCode;
        if (status === 404)
            return publicError(404, "Not found");
        if (status === 410)
            return publicError(410, "Share is no longer available");
        return publicError(502, "Storage is temporarily unavailable");
    }
};
exports.PublicStorageShareController = PublicStorageShareController;
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)(":token"),
    __param(0, (0, common_1.Param)("token")),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PublicStorageShareController.prototype, "download", null);
exports.PublicStorageShareController = PublicStorageShareController = __decorate([
    (0, common_1.Controller)("api/public/storage-shares"),
    __param(0, (0, common_1.Inject)(storage_share_service_js_1.StorageShareService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [storage_share_service_js_1.StorageShareService, storage_service_js_1.StorageService])
], PublicStorageShareController);
