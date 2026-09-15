"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventsModule = void 0;
const common_1 = require("@nestjs/common");
const client_gateway_js_1 = require("./client.gateway.js");
const app_gateway_js_1 = require("./app.gateway.js");
const events_controller_js_1 = require("./events.controller.js");
const client_module_js_1 = require("../client/client.module.js");
const job_module_js_1 = require("../job/job.module.js");
const file_module_js_1 = require("../file/file.module.js");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
const frp_module_js_1 = require("../frp/frp.module.js");
const storage_module_js_1 = require("../storage/storage.module.js");
const pi_module_js_1 = require("../pi/pi.module.js");
const terminal_module_js_1 = require("../terminal/terminal.module.js");
const release_module_js_1 = require("../release/release.module.js");
const tunnel_module_js_1 = require("../tunnel/tunnel.module.js");
let EventsModule = class EventsModule {
};
exports.EventsModule = EventsModule;
exports.EventsModule = EventsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            client_module_js_1.ClientModule,
            job_module_js_1.JobModule,
            file_module_js_1.FileModule,
            prisma_module_js_1.PrismaModule,
            storage_module_js_1.StorageModule,
            (0, common_1.forwardRef)(() => frp_module_js_1.FrpModule),
            (0, common_1.forwardRef)(() => release_module_js_1.ReleaseModule),
            pi_module_js_1.PiModule,
            terminal_module_js_1.TerminalModule,
            tunnel_module_js_1.TunnelModule,
        ],
        providers: [client_gateway_js_1.ClientGateway, app_gateway_js_1.AppGateway],
        exports: [client_gateway_js_1.ClientGateway],
        controllers: [events_controller_js_1.EventsController],
    })
], EventsModule);
