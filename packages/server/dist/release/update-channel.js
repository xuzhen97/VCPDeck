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
exports.GatewayUpdateChannel = void 0;
/**
 * ClientUpdateChannel 网关实现。
 *
 * 与 PiRequestBroker 同模式：不直接依赖 ClientGateway（避免 ReleaseModule ↔
 * EventsModule provider 循环），由 ClientGateway.afterInit 将发送函数绑定进来。
 * Client 更新指令经 room（clientId）下发；详见 docs/design/release-and-update.md。
 */
const common_1 = require("@nestjs/common");
const client_service_js_1 = require("../client/client.service.js");
let GatewayUpdateChannel = class GatewayUpdateChannel {
    clients;
    emitters = null;
    constructor(clients) {
        this.clients = clients;
    }
    /** 由 ClientGateway.afterInit 调用，绑定真实发送通道 */
    bindEmitters(emitters) {
        this.emitters = emitters;
    }
    async listOnlineClients() {
        const online = await this.clients.listOnline();
        return online.map((c) => ({
            clientId: c.clientId,
            clientVersion: c.clientVersion,
            os: c.os,
        }));
    }
    sendUpdateRequest(clientId, req) {
        if (!this.emitters) {
            throw new Error("更新通道未绑定（gateway afterInit 尚未执行）");
        }
        this.emitters.sendUpdateRequest(clientId, req);
    }
    broadcastShutdown(notice) {
        if (!this.emitters) {
            throw new Error("更新通道未绑定（gateway afterInit 尚未执行）");
        }
        this.emitters.broadcastShutdown(notice);
    }
};
exports.GatewayUpdateChannel = GatewayUpdateChannel;
exports.GatewayUpdateChannel = GatewayUpdateChannel = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __metadata("design:paramtypes", [client_service_js_1.ClientService])
], GatewayUpdateChannel);
