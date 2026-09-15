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
exports.AppGateway = void 0;
const common_1 = require("@nestjs/common");
const websockets_1 = require("@nestjs/websockets");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const terminal_service_js_1 = require("../terminal/terminal.service.js");
const tunnel_session_service_js_1 = require("../tunnel/tunnel-session.service.js");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const shared_2 = require("@vcpdeck/shared");
const FRONTEND_ORIGIN = process.env.VCPDECK_FRONTEND_ORIGIN || "http://localhost:5173";
function sha256(s) {
    return (0, node_crypto_1.createHash)("sha256").update(s).digest("hex");
}
function isTerminalErrorCode(v) {
    return typeof v === "string" && shared_2.TERMINAL_ERROR_CODES.includes(v);
}
/** 把业务错误转成安全 ack。 */
function errorAck(error) {
    const code = isTerminalErrorCode(error.code)
        ? error.code
        : "TERMINAL_PROTOCOL_INVALID";
    return {
        ok: false,
        error: { code, message: (0, shared_2.safeTerminalErrorMessage)(error.message) },
    };
}
/** 从 socket 读取已认证 actor。 */
function actorOf(client) {
    return client.actor;
}
let AppGateway = class AppGateway {
    prisma;
    terminalService;
    tunnelSessions;
    server;
    constructor(prisma, terminalService, 
    // 可选注入：旧两参构造的测试保持兼容
    tunnelSessions) {
        this.prisma = prisma;
        this.terminalService = terminalService;
        this.tunnelSessions = tunnelSessions;
    }
    afterInit() {
        this.terminalService.bindBrowserEmitter((socketId, event, payload) => {
            this.server.to(socketId).emit(event, payload);
        });
        this.tunnelSessions?.bindBrowserSender((socketId, event, payload) => {
            this.server.to(socketId).emit(event, payload);
        });
    }
    async handleConnection(client) {
        try {
            const actor = await this.authenticate(client);
            if (!actor) {
                client.emit("error", "Authentication required");
                client.disconnect();
                return;
            }
            client.actor = actor;
            console.log(`[ws:app] connected: ${actor.displayName} (${actor.source})`);
        }
        catch {
            client.emit("error", "Authentication failed");
            client.disconnect();
        }
    }
    async handleDisconnect(client) {
        await this.terminalService.detachBrowserSocket(client.id);
        this.tunnelSessions?.disconnectBrowser(client.id);
    }
    async authenticate(client) {
        // 1. Cookie session
        const rawCookie = client.handshake.headers.cookie;
        if (rawCookie) {
            const match = rawCookie.match(/vcpdeck_session=([^;]+)/);
            if (match) {
                const hash = sha256(match[1]);
                const session = await this.prisma.authSession.findUnique({ where: { sessionHash: hash } });
                if (session && !session.revokedAt && session.expiresAt > new Date()) {
                    const identity = await this.prisma.identity.findUnique({ where: { id: session.identityId } });
                    if (identity && !identity.disabledAt) {
                        return {
                            identityId: identity.id,
                            displayName: identity.displayName,
                            isAdmin: identity.isAdmin,
                            credentialId: null,
                            sessionId: session.id,
                            source: "web",
                            requestId: client.id,
                        };
                    }
                }
            }
        }
        // 2. Bearer token (handshake auth)
        const token = client.handshake.auth?.token;
        if (token) {
            const hash = sha256(token);
            const cred = await this.prisma.credential.findUnique({ where: { tokenHash: hash } });
            if (cred && !cred.revokedAt && (!cred.expiresAt || cred.expiresAt > new Date())) {
                const identity = await this.prisma.identity.findUnique({ where: { id: cred.identityId } });
                if (identity && !identity.disabledAt) {
                    return {
                        identityId: identity.id,
                        displayName: identity.displayName,
                        isAdmin: identity.isAdmin,
                        credentialId: cred.id,
                        sessionId: null,
                        source: "cli",
                        requestId: client.id,
                    };
                }
            }
        }
        return null;
    }
    // ── 终端事件（身份来自 handleConnection 的 actor） ──
    async handleTerminalAttach(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserAttach)(data);
            const result = await this.terminalService.attachBrowser({
                sessionId: parsed.sessionId,
                actor: actorOf(client),
                socketId: client.id,
                reconnectToken: parsed.reconnectToken,
            });
            return {
                ok: true,
                data: {
                    sessionId: parsed.sessionId,
                    attachmentId: result.attachmentId,
                    reconnectToken: result.reconnectToken,
                    mode: result.mode,
                    controlProtectedUntil: result.controlProtectedUntil,
                },
            };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalDetach(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserDetach)(data);
            await this.terminalService.detachBrowser({ socketId: client.id, ...parsed });
            return { ok: true, data: undefined };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalInput(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserInput)(data);
            await this.terminalService.browserInput({ socketId: client.id, ...parsed });
            return { ok: true, data: undefined };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalResize(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserResize)(data);
            await this.terminalService.browserResize({ socketId: client.id, ...parsed });
            return { ok: true, data: undefined };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalTakeover(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserTakeover)(data);
            const result = await this.terminalService.browserTakeover({ socketId: client.id, ...parsed });
            return { ok: true, data: result };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalAckOutput(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserAckOutput)(data);
            await this.terminalService.browserAckOutput({ socketId: client.id, ...parsed });
            return { ok: true, data: undefined };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    async handleTerminalResync(client, data) {
        try {
            const parsed = (0, shared_2.parseTerminalBrowserResync)(data);
            await this.terminalService.browserResync({ socketId: client.id, ...parsed });
            return { ok: true, data: undefined };
        }
        catch (error) {
            return errorAck(error);
        }
    }
    // ── P2P 隧道信令（身份来自 handleConnection 的 actor） ──
    tunnelErrorAck(error) {
        const e = error;
        const code = typeof e.code === "string" ? e.code : "TUNNEL_PROTOCOL_INVALID";
        return { ok: false, error: { code, message: "隧道操作失败" } };
    }
    async handleTunnelAttach(client, data) {
        if (!this.tunnelSessions)
            return this.tunnelErrorAck({ code: "TUNNEL_UNAVAILABLE" });
        try {
            const parsed = (0, shared_2.parseTunnelBrowserAttach)(data);
            await this.tunnelSessions.attachBrowser(parsed.sessionId, actorOf(client), client.id);
            return { ok: true, data: undefined };
        }
        catch (error) {
            return this.tunnelErrorAck(error);
        }
    }
    async handleTunnelSignal(client, data) {
        if (!this.tunnelSessions)
            return this.tunnelErrorAck({ code: "TUNNEL_UNAVAILABLE" });
        try {
            await this.tunnelSessions.signalFromBrowser(client.id, data);
            return { ok: true, data: undefined };
        }
        catch (error) {
            return this.tunnelErrorAck(error);
        }
    }
    async handleTunnelClose(client, data) {
        if (!this.tunnelSessions)
            return this.tunnelErrorAck({ code: "TUNNEL_UNAVAILABLE" });
        try {
            const parsed = (0, shared_2.parseTunnelClose)(data);
            await this.tunnelSessions.close(parsed.sessionId, actorOf(client));
            return { ok: true, data: { closed: true } };
        }
        catch (error) {
            return this.tunnelErrorAck(error);
        }
    }
};
exports.AppGateway = AppGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", Function)
], AppGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_ATTACH),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalAttach", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_DETACH),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalDetach", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_INPUT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalInput", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_RESIZE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalResize", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_TAKEOVER),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalTakeover", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_ACK_OUTPUT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalAckOutput", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_RESYNC),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTerminalResync", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TUNNEL_ATTACH),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTunnelAttach", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TUNNEL_SIGNAL),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTunnelSignal", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TUNNEL_CLOSE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], AppGateway.prototype, "handleTunnelClose", null);
exports.AppGateway = AppGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({
        namespace: "/app",
        cors: { origin: FRONTEND_ORIGIN, credentials: true },
    }),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(terminal_service_js_1.TerminalService)),
    __param(2, (0, common_1.Optional)()),
    __param(2, (0, common_1.Inject)(tunnel_session_service_js_1.TunnelSessionService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, terminal_service_js_1.TerminalService, tunnel_session_service_js_1.TunnelSessionService])
], AppGateway);
