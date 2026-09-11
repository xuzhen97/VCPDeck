"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
const storage_service_js_1 = require("./storage.service.js");
const storage_controller_js_1 = require("./storage.controller.js");
const aliyundrive_controller_js_1 = require("./aliyundrive.controller.js");
const storage_share_service_js_1 = require("./storage-share.service.js");
const storage_share_controller_js_1 = require("./storage-share.controller.js");
const public_storage_share_controller_js_1 = require("./public-storage-share.controller.js");
let StorageModule = class StorageModule {
};
exports.StorageModule = StorageModule;
exports.StorageModule = StorageModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_js_1.PrismaModule],
        providers: [storage_service_js_1.StorageService, storage_share_service_js_1.StorageShareService],
        controllers: [
            storage_controller_js_1.StorageController,
            aliyundrive_controller_js_1.AliyunDriveController,
            storage_share_controller_js_1.StorageShareController,
            public_storage_share_controller_js_1.PublicStorageShareController,
        ],
        exports: [storage_service_js_1.StorageService, storage_share_service_js_1.StorageShareService],
    })
], StorageModule);
