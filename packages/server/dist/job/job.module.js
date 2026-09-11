"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobModule = void 0;
const common_1 = require("@nestjs/common");
const job_service_js_1 = require("./job.service.js");
const job_scheduler_js_1 = require("./job.scheduler.js");
const server_drain_js_1 = require("./server-drain.js");
const file_module_js_1 = require("../file/file.module.js");
const storage_module_js_1 = require("../storage/storage.module.js");
let JobModule = class JobModule {
};
exports.JobModule = JobModule;
exports.JobModule = JobModule = __decorate([
    (0, common_1.Module)({
        imports: [file_module_js_1.FileModule, storage_module_js_1.StorageModule],
        providers: [job_service_js_1.JobService, job_scheduler_js_1.JobScheduler, server_drain_js_1.ServerDrain],
        exports: [job_service_js_1.JobService, job_scheduler_js_1.JobScheduler, server_drain_js_1.ServerDrain],
    })
], JobModule);
