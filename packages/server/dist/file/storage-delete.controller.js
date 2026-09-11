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
exports.StorageDeleteController = void 0;
const common_1 = require("@nestjs/common");
const file_service_js_1 = require("./file.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
/** 受控 Storage 删除入口：已登记 File 必须经过 FileService 保留锁。 */
let StorageDeleteController = class StorageDeleteController {
    files;
    storage;
    constructor(files, storage) {
        this.files = files;
        this.storage = storage;
    }
    async delete(key) {
        try {
            const file = await this.files.findByKey(key);
            if (file) {
                await this.files.delete(file.id);
            }
            else {
                await this.storage.delete(key);
            }
            return { ok: true };
        }
        catch (error) {
            const failure = error;
            if (failure.statusCode) {
                throw new common_1.HttpException({ code: failure.code, message: failure.message }, failure.statusCode);
            }
            throw new common_1.HttpException({ code: "STORAGE_DELETE_FAILED", message: "Storage delete failed" }, 500);
        }
    }
};
exports.StorageDeleteController = StorageDeleteController;
__decorate([
    (0, common_1.Delete)(":key(*)"),
    __param(0, (0, common_1.Param)("key")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], StorageDeleteController.prototype, "delete", null);
exports.StorageDeleteController = StorageDeleteController = __decorate([
    (0, common_1.Controller)("api/storage/raw"),
    __param(0, (0, common_1.Inject)(file_service_js_1.FileService)),
    __param(1, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [file_service_js_1.FileService, storage_service_js_1.StorageService])
], StorageDeleteController);
