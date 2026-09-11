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
var TerminalService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalService = exports.TERMINAL_SESSION_END_STATUSES = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const node_crypto_2 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const terminal_request_broker_js_1 = require("./terminal-request-broker.js");
const terminal_audit_service_js_1 = require("./terminal-audit.service.js");
const terminal_records_js_1 = require("./terminal-records.js");
exports.TERMINAL_SESSION_END_STATUSES = [
    "exited",
    "interrupted",
    "expired",
    "closed",
    "error",
];
/** 列表保留已中断会话的时间窗口（设计 13.2：最近的已中断会话）。 */
const TERMINAL_SESSION_LIST_KEEP_MS = 24 * 60 * 60 * 1000;
function terminalError(code, message) {
    return Object.assign(new Error(message), { code });
}
function sha256(s) {
    return (0, node_crypto_2.createHash)("sha256").update(s).digest("hex");
}
/** 稳定终端错误。 */
/** 终端会话服务：元数据、单写多读、重连保护、输出同步与状态对账。 */
let TerminalService = TerminalService_1 = class TerminalService {
    runtimes = new Map();
    syncPromises = new Map();
    browserEmitter = null;
    createChains = new Map();
    now;
    hashToken;
    deps;
    /**
     * Nest 注入构造。测试请用 TerminalService.withDeps()。
     */
    constructor(prisma, broker, audit) {
        this.deps = { prisma, broker, audit };
        this.now = Date.now;
        this.hashToken = sha256;
    }
    /** 测试构造：注入 fake prisma/broker/audit。 */
    static withDeps(deps) {
        const service = new TerminalService_1(null, null, null);
        service.deps = deps;
        service.now = deps.now ?? Date.now;
        service.hashToken = deps.hashToken ?? sha256;
        return service;
    }
    /** AppGateway afterInit 时绑定浏览器事件发射器。 */
    bindBrowserEmitter(fn) {
        this.browserEmitter = fn;
    }
    emitBrowser(socketId, event, payload) {
        this.browserEmitter?.(socketId, event, payload);
    }
    runtime(sessionId) {
        return this.runtimes.get(sessionId);
    }
    ensureRuntime(sessionId, clientId) {
        let rt = this.runtimes.get(sessionId);
        if (!rt) {
            rt = {
                sessionId,
                clientId,
                attachments: new Map(),
                operatorAttachmentId: null,
                protectedUntil: null,
                protectedTokenHash: null,
                protectedIdentityId: null,
                lastSeq: 0,
                clientAttachPending: false,
                detachNotified: false,
            };
            this.runtimes.set(sessionId, rt);
        }
        return rt;
    }
    /** 串行化同一 Client 的创建/对账操作。 */
    withClientChain(clientId, task) {
        const prev = this.createChains.get(clientId) ?? Promise.resolve();
        const next = prev.then(task, task);
        this.createChains.set(clientId, next.catch(() => undefined));
        return next;
    }
    async clientSocketId(clientId) {
        const client = await this.deps.prisma.client.findUnique({
            where: { id: clientId },
            select: { socketId: true },
        });
        return client?.socketId ?? null;
    }
    async requireClientLease(clientId) {
        const socketId = await this.clientSocketId(clientId);
        if (!socketId)
            throw terminalError("TERMINAL_CLIENT_OFFLINE", "Client is offline");
        return { clientId, socketId };
    }
    async sendRequest(clientId, request) {
        const lease = await this.requireClientLease(clientId);
        return this.deps.broker.request(lease, request);
    }
    async recordAudit(sessionId, clientId, event, actor, result = "ok", reason) {
        try {
            await this.deps.audit.record({
                sessionId,
                clientId,
                event,
                identityId: actor?.identityId ?? null,
                actorName: actor?.displayName ?? null,
                source: actor?.source ?? null,
                result,
                reason,
            });
        }
        catch (error) {
            // 审计失败不阻断业务，但记录原因便于定位（不含输入输出等敏感内容）
            console.error(`[terminal-audit] record ${event} failed:`, error?.message);
        }
    }
    // ── REST：Shell ──
    /** 列出 Client 可用 Shell（安全 DTO）。 */
    async listShells(clientId) {
        const response = await this.sendRequest(clientId, { requestId: `ts_${(0, node_crypto_1.randomUUID)()}`, action: "shells.list" });
        if (!response.ok)
            throw terminalError(response.error.code, response.error.message);
        if (response.action !== "shells.list")
            throw terminalError("TERMINAL_PROTOCOL_INVALID", "Unexpected response");
        return response.shells;
    }
    // ── REST：Session ──
    /** 会话列表：非终态 + 最近 24h 内已中断的会话（设计 13.2：默认返回非终态会话和最近的已中断会话）。 */
    async listSessions(clientId, page = 1, pageSize = 20) {
        // closed/exited/expired/error 是用户可见操作的结果，不堆积；interrupted（客户端重启）保留 24h 供查看
        const recentInterruptedAt = new Date(this.now() - TERMINAL_SESSION_LIST_KEEP_MS);
        const where = {
            clientId,
            OR: [
                { status: { notIn: [...exports.TERMINAL_SESSION_END_STATUSES] } },
                { status: "interrupted", endedAt: { gte: recentInterruptedAt } },
            ],
        };
        const [list, total] = await Promise.all([
            this.deps.prisma.terminalSession.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.deps.prisma.terminalSession.count({ where }),
        ]);
        return {
            data: list.map((r) => (0, terminal_records_js_1.toTerminalSessionInfo)(r)),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    /** 会话详情（仅限本 Client 范围）。 */
    async getSession(clientId, sessionId) {
        const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
        if (!row || row.clientId !== clientId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        return (0, terminal_records_js_1.toTerminalSessionInfo)(row);
    }
    /** 创建会话（Server 生成 sessionId；串行化 5 会话限制）。 */
    async createSession(clientId, request, actor) {
        return this.withClientChain(clientId, async () => {
            const lease = await this.requireClientLease(clientId);
            const active = await this.deps.prisma.terminalSession.count({
                where: { clientId, status: { notIn: [...exports.TERMINAL_SESSION_END_STATUSES] } },
            });
            if (active >= shared_1.TerminalLimits.maxSessionsPerClient) {
                throw terminalError("TERMINAL_SESSION_LIMIT_REACHED", "Terminal session limit reached");
            }
            const sessionId = `ts_${(0, node_crypto_1.randomUUID)()}`;
            await this.deps.prisma.terminalSession.create({
                data: {
                    id: sessionId,
                    clientId,
                    shellId: request.shellId,
                    shellLabel: request.shellId,
                    status: "starting",
                    cols: request.cols,
                    rows: request.rows,
                    createdByIdentityId: actor.identityId,
                    createdByName: actor.displayName,
                },
            });
            // 先建 runtime：Client 可能立即输出（提示符等），浏览器 attach 前不能丢块
            this.ensureRuntime(sessionId, clientId);
            await this.recordAudit(sessionId, clientId, "created", actor);
            const response = await this.deps.broker.request(lease, {
                requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
                action: "session.create",
                sessionId,
                shellId: request.shellId,
                cols: request.cols,
                rows: request.rows,
            });
            if (!response.ok) {
                await this.deps.prisma.terminalSession.update({
                    where: { id: sessionId },
                    data: { status: "error", errorCode: response.error.code, endedAt: new Date(this.now()) },
                });
                await this.recordAudit(sessionId, clientId, "create_failed", actor, "error", response.error.code);
                throw terminalError(response.error.code, response.error.message);
            }
            const updated = await this.deps.prisma.terminalSession.update({
                where: { id: sessionId },
                data: { status: "detached", shellLabel: request.shellId },
            });
            return (0, terminal_records_js_1.toTerminalSessionInfo)(updated);
        });
    }
    /** 关闭会话（幂等；终态不改写首次原因）。 */
    async closeSession(clientId, sessionId, actor) {
        const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
        if (!row || row.clientId !== clientId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        if (exports.TERMINAL_SESSION_END_STATUSES.includes(row.status)) {
            return (0, terminal_records_js_1.toTerminalSessionInfo)(row);
        }
        // Client 在线：远端确认后标记 closed
        const response = await this.sendRequest(clientId, {
            requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
            action: "session.close",
            sessionId,
            reason: "closed",
        });
        if (!response.ok)
            throw terminalError(response.error.code, response.error.message);
        const updated = await this.deps.prisma.terminalSession.update({
            where: { id: sessionId },
            data: { status: "closed", endedAt: new Date(this.now()), endReason: "TERMINAL_CLOSE_REQUESTED" },
        });
        this.runtimes.delete(sessionId);
        await this.recordAudit(sessionId, clientId, "closed", actor);
        return (0, terminal_records_js_1.toTerminalSessionInfo)(updated);
    }
    // ── 浏览器 attach/detach ──
    /** 浏览器 attach：首个为 operator；token 匹配时恢复操作权。 */
    async attachBrowser(args) {
        const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: args.sessionId } });
        if (!row) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        // clientId 校验：浏览器可不传（sessionId 即能力凭证），传了就必须匹配
        if (args.clientId !== undefined && row.clientId !== args.clientId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        const clientId = row.clientId;
        if (exports.TERMINAL_SESSION_END_STATUSES.includes(row.status)) {
            throw terminalError("TERMINAL_SESSION_ENDED", "Session has ended");
        }
        const rt = this.ensureRuntime(args.sessionId, clientId);
        // 同一 socket 重复 attach（StrictMode 双挂载/页面内重挂）：旧 attachment 已失效，直接取代。
        // socket 仍在线，不触发重连保护，否则新 attach 会被保护期挡成 viewer 且无法写。
        for (const [oldId, old] of [...rt.attachments]) {
            if (old.socketId !== args.socketId)
                continue;
            rt.attachments.delete(oldId);
            if (rt.operatorAttachmentId === oldId) {
                rt.operatorAttachmentId = null;
                rt.protectedUntil = null;
                rt.protectedTokenHash = null;
                rt.protectedIdentityId = null;
            }
        }
        // token 重绑：断开 operator 的保护记录匹配时恢复操作权
        if (args.reconnectToken) {
            const hash = this.hashToken(args.reconnectToken);
            if (rt.operatorAttachmentId === null &&
                rt.protectedTokenHash !== null &&
                rt.protectedTokenHash === hash &&
                rt.protectedIdentityId === args.actor.identityId &&
                this.now() < (rt.protectedUntil ?? 0)) {
                const attachmentId = `ta_${(0, node_crypto_1.randomUUID)()}`;
                const attachment = {
                    attachmentId,
                    socketId: args.socketId,
                    identityId: args.actor.identityId,
                    actorName: args.actor.displayName,
                    reconnectTokenHash: hash,
                    mode: "operator",
                    state: "syncing",
                    attachedAt: this.now(),
                    lastAckSeq: 0,
                    snapshotSeq: 0,
                    backlog: [],
                    backlogBytes: 0,
                };
                rt.attachments.set(attachmentId, attachment);
                rt.operatorAttachmentId = attachmentId;
                rt.protectedUntil = null;
                rt.protectedTokenHash = null;
                rt.protectedIdentityId = null;
                await this.recordAudit(args.sessionId, clientId, "attached", args.actor);
                this.trackSync(rt, attachment);
                return {
                    attachmentId,
                    reconnectToken: args.reconnectToken,
                    mode: "operator",
                    controlProtectedUntil: null,
                };
            }
        }
        // 新 attachment：保护期内新连接只能成为 viewer
        const attachmentId = `ta_${(0, node_crypto_1.randomUUID)()}`;
        const token = `tok_${(0, node_crypto_1.randomUUID)()}`;
        const isOperator = rt.operatorAttachmentId === null && this.now() >= (rt.protectedUntil ?? 0);
        const attachment = {
            attachmentId,
            socketId: args.socketId,
            identityId: args.actor.identityId,
            actorName: args.actor.displayName,
            reconnectTokenHash: this.hashToken(token),
            mode: isOperator ? "operator" : "viewer",
            state: "syncing",
            attachedAt: this.now(),
            lastAckSeq: 0,
            snapshotSeq: 0,
            backlog: [],
            backlogBytes: 0,
        };
        rt.attachments.set(attachmentId, attachment);
        if (isOperator) {
            rt.operatorAttachmentId = attachmentId;
            rt.protectedUntil = null;
        }
        await this.recordAudit(args.sessionId, clientId, "attached", args.actor);
        this.trackSync(rt, attachment);
        return {
            attachmentId,
            reconnectToken: token,
            mode: attachment.mode,
            controlProtectedUntil: rt.protectedUntil ? new Date(rt.protectedUntil).toISOString() : null,
        };
    }
    /** attach 同步完成 promise（测试与内部追踪用）。 */
    whenAttachSettled(sessionId) {
        return this.syncPromises.get(sessionId) ?? Promise.resolve();
    }
    trackSync(rt, attachment) {
        const p = this.syncAttachment(rt, attachment);
        this.syncPromises.set(rt.sessionId, p.catch(() => undefined));
    }
    /** attach 同步：请求 Client snapshot，随后按 seq 发送增量。 */
    async syncAttachment(rt, attachment) {
        try {
            const response = await this.sendRequest(rt.clientId, {
                requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
                action: "session.attach",
                sessionId: rt.sessionId,
            });
            if (!response.ok) {
                this.emitBrowser(attachment.socketId, "terminal:error", {
                    sessionId: rt.sessionId,
                    code: response.error.code,
                    message: response.error.message,
                });
                return;
            }
            if (response.action !== "session.attach")
                return;
            attachment.snapshotSeq = response.snapshotSeq;
            // 快照即权威基线：同步 rt.lastSeq，避免早期块缺失造成永久 gap（后续块被丢弃）
            rt.lastSeq = Math.max(rt.lastSeq, response.snapshotSeq);
            this.emitBrowser(attachment.socketId, "terminal:snapshot", {
                sessionId: rt.sessionId,
                snapshot: response.snapshot,
                snapshotSeq: response.snapshotSeq,
                cols: response.cols,
                rows: response.rows,
                historyTruncated: response.historyTruncated,
            });
            // 增量：seq > snapshotSeq 的暂存块
            const backlog = attachment.backlog.filter((c) => c.seq > response.snapshotSeq);
            attachment.backlog = [];
            attachment.backlogBytes = 0;
            attachment.state = "live";
            attachment.lastAckSeq = response.snapshotSeq;
            for (const chunk of backlog) {
                this.emitBrowser(attachment.socketId, "terminal:output", chunk);
                attachment.lastAckSeq = chunk.seq;
            }
            this.broadcastControl(rt);
        }
        catch (error) {
            const code = error.code;
            this.emitBrowser(attachment.socketId, "terminal:error", {
                sessionId: rt.sessionId,
                code: typeof code === "string" ? code : "TERMINAL_CLIENT_OFFLINE",
                message: "Terminal session is not available",
            });
        }
    }
    /** 浏览器 socket 断开：清理其全部 attachment。 */
    async detachBrowserSocket(socketId) {
        for (const rt of this.runtimes.values()) {
            let changed = false;
            for (const [attachmentId, attachment] of rt.attachments) {
                if (attachment.socketId !== socketId)
                    continue;
                await this.removeAttachment(rt, attachmentId, attachment);
                changed = true;
            }
            if (!changed)
                continue;
            this.afterAttachmentRemoved(rt);
        }
    }
    /** 浏览器显式 detach（单会话）。 */
    async detachBrowser(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId)
            return;
        await this.removeAttachment(rt, args.attachmentId, attachment);
        this.afterAttachmentRemoved(rt);
    }
    async removeAttachment(rt, attachmentId, attachment) {
        rt.attachments.delete(attachmentId);
        if (rt.operatorAttachmentId === attachmentId) {
            // 30 秒重连保护（记住断开 operator 的凭证）
            rt.operatorAttachmentId = null;
            rt.protectedUntil = this.now() + shared_1.TerminalLimits.reconnectGraceMs;
            rt.protectedTokenHash = attachment.reconnectTokenHash;
            rt.protectedIdentityId = attachment.identityId;
        }
        await this.recordAudit(rt.sessionId, rt.clientId, "detached", {
            identityId: attachment.identityId,
            displayName: attachment.actorName,
            source: "web",
        });
    }
    afterAttachmentRemoved(rt) {
        if (rt.attachments.size === 0) {
            // 最后离开：通知 Client 进入 detached（幂等一次）
            if (!rt.detachNotified) {
                rt.detachNotified = true;
                void this.sendRequest(rt.clientId, {
                    requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
                    action: "session.detach",
                    sessionId: rt.sessionId,
                }).catch(() => undefined);
            }
        }
        else {
            this.broadcastControl(rt);
        }
    }
    broadcastControl(rt) {
        const operator = rt.operatorAttachmentId ? rt.attachments.get(rt.operatorAttachmentId) : null;
        for (const attachment of rt.attachments.values()) {
            this.emitBrowser(attachment.socketId, "terminal:control", {
                sessionId: rt.sessionId,
                mode: attachment.mode,
                operatorName: operator?.actorName ?? null,
                controlProtectedUntil: rt.protectedUntil ? new Date(rt.protectedUntil).toISOString() : null,
                canTakeover: rt.operatorAttachmentId === null && this.now() >= (rt.protectedUntil ?? 0),
            });
        }
    }
    // ── 浏览器写入（最终权限检查） ──
    /** 输入：仅 operator。 */
    async browserInput(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        if (rt?.operatorAttachmentId !== attachment.attachmentId) {
            throw terminalError("TERMINAL_READ_ONLY", "Session is read-only");
        }
        await this.sendRequest(rt.clientId, {
            requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
            action: "session.input",
            sessionId: args.sessionId,
            data: args.data,
        });
    }
    /** resize：仅 operator。 */
    async browserResize(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        if (rt?.operatorAttachmentId !== attachment.attachmentId) {
            throw terminalError("TERMINAL_READ_ONLY", "Session is read-only");
        }
        await this.sendRequest(rt.clientId, {
            requestId: `ts_${(0, node_crypto_1.randomUUID)()}`,
            action: "session.resize",
            sessionId: args.sessionId,
            cols: args.cols,
            rows: args.rows,
        });
    }
    /** 接管：保护期结束后原子生效。 */
    async browserTakeover(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        if (rt?.operatorAttachmentId !== null) {
            throw terminalError("TERMINAL_CONTROL_CONFLICT", "Another operator holds control");
        }
        if (this.now() < (rt?.protectedUntil ?? 0)) {
            throw terminalError("TERMINAL_CONTROL_PROTECTED", "Operator reconnect is protected");
        }
        rt.operatorAttachmentId = attachment.attachmentId;
        attachment.mode = "operator";
        rt.protectedUntil = null;
        rt.protectedTokenHash = null;
        rt.protectedIdentityId = null;
        this.broadcastControl(rt);
        await this.recordAudit(args.sessionId, rt.clientId, "takeover", {
            identityId: attachment.identityId,
            displayName: attachment.actorName,
            source: "web",
        });
        return { mode: "operator" };
    }
    /** 输出 ack（慢消费者跟踪）。 */
    async browserAckOutput(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId)
            return;
        if (args.seq > attachment.lastAckSeq)
            attachment.lastAckSeq = args.seq;
    }
    /** resync：重新获取 snapshot。 */
    async browserResync(args) {
        const rt = this.runtime(args.sessionId);
        const attachment = rt?.attachments.get(args.attachmentId);
        if (!attachment || attachment.socketId !== args.socketId) {
            throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
        }
        attachment.state = "syncing";
        this.trackSync(rt, attachment);
    }
    // ── Client 事件 ──
    async handleClientResponse(_clientId, _socketId, response) {
        // 响应由 broker 关联；此处仅校验 clientId 归属（防御性）
        if (!response.ok)
            return;
    }
    /** Client 输出：按序转发到 live attachment；syncing 期间进入 backlog。 */
    async handleClientOutput(clientId, chunk) {
        let rt = this.runtime(chunk.sessionId);
        if (!rt) {
            // 会话创建后/服务重启后对账前：输出不应丢弃（快照基线靠 rt.lastSeq 对齐）
            rt = this.ensureRuntime(chunk.sessionId, clientId);
        }
        if (rt.clientId !== clientId)
            return;
        if (chunk.seq <= rt.lastSeq)
            return; // 重复
        if (chunk.seq > rt.lastSeq + 1) {
            // gap：跳过（前端将发起 resync）
            return;
        }
        rt.lastSeq = chunk.seq;
        for (const attachment of rt.attachments.values()) {
            if (attachment.state === "syncing") {
                attachment.backlog.push(chunk);
                attachment.backlogBytes += chunk.data.length;
                if (attachment.backlogBytes > shared_1.TerminalLimits.syncBacklogBytes) {
                    // backlog 超限：触发重同步
                    attachment.backlog = [];
                    attachment.backlogBytes = 0;
                    this.emitBrowser(attachment.socketId, "terminal:resync-required", { sessionId: rt.sessionId });
                    attachment.state = "live"; // 等待前端 resync
                }
            }
            else if (attachment.state === "live") {
                // 慢消费者：ack 落后超过阈值 → 暂停增量并请求 resync（不影响其他 attachment）
                if (chunk.seq - attachment.lastAckSeq > shared_1.TerminalLimits.slowConsumerGapBlocks) {
                    this.emitBrowser(attachment.socketId, "terminal:resync-required", { sessionId: rt.sessionId });
                    attachment.state = "syncing";
                    continue;
                }
                this.emitBrowser(attachment.socketId, "terminal:output", chunk);
            }
        }
    }
    /** Shell 自行退出。 */
    async handleClientExit(clientId, exit) {
        const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: exit.sessionId } });
        if (!row || row.clientId !== clientId)
            return;
        if (exports.TERMINAL_SESSION_END_STATUSES.includes(row.status))
            return;
        await this.deps.prisma.terminalSession.update({
            where: { id: exit.sessionId },
            data: { status: "exited", endedAt: new Date(this.now()), endReason: `exit:${exit.exitCode}` },
        });
        const rt = this.runtimes.get(exit.sessionId);
        if (rt) {
            for (const attachment of rt.attachments.values()) {
                this.emitBrowser(attachment.socketId, "terminal:session-state", {
                    sessionId: exit.sessionId,
                    status: "exited",
                    reason: `exit:${exit.exitCode}`,
                });
            }
            this.runtimes.delete(exit.sessionId);
        }
        await this.recordAudit(exit.sessionId, clientId, "exited", null);
    }
    /** 状态对账：接受存活、标记 interrupted、返回孤儿 close。 */
    async handleClientState(clientId, socketId, report) {
        return this.withClientChain(clientId, async () => {
            const reported = new Map(report.sessions.map((s) => [s.sessionId, s]));
            const dbSessions = await this.deps.prisma.terminalSession.findMany({
                where: { clientId, status: { notIn: [...exports.TERMINAL_SESSION_END_STATUSES] } },
            });
            const acceptedSessionIds = [];
            const closeSessionIds = [];
            for (const row of dbSessions) {
                const id = row.id;
                if (reported.has(id)) {
                    acceptedSessionIds.push(id);
                    const rt = this.ensureRuntime(id, clientId);
                    rt.lastSeq = Math.max(rt.lastSeq, reported.get(id)?.lastSeq ?? 0);
                    // 恢复为 detached（Client 侧状态为准）
                    if (rt.attachments.size === 0) {
                        rt.detachNotified = true;
                    }
                }
                else {
                    await this.deps.prisma.terminalSession.update({
                        where: { id },
                        data: { status: "interrupted", endedAt: new Date(this.now()), endReason: "TERMINAL_CLIENT_RESTARTED" },
                    });
                    await this.recordAudit(id, clientId, "interrupted", null, "error", "TERMINAL_CLIENT_RESTARTED");
                    this.runtimes.delete(id);
                }
            }
            for (const [sessionId] of reported) {
                const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
                if (!row || row.clientId !== clientId || exports.TERMINAL_SESSION_END_STATUSES.includes(row.status)) {
                    closeSessionIds.push(sessionId);
                }
            }
            void socketId;
            return { acceptedSessionIds, closeSessionIds };
        });
    }
    /** Client 断线：不终结会话（Client 侧 30 分钟保留计时兜底）。 */
    async handleClientDisconnect(_clientId, _socketId) {
        // 主动行为：Client 保留 PTY；Server 侧 attachment 不受影响
    }
    /** Client REGISTER 成功：绑定 socket（对账由 Client 上报状态触发）。 */
    async handleClientRegistered(_clientId, _socketId) {
        // 状态对账在 Client 上报 TERMINAL_STATE 时执行
    }
};
exports.TerminalService = TerminalService;
exports.TerminalService = TerminalService = TerminalService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(terminal_request_broker_js_1.TerminalRequestBroker)),
    __param(2, (0, common_1.Inject)(terminal_audit_service_js_1.TerminalAuditService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, terminal_request_broker_js_1.TerminalRequestBroker, terminal_audit_service_js_1.TerminalAuditService])
], TerminalService);
