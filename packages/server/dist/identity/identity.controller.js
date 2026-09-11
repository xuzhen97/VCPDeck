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
exports.IdentityController = void 0;
const common_1 = require("@nestjs/common");
const identity_service_js_1 = require("./identity.service.js");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
let IdentityController = class IdentityController {
    identityService;
    constructor(identityService) {
        this.identityService = identityService;
    }
    checkAdmin(actor) {
        if (!actor.isAdmin) {
            throw new common_1.ForbiddenException({ statusCode: 403, code: "FORBIDDEN", message: "Admin only" });
        }
    }
    async list(actor) {
        this.checkAdmin(actor);
        return this.identityService.list();
    }
    async create(actor, body) {
        this.checkAdmin(actor);
        return this.identityService.create(body.username, body.password, body.displayName);
    }
    async disable(actor, id) {
        this.checkAdmin(actor);
        await this.identityService.disable(id);
        return { ok: true };
    }
    async enable(actor, id) {
        this.checkAdmin(actor);
        await this.identityService.enable(id);
        return { ok: true };
    }
};
exports.IdentityController = IdentityController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(":id/disable"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "disable", null);
__decorate([
    (0, common_1.Post)(":id/enable"),
    __param(0, (0, actor_decorator_js_1.Actor)()),
    __param(1, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], IdentityController.prototype, "enable", null);
exports.IdentityController = IdentityController = __decorate([
    (0, common_1.Controller)("api/identities"),
    __param(0, (0, common_1.Inject)(identity_service_js_1.IdentityService)),
    __metadata("design:paramtypes", [identity_service_js_1.IdentityService])
], IdentityController);
