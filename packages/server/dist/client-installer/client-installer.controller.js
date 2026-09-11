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
exports.ClientInstallerController = void 0;
const common_1 = require("@nestjs/common");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const client_installer_service_js_1 = require("./client-installer.service.js");
function parsePlatform(value) {
    if (value === "win-x64" || value === "linux-x64")
        return value;
    throw new Error("platform 必须为 win-x64 或 linux-x64");
}
function parseConfigUpdate(value) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") {
        throw new Error("body 必须且只能包含 boolean enabled");
    }
    return { enabled: value.enabled };
}
function parseNameUpdate(value) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.name !== "string") {
        throw new Error("body 必须且只能包含 string name");
    }
    const name = value.name.trim();
    if (!name || name.length > 100)
        throw new Error("name 长度必须为 1-100");
    return { name };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const ASSET_CONTENT_TYPES = {
    "install-client-bootstrap.sh": "text/x-shellscript; charset=utf-8",
    "install-client-bootstrap.ps1": "text/plain; charset=utf-8",
    "install-client.cjs": "text/javascript; charset=utf-8",
    "install-client-linux.cjs": "text/javascript; charset=utf-8",
    "install.cjs": "text/javascript; charset=utf-8",
    "uninstall-client-bootstrap.sh": "text/x-shellscript; charset=utf-8",
    "uninstall-client-bootstrap.ps1": "text/plain; charset=utf-8",
    "uninstall-client.cjs": "text/javascript; charset=utf-8",
    "uninstall-client-linux.cjs": "text/javascript; charset=utf-8",
};
/** Client 一键安装配置、脚本、bootstrap 与上线验收 API。 */
let ClientInstallerController = class ClientInstallerController {
    service;
    constructor(service) {
        this.service = service;
    }
    getConfig() {
        return this.service.getConfig();
    }
    updateConfig(raw, actor) {
        try {
            const { enabled } = parseConfigUpdate(raw);
            return this.service.updateConfig(enabled, actor);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    getScript(rawPlatform, response) {
        try {
            const platform = parsePlatform(rawPlatform);
            const name = platform === "win-x64"
                ? "install-client-bootstrap.ps1"
                : "install-client-bootstrap.sh";
            const contentType = ASSET_CONTENT_TYPES[name];
            if (!contentType)
                throw new Error(`缺少资产类型: ${name}`);
            response.type(contentType).send(this.service.readAsset(name));
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    getAsset(name, response) {
        if (!(name in ASSET_CONTENT_TYPES)) {
            throw new common_1.BadRequestException("未知安装资产");
        }
        try {
            const contentType = ASSET_CONTENT_TYPES[name];
            if (!contentType)
                throw new Error(`缺少资产类型: ${name}`);
            response
                .type(contentType)
                .send(this.service.readAsset(name));
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    preflight(rawPlatform) {
        try {
            return this.service.preflight(parsePlatform(rawPlatform));
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    bootstrap(raw) {
        try {
            if (!isRecord(raw) || Object.keys(raw).length !== 1) {
                throw new Error("body 必须且只能包含 platform");
            }
            return this.service.bootstrap(parsePlatform(raw.platform));
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    getClientStatus(clientId, _forbiddenQueryPsk, response) {
        try {
            if (_forbiddenQueryPsk !== undefined) {
                throw new Error("PSK 不得通过 query 传递");
            }
            this.service.assertPsk(response.req.header("x-vcpdeck-psk"));
            return this.service.getClientStatus(clientId);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    renameClient(clientId, raw, response) {
        try {
            this.service.assertPsk(response.req.header("x-vcpdeck-psk"));
            const { name } = parseNameUpdate(raw);
            return this.service.renameClient(clientId, name);
        }
        catch (error) {
            throw this.toHttp(error);
        }
    }
    toHttp(error) {
        if (error instanceof common_1.HttpException)
            return error;
        if (error instanceof client_installer_service_js_1.ClientInstallerError) {
            return new common_1.HttpException({ code: error.code, message: error.message }, error.statusCode);
        }
        if (error instanceof Error) {
            return new common_1.BadRequestException({ code: "INVALID_REQUEST", message: error.message });
        }
        return new common_1.BadRequestException("请求无效");
    }
};
exports.ClientInstallerController = ClientInstallerController;
__decorate([
    (0, common_1.Get)("config"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ClientInstallerController.prototype, "getConfig", null);
__decorate([
    (0, common_1.Put)("config"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ClientInstallerController.prototype, "updateConfig", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("scripts/:platform"),
    (0, common_1.Header)("Cache-Control", "no-cache"),
    __param(0, (0, common_1.Param)("platform")),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientInstallerController.prototype, "getScript", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("assets/:name"),
    (0, common_1.Header)("Cache-Control", "no-cache"),
    __param(0, (0, common_1.Param)("name")),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", void 0)
], ClientInstallerController.prototype, "getAsset", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("preflight"),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Query)("platform")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ClientInstallerController.prototype, "preflight", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Post)("bootstrap"),
    (0, common_1.Header)("Cache-Control", "no-store, private"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientInstallerController.prototype, "bootstrap", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("clients/:clientId/status"),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Query)("psk")),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ClientInstallerController.prototype, "getClientStatus", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Put)("clients/:clientId/name"),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], ClientInstallerController.prototype, "renameClient", null);
exports.ClientInstallerController = ClientInstallerController = __decorate([
    (0, common_1.Controller)("api/client-installer"),
    __param(0, (0, common_1.Inject)(client_installer_service_js_1.ClientInstallerService)),
    __metadata("design:paramtypes", [client_installer_service_js_1.ClientInstallerService])
], ClientInstallerController);
