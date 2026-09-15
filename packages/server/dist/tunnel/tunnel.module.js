"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TunnelModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_js_1 = require("../prisma/prisma.module.js");
const tunnel_config_service_js_1 = require("./tunnel-config.service.js");
const tunnel_session_service_js_1 = require("./tunnel-session.service.js");
const tunnel_controller_js_1 = require("./tunnel.controller.js");
/** P2P 隧道：ICE/coturn 配置、临时 Session 与 REST 控制面。 */
let TunnelModule = class TunnelModule {
};
exports.TunnelModule = TunnelModule;
exports.TunnelModule = TunnelModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_js_1.PrismaModule],
        providers: [tunnel_config_service_js_1.TunnelConfigService, tunnel_session_service_js_1.TunnelSessionService],
        exports: [tunnel_config_service_js_1.TunnelConfigService, tunnel_session_service_js_1.TunnelSessionService],
        controllers: [tunnel_controller_js_1.TunnelController],
    })
], TunnelModule);
