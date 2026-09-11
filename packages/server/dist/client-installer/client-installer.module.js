"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientInstallerModule = void 0;
const common_1 = require("@nestjs/common");
const client_module_js_1 = require("../client/client.module.js");
const release_module_js_1 = require("../release/release.module.js");
const client_installer_controller_js_1 = require("./client-installer.controller.js");
const client_installer_service_js_1 = require("./client-installer.service.js");
/** 注册 Client 一键安装配置、公开引导与验收接口。 */
let ClientInstallerModule = class ClientInstallerModule {
};
exports.ClientInstallerModule = ClientInstallerModule;
exports.ClientInstallerModule = ClientInstallerModule = __decorate([
    (0, common_1.Module)({
        imports: [client_module_js_1.ClientModule, release_module_js_1.ReleaseModule],
        controllers: [client_installer_controller_js_1.ClientInstallerController],
        providers: [client_installer_service_js_1.ClientInstallerService],
    })
], ClientInstallerModule);
