"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileModule = void 0;
const common_1 = require("@nestjs/common");
const file_service_js_1 = require("./file.service.js");
const file_cleanup_service_js_1 = require("./file-cleanup.service.js");
const storage_module_js_1 = require("../storage/storage.module.js");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
const storage_delete_controller_js_1 = require("./storage-delete.controller.js");
let FileModule = class FileModule {
};
exports.FileModule = FileModule;
exports.FileModule = FileModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_js_1.PrismaModule, storage_module_js_1.StorageModule],
        providers: [file_service_js_1.FileService, file_cleanup_service_js_1.FileCleanupService],
        controllers: [storage_delete_controller_js_1.StorageDeleteController],
        exports: [file_service_js_1.FileService],
    })
], FileModule);
