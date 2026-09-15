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
exports.TunnelSessionService = exports.TunnelSessionError = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const tunnel_config_service_js_1 = require("./tunnel-config.service.js");
const SWEEP_INTERVAL_MS = 5_000;
/** 隧道 Session 领域错误；code 稳定，statusCode 映射 HTTP。 */
class TunnelSessionError extends Error {
    code;
    statusCode;
    constructor(code, message, statusCode) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}
exports.TunnelSessionError = TunnelSessionError;
/**
 * 管理活动 P2P 隧道 Session：创建、绑定、信令转发与幂等清理。
 * 全部只存内存；SDP/candidate/HTTP 正文不落日志。
 */
let TunnelSessionService = class TunnelSessionService {
    config;
    prisma;
    sessions = new Map();
    timer = null;
    sendClient = () => { };
    sendBrowser = () => { };
    constructor(config, prisma) {
        this.config = config;
        this.prisma = prisma;
    }
    onModuleInit() {
        this.timer = setInterval(() => {
            void this.sweep();
        }, SWEEP_INTERVAL_MS);
    }
    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /** 由 ClientGateway 绑定 /client 精确 socket emitter。 */
    bindClientSender(fn) {
        this.sendClient = fn;
    }
    /** 由 AppGateway 绑定 /app 精确 socket emitter。 */
    bindBrowserSender(fn) {
        this.sendBrowser = fn;
    }
    has(sessionId) {
        return this.sessions.has(sessionId);
    }
    /** 创建临时 Session：校验 Client 在线 + p2pTunnel 能力，并签发短期凭据。 */
    async create(raw, actor) {
        const req = (0, shared_1.parseTunnelSessionCreateRequest)(raw);
        const client = await this.prisma.client.findUnique({ where: { id: req.clientId } });
        if (!client || client.online !== true || typeof client.socketId !== "string") {
            throw new TunnelSessionError("TUNNEL_CLIENT_UNAVAILABLE", "目标 Client 离线", 409);
        }
        const p2p = this.readP2pCapability(client.capabilityDetails);
        if (!p2p || p2p.available !== true || p2p.protocolVersion !== shared_1.P2P_TUNNEL_PROTOCOL_VERSION) {
            throw new TunnelSessionError("TUNNEL_CLIENT_UNSUPPORTED", "目标 Client 不支持 P2P 隧道", 409);
        }
        const now = Date.now();
        const id = `tn_${(0, node_crypto_1.randomUUID)()}`;
        const iceServers = await this.config.issueIceServers(id, new Date(now));
        const session = {
            id,
            actorIdentityId: actor.identityId,
            clientId: req.clientId,
            clientSocketId: client.socketId,
            browserSocketId: null,
            targetPort: req.targetPort,
            iceServers,
            attachExpiresAt: now + shared_1.TunnelLimits.attachTimeoutMs,
            expiresAt: now + shared_1.TunnelLimits.sessionTtlMs,
        };
        this.sessions.set(id, session);
        return {
            sessionId: id,
            clientId: req.clientId,
            targetPort: req.targetPort,
            attachDeadline: new Date(session.attachExpiresAt).toISOString(),
            iceServers,
        };
    }
    /** 绑定 Browser socket 到 Session，并向目标 Client lease 下发 prepare。 */
    async attachBrowser(sessionId, actor, browserSocketId) {
        const session = this.requireOwned(sessionId, actor.identityId);
        if (Date.now() > session.attachExpiresAt) {
            this.release(session.id, "attach expired");
            throw new TunnelSessionError("TUNNEL_SESSION_EXPIRED", "隧道 attach 已超时", 410);
        }
        if (session.browserSocketId !== null) {
            if (session.browserSocketId !== browserSocketId) {
                throw new TunnelSessionError("TUNNEL_FORBIDDEN", "隧道已被其他 Browser 绑定", 403);
            }
            return; // 同一 browser 幂等重连
        }
        session.browserSocketId = browserSocketId;
        this.sendClient(session.clientSocketId, shared_1.Events.TUNNEL_PREPARE, {
            sessionId: session.id,
            clientId: session.clientId,
            targetPort: session.targetPort,
            iceServers: session.iceServers,
        });
    }
    /** 转发 Browser 信令（offer/candidate）到目标 Client lease。 */
    async signalFromBrowser(browserSocketId, raw) {
        const parsed = this.parseBrowserSignal(raw);
        const session = this.sessions.get(parsed.sessionId);
        if (!session)
            throw new TunnelSessionError("TUNNEL_SESSION_NOT_FOUND", "隧道不存在", 404);
        if (session.browserSocketId !== browserSocketId) {
            throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Browser", 403);
        }
        this.sendClient(session.clientSocketId, shared_1.Events.TUNNEL_SIGNAL, parsed);
    }
    /** 转发 Client 信令（answer/candidate）到已绑定 Browser。 */
    async signalFromClient(clientSocketId, raw) {
        const parsed = this.parseClientSignal(raw);
        const session = this.sessions.get(parsed.sessionId);
        if (!session || session.clientSocketId !== clientSocketId) {
            throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Client", 403);
        }
        if (session.browserSocketId) {
            this.sendBrowser(session.browserSocketId, shared_1.Events.TUNNEL_SIGNAL, parsed);
        }
    }
    /** Client 上报数据面状态；failed/closed 时先通知 Browser 再释放。 */
    async clientState(clientSocketId, raw) {
        let parsed;
        try {
            parsed = (0, shared_1.parseTunnelClientState)(raw);
        }
        catch {
            throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "状态非法", 400);
        }
        const session = this.sessions.get(parsed.sessionId);
        if (!session || session.clientSocketId !== clientSocketId) {
            throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Client", 403);
        }
        if (parsed.state === "failed" || parsed.state === "closed") {
            if (session.browserSocketId) {
                this.sendBrowser(session.browserSocketId, shared_1.Events.TUNNEL_STATE, {
                    sessionId: session.id,
                    state: parsed.state,
                    code: parsed.code,
                });
            }
            this.release(session.id, `client ${parsed.state}`);
        }
    }
    /** 创建者显式关闭（幂等）。 */
    async close(sessionId, actor) {
        const session = this.sessions.get(sessionId);
        if (session && session.actorIdentityId !== actor.identityId) {
            throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非创建者", 403);
        }
        this.release(sessionId, "closed");
        return { closed: true };
    }
    /** Client 侧显式关闭（校验 lease 后幂等释放）。 */
    async closeFromClient(clientId, clientSocketId, sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        if (session.clientId !== clientId || session.clientSocketId !== clientSocketId)
            return;
        this.release(session.id, "closed");
    }
    /** Browser socket 断开：只清理绑定该 socket 的 Session。 */
    disconnectBrowser(browserSocketId) {
        for (const [id, session] of this.sessions) {
            if (session.browserSocketId === browserSocketId)
                this.release(id, "browser disconnect");
        }
    }
    /** Client socket 断开：只清理匹配 lease 的 Session。 */
    disconnectClient(clientId, clientSocketId) {
        for (const [id, session] of this.sessions) {
            if (session.clientId === clientId && session.clientSocketId === clientSocketId) {
                this.release(id, "client disconnect");
            }
        }
    }
    // ── 内部 ──
    sweep() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (session.browserSocketId === null && now >= session.attachExpiresAt) {
                this.release(id, "attach expired");
            }
            else if (session.browserSocketId !== null && now > session.expiresAt) {
                this.release(id, "expired");
            }
        }
    }
    release(id, _reason) {
        const session = this.sessions.get(id);
        if (!session)
            return; // 幂等
        if (session.browserSocketId)
            this.sendBrowser(session.browserSocketId, shared_1.Events.TUNNEL_CLOSE, { sessionId: id });
        this.sendClient(session.clientSocketId, shared_1.Events.TUNNEL_CLOSE, { sessionId: id });
        this.sessions.delete(id);
    }
    requireOwned(sessionId, identityId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new TunnelSessionError("TUNNEL_SESSION_NOT_FOUND", "隧道不存在", 404);
        if (session.actorIdentityId !== identityId) {
            throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非创建者", 403);
        }
        return session;
    }
    parseBrowserSignal(raw) {
        try {
            return (0, shared_1.parseTunnelBrowserSignal)(raw);
        }
        catch {
            throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "信令非法", 400);
        }
    }
    parseClientSignal(raw) {
        try {
            return (0, shared_1.parseTunnelClientSignal)(raw);
        }
        catch {
            throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "信令非法", 400);
        }
    }
    /** 从持久化 capabilityDetails 严格读取 p2pTunnel 摘要；损坏/缺失返回 null。 */
    readP2pCapability(json) {
        if (!json)
            return null;
        let details;
        try {
            details = JSON.parse(json);
        }
        catch {
            return null;
        }
        if (!details || typeof details !== "object")
            return null;
        const raw = details.p2pTunnel;
        if (raw === undefined || raw === null)
            return null;
        try {
            return (0, shared_1.parseP2pTunnelCapabilityStatus)(raw);
        }
        catch {
            return null;
        }
    }
};
exports.TunnelSessionService = TunnelSessionService;
exports.TunnelSessionService = TunnelSessionService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(tunnel_config_service_js_1.TunnelConfigService)),
    __param(1, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [tunnel_config_service_js_1.TunnelConfigService, prisma_service_js_1.PrismaService])
], TunnelSessionService);
