"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseModule = void 0;
const common_1 = require("@nestjs/common");
const release_controller_js_1 = require("./release.controller.js");
const release_service_js_1 = require("./release.service.js");
const release_orchestrator_js_1 = require("./release.orchestrator.js");
const update_channel_js_1 = require("./update-channel.js");
const launcher_client_js_1 = require("./launcher-client.js");
const status_controller_js_1 = require("./status.controller.js");
const job_module_js_1 = require("../job/job.module.js");
const client_module_js_1 = require("../client/client.module.js");
const storage_module_js_1 = require("../storage/storage.module.js");
const release_upload_controller_js_1 = require("./release-upload.controller.js");
const release_upload_service_js_1 = require("./release-upload.service.js");
const release_cleanup_controller_js_1 = require("./release-cleanup.controller.js");
const release_cleanup_service_js_1 = require("./release-cleanup.service.js");
let ReleaseModule = class ReleaseModule {
};
exports.ReleaseModule = ReleaseModule;
exports.ReleaseModule = ReleaseModule = __decorate([
    (0, common_1.Module)({
        imports: [job_module_js_1.JobModule, client_module_js_1.ClientModule, storage_module_js_1.StorageModule],
        controllers: [
            release_controller_js_1.ReleaseController,
            release_upload_controller_js_1.ReleaseUploadController,
            release_cleanup_controller_js_1.ReleaseCleanupController,
            status_controller_js_1.StatusController,
        ],
        providers: [
            release_service_js_1.ReleaseService,
            release_upload_service_js_1.ReleaseUploadService,
            release_cleanup_service_js_1.ReleaseCleanupService,
            release_orchestrator_js_1.ReleaseOrchestrator,
            update_channel_js_1.GatewayUpdateChannel,
            launcher_client_js_1.LauncherHttpClient,
        ],
        exports: [
            release_service_js_1.ReleaseService,
            release_cleanup_service_js_1.ReleaseCleanupService,
            release_orchestrator_js_1.ReleaseOrchestrator,
            update_channel_js_1.GatewayUpdateChannel,
        ],
    })
], ReleaseModule);
