"use strict";
/** @file FRP 实例配置 REST API */
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
exports.FrpsInstancesController = void 0;
const common_1 = require("@nestjs/common");
const frp_instances_service_js_1 = require("./frp-instances.service.js");
let FrpsInstancesController = class FrpsInstancesController {
    instancesService;
    constructor(instancesService) {
        this.instancesService = instancesService;
    }
    async create(body) {
        if (!body.name || !body.serverAddr) {
            throw new common_1.BadRequestException("缺少必填字段：name, serverAddr");
        }
        return this.instancesService.create(body);
    }
    async list(page, pageSize) {
        return this.instancesService.list(page ? Math.max(1, parseInt(page, 10)) : undefined, pageSize
            ? Math.min(100, Math.max(1, parseInt(pageSize, 10)))
            : undefined);
    }
    async get(id) {
        const instance = await this.instancesService.getById(id);
        if (!instance) {
            throw new common_1.BadRequestException(`实例 "${id}" 不存在`);
        }
        return instance;
    }
    async update(id, body) {
        try {
            return await this.instancesService.update(id, body);
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message);
        }
    }
    async delete(id) {
        try {
            const deleted = await this.instancesService.delete(id);
            if (!deleted) {
                throw new common_1.BadRequestException(`实例 "${id}" 不存在`);
            }
            return { id, deleted: true };
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message);
        }
    }
    async probe(id) {
        try {
            return await this.instancesService.probe(id);
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message);
        }
    }
    async setDefault(id) {
        try {
            return await this.instancesService.setDefault(id);
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message);
        }
    }
};
exports.FrpsInstancesController = FrpsInstancesController;
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)("page")),
    __param(1, (0, common_1.Query)("pageSize")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "list", null);
__decorate([
    (0, common_1.Get)(":id"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "get", null);
__decorate([
    (0, common_1.Put)(":id"),
    __param(0, (0, common_1.Param)("id")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(":id"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "delete", null);
__decorate([
    (0, common_1.Post)(":id/probe"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "probe", null);
__decorate([
    (0, common_1.Post)(":id/set-default"),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FrpsInstancesController.prototype, "setDefault", null);
exports.FrpsInstancesController = FrpsInstancesController = __decorate([
    (0, common_1.Controller)("api/frp/instances"),
    __param(0, (0, common_1.Inject)(frp_instances_service_js_1.FrpsInstancesService)),
    __metadata("design:paramtypes", [frp_instances_service_js_1.FrpsInstancesService])
], FrpsInstancesController);
