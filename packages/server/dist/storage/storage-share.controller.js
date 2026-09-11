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
exports.StorageShareController = void 0;
const common_1 = require("@nestjs/common");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const storage_share_service_js_1 = require("./storage-share.service.js");
const STATUS = new Set(["active", "revoked", "invalid"]);
function pageValue(value, fallback) {
    if (value === undefined || value === "")
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1)
        return fallback;
    return parsed;
}
function toHttp(error) {
    const failure = error;
    if (failure.statusCode) {
        return new common_1.HttpException({ code: failure.code, message: failure.message }, failure.statusCode);
    }
    return new common_1.HttpException({ code: "STORAGE_SHARE_FAILED", message: "Storage share operation failed" }, 500);
}
let StorageShareController = class StorageShareController {
    service;
    constructor(service) {
        this.service = service;
    }
    async create(body, actor) {
        if (!body || typeof body.fileId !== "string" || !body.fileId || Object.keys(body).some((key) => key !== "fileId")) {
            throw new common_1.BadRequestException("fileId is required");
        }
        try {
            return await this.service.create(body, actor);
        }
        catch (error) {
            throw toHttp(error);
        }
    }
    async list(fileId, status, page, pageSize) {
        if (status && !STATUS.has(status)) {
            throw new common_1.BadRequestException("status must be active, revoked, or invalid");
        }
        try {
            return await this.service.list({
                fileId,
                status: status,
                page: pageValue(page, 1),
                pageSize: Math.min(100, pageValue(pageSize, 20)),
            });
        }
        catch (error) {
            if (error instanceof common_1.HttpException)
                throw error;
            throw toHttp(error);
        }
    }
    async get(id) {
        try {
            return await this.service.get(id);
        }
        catch (error) {
            throw toHttp(error);
        }
    }
    async revoke(id, actor) {
        try {
            return await this.service.revoke(id, actor);
        }
        catch (error) {
            throw toHttp(error);
        }
    }
};
exports.StorageShareController = StorageShareController;
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], StorageShareController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)("fileId")),
    __param(1, (0, common_1.Query)("status")),
    __param(2, (0, common_1.Query)("page")),
    __param(3, (0, common_1.Query)("pageSize")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], StorageShareController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(":id"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], StorageShareController.prototype, "get", null);
__decorate([
    (0, common_1.Delete)(":id"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], StorageShareController.prototype, "revoke", null);
exports.StorageShareController = StorageShareController = __decorate([
    (0, common_1.Controller)("api/storage/shares"),
    __param(0, (0, common_1.Inject)(storage_share_service_js_1.StorageShareService)),
    __metadata("design:paramtypes", [storage_share_service_js_1.StorageShareService])
], StorageShareController);
