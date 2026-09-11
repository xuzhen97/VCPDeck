"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalRequestBroker = exports.TERMINAL_REQUEST_TIMEOUT_MS = void 0;
const common_1 = require("@nestjs/common");
exports.TERMINAL_REQUEST_TIMEOUT_MS = 15_000;
function terminalError(code, message) {
    return Object.assign(new Error(message), { code });
}
/**
 * 终端请求代理：把 REST/浏览器请求通过 Socket.IO 发到目标 Client，以 requestId 关联响应。
 * - 不记录 request payload 正文；
 * - socket 断线时只失败该连接的 pending；
 * - 只接受来自原 lease socket 的响应（防串线）；
 * - 未绑定 emitter 视为 Client 离线。
 */
let TerminalRequestBroker = class TerminalRequestBroker {
    emitter = null;
    pending = new Map();
    /** Gateway afterInit 时绑定 emitter（避免循环依赖）。 */
    bindEmitter(fn) {
        this.emitter = fn;
    }
    request(lease, request, timeoutMs = exports.TERMINAL_REQUEST_TIMEOUT_MS) {
        if (!this.emitter) {
            return Promise.reject(terminalError("TERMINAL_CLIENT_OFFLINE", "Client is offline"));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.requestId);
                reject(terminalError("TERMINAL_REQUEST_TIMEOUT", "Client did not respond in time"));
            }, timeoutMs);
            this.pending.set(request.requestId, { ...lease, resolve, reject, timer });
            this.emitter?.(lease.socketId, request);
        });
    }
    /** Client 响应：校验来源 socketId 后 resolve（响应正文校验由上层负责）。 */
    resolve(socketId, response) {
        const pending = this.pending.get(response.requestId);
        if (!pending)
            return; // 未知/重复响应忽略
        if (pending.socketId !== socketId)
            return; // 旧连接或伪造响应拒绝
        clearTimeout(pending.timer);
        this.pending.delete(response.requestId);
        pending.resolve(response);
    }
    /** socket 断线：只失败该连接的 pending request。 */
    disconnect(socketId) {
        for (const [requestId, pending] of this.pending) {
            if (pending.socketId === socketId) {
                clearTimeout(pending.timer);
                this.pending.delete(requestId);
                pending.reject(terminalError("TERMINAL_CLIENT_OFFLINE", "Client disconnected"));
            }
        }
    }
};
exports.TerminalRequestBroker = TerminalRequestBroker;
exports.TerminalRequestBroker = TerminalRequestBroker = __decorate([
    (0, common_1.Injectable)()
], TerminalRequestBroker);
