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
exports.TunnelController = void 0;
const common_1 = require("@nestjs/common");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const tunnel_config_service_js_1 = require("./tunnel-config.service.js");
const tunnel_session_service_js_1 = require("./tunnel-session.service.js");
/** P2P 隧道 REST 控制面：ICE 配置 + 临时 Session 创建/关闭。 */
let TunnelController = class TunnelController {
    config;
    sessions;
    constructor(config, sessions) {
        this.config = config;
        this.sessions = sessions;
    }
    getConfig() {
        return this.guarded(() => this.config.get());
    }
    updateConfig(raw) {
        return this.guarded(() => this.config.update(raw));
    }
    create(raw, actor) {
        return this.guarded(() => this.sessions.create(raw, actor));
    }
    close(sessionId, actor) {
        return this.guarded(() => this.sessions.close(sessionId, actor));
    }
    guarded(op) {
        return op().catch((error) => {
            throw this.toHttp(error);
        });
    }
    toHttp(error) {
        if (error instanceof common_1.HttpException)
            return error;
        if (error instanceof tunnel_config_service_js_1.TunnelConfigError || error instanceof tunnel_session_service_js_1.TunnelSessionError) {
            return new common_1.HttpException({ code: error.code, message: error.message }, error.statusCode);
        }
        if (error instanceof Error) {
            return new common_1.HttpException({ code: "TUNNEL_REQUEST_INVALID", message: error.message }, 400);
        }
        return new common_1.HttpException({ code: "TUNNEL_INTERNAL", message: "隧道操作失败" }, 500);
    }
};
exports.TunnelController = TunnelController;
__decorate([
    (0, common_1.Get)("config"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], TunnelController.prototype, "getConfig", null);
__decorate([
    (0, common_1.Put)("config"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TunnelController.prototype, "updateConfig", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.Header)("Cache-Control", "no-store"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], TunnelController.prototype, "create", null);
__decorate([
    (0, common_1.Delete)(":sessionId"),
    __param(0, (0, common_1.Param)("sessionId")),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], TunnelController.prototype, "close", null);
exports.TunnelController = TunnelController = __decorate([
    (0, common_1.Controller)("api/tunnels"),
    __param(0, (0, common_1.Inject)(tunnel_config_service_js_1.TunnelConfigService)),
    __param(1, (0, common_1.Inject)(tunnel_session_service_js_1.TunnelSessionService)),
    __metadata("design:paramtypes", [tunnel_config_service_js_1.TunnelConfigService, tunnel_session_service_js_1.TunnelSessionService])
], TunnelController);
