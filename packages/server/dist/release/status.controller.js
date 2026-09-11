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
exports.StatusController = void 0;
/**
 * 状态端点：GET /api/status 返回服务端版本与当前活动 release。
 * 供 Launcher 健康探活与前端展示；详见 docs/design/release-and-update.md。
 */
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const release_service_js_1 = require("./release.service.js");
let StatusController = class StatusController {
    releases;
    constructor(releases) {
        this.releases = releases;
    }
    /** launcher 健康探活使用，公开 */
    async get() {
        return {
            serverVersion: shared_1.VERSION,
            activeRelease: await this.releases.getActiveRelease(),
        };
    }
};
exports.StatusController = StatusController;
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], StatusController.prototype, "get", null);
exports.StatusController = StatusController = __decorate([
    (0, common_1.Controller)("api/status"),
    __param(0, (0, common_1.Inject)(release_service_js_1.ReleaseService)),
    __metadata("design:paramtypes", [release_service_js_1.ReleaseService])
], StatusController);
