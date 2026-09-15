"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_js_1 = require("./prisma/prisma.module.js");
const events_module_js_1 = require("./events/events.module.js");
const auth_module_js_1 = require("./auth/auth.module.js");
const identity_module_js_1 = require("./identity/identity.module.js");
const storage_module_js_1 = require("./storage/storage.module.js");
const file_module_js_1 = require("./file/file.module.js");
const frp_module_js_1 = require("./frp/frp.module.js");
const tunnel_module_js_1 = require("./tunnel/tunnel.module.js");
const pi_module_js_1 = require("./pi/pi.module.js");
const release_module_js_1 = require("./release/release.module.js");
const client_installer_module_js_1 = require("./client-installer/client-installer.module.js");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            prisma_module_js_1.PrismaModule,
            auth_module_js_1.AuthModule,
            identity_module_js_1.IdentityModule,
            events_module_js_1.EventsModule,
            storage_module_js_1.StorageModule,
            file_module_js_1.FileModule,
            frp_module_js_1.FrpModule,
            tunnel_module_js_1.TunnelModule,
            pi_module_js_1.PiModule,
            release_module_js_1.ReleaseModule,
            client_installer_module_js_1.ClientInstallerModule,
        ],
    })
], AppModule);
