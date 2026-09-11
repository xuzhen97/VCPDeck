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
exports.ReleaseCleanupController = void 0;
const common_1 = require("@nestjs/common");
const release_service_js_1 = require("./release.service.js");
const release_cleanup_service_js_1 = require("./release-cleanup.service.js");
/** Release archive 清理控制面 API；默认受全局认证保护。 */
let ReleaseCleanupController = class ReleaseCleanupController {
    cleanup;
    constructor(cleanup) {
        this.cleanup = cleanup;
    }
    /** 预览固定清理策略下的候选正文和上传会话。 */
    preview() {
        return this.cleanup.preview();
    }
    /** 立即按固定清理策略执行一次清理。 */
    async run() {
        try {
            return await this.cleanup.run();
        }
        catch (error) {
            if (error instanceof release_service_js_1.ReleaseError && error.code === "RELEASE_CLEANUP_BUSY") {
                throw new common_1.ConflictException({
                    code: error.code,
                    message: error.message,
                });
            }
            throw error;
        }
    }
};
exports.ReleaseCleanupController = ReleaseCleanupController;
__decorate([
    (0, common_1.Get)("preview"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ReleaseCleanupController.prototype, "preview", null);
__decorate([
    (0, common_1.Post)("run"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReleaseCleanupController.prototype, "run", null);
exports.ReleaseCleanupController = ReleaseCleanupController = __decorate([
    (0, common_1.Controller)("api/releases/cleanup"),
    __param(0, (0, common_1.Inject)(release_cleanup_service_js_1.ReleaseCleanupService)),
    __metadata("design:paramtypes", [release_cleanup_service_js_1.ReleaseCleanupService])
], ReleaseCleanupController);
