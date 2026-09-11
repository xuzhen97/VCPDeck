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
var FileCleanupService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCleanupService = void 0;
const common_1 = require("@nestjs/common");
const file_service_js_1 = require("./file.service.js");
let FileCleanupService = FileCleanupService_1 = class FileCleanupService {
    fileService;
    logger = new common_1.Logger(FileCleanupService_1.name);
    timer = null;
    constructor(fileService) {
        this.fileService = fileService;
    }
    onModuleInit() {
        this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
        this.logger.log("File cleanup scheduler started (every 10min)");
    }
    async cleanup() {
        try {
            const expired = await this.fileService.getExpiredFiles();
            for (const f of expired) {
                await this.fileService.delete(f.id);
            }
            if (expired.length > 0) {
                this.logger.log(`Cleaned up ${expired.length} expired file(s)`);
            }
        }
        catch (err) {
            this.logger.warn("File cleanup error", err);
        }
    }
};
exports.FileCleanupService = FileCleanupService;
exports.FileCleanupService = FileCleanupService = FileCleanupService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(file_service_js_1.FileService)),
    __metadata("design:paramtypes", [file_service_js_1.FileService])
], FileCleanupService);
