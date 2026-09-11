"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiModule = void 0;
const common_1 = require("@nestjs/common");
const client_module_js_1 = require("../client/client.module.js");
const pi_controller_js_1 = require("./pi.controller.js");
const pi_attachment_service_js_1 = require("./pi-attachment.service.js");
const pi_event_broker_js_1 = require("./pi-event-broker.js");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
const pi_run_service_js_1 = require("./pi-run.service.js");
const file_module_js_1 = require("../file/file.module.js");
const storage_module_js_1 = require("../storage/storage.module.js");
/** 远程 Pi 模块：broker/run 状态机 + REST/SSE Controller */
let PiModule = class PiModule {
};
exports.PiModule = PiModule;
exports.PiModule = PiModule = __decorate([
    (0, common_1.Module)({
        imports: [client_module_js_1.ClientModule, file_module_js_1.FileModule, storage_module_js_1.StorageModule],
        controllers: [pi_controller_js_1.PiController],
        providers: [pi_request_broker_js_1.PiRequestBroker, pi_event_broker_js_1.PiEventBroker, pi_run_service_js_1.PiRunService, pi_attachment_service_js_1.PiAttachmentService],
        exports: [pi_request_broker_js_1.PiRequestBroker, pi_event_broker_js_1.PiEventBroker, pi_run_service_js_1.PiRunService],
    })
], PiModule);
