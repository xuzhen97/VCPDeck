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
exports.ClientGateway = void 0;
const common_1 = require("@nestjs/common");
const websockets_1 = require("@nestjs/websockets");
const client_service_js_1 = require("../client/client.service.js");
const job_service_js_1 = require("../job/job.service.js");
const file_service_js_1 = require("../file/file.service.js");
const frp_service_js_1 = require("../frp/frp.service.js");
const frp_reconciliation_service_js_1 = require("../frp/frp-reconciliation.service.js");
const pi_request_broker_js_1 = require("../pi/pi-request-broker.js");
const pi_event_broker_js_1 = require("../pi/pi-event-broker.js");
const pi_run_service_js_1 = require("../pi/pi-run.service.js");
const terminal_service_js_1 = require("../terminal/terminal.service.js");
const terminal_request_broker_js_1 = require("../terminal/terminal-request-broker.js");
const release_orchestrator_js_1 = require("../release/release.orchestrator.js");
const update_channel_js_1 = require("../release/update-channel.js");
const shared_1 = require("@vcpdeck/shared");
const client_psk_js_1 = require("../client/client-psk.js");
const CLIENT_LIVENESS_SWEEP_INTERVAL_MS = 5_000;
let ClientGateway = class ClientGateway {
    clientService;
    jobService;
    fileService;
    frpService;
    piRequests;
    piEvents;
    piRuns;
    terminalService;
    terminalBroker;
    orchestrator;
    updateChannel;
    frpReconciliation;
    server;
    staleClientTimer = null;
    constructor(clientService, jobService, fileService, frpService, piRequests, piEvents, piRuns, terminalService, terminalBroker, 
    // 更新编排（forwardRef 解开 ReleaseModule ↔ EventsModule 循环）
    orchestrator, 
    // 更新事件发送通道（bindEmitters 模式，避免 provider 循环）
    updateChannel, 
    // FRP 恢复编排（可选注入：旧测试两参构造时跳过）
    frpReconciliation) {
        this.clientService = clientService;
        this.jobService = jobService;
        this.fileService = fileService;
        this.frpService = frpService;
        this.piRequests = piRequests;
        this.piEvents = piEvents;
        this.piRuns = piRuns;
        this.terminalService = terminalService;
        this.terminalBroker = terminalBroker;
        this.orchestrator = orchestrator;
        this.updateChannel = updateChannel;
        this.frpReconciliation = frpReconciliation;
    }
    onModuleInit() {
        this.staleClientTimer = setInterval(() => {
            void this.sweepStaleClients().catch((error) => {
                console.error("[client] heartbeat sweep failed:", error?.message);
            });
        }, CLIENT_LIVENESS_SWEEP_INTERVAL_MS);
    }
    onModuleDestroy() {
        if (this.staleClientTimer)
            clearInterval(this.staleClientTimer);
        this.staleClientTimer = null;
    }
    // ── Pi request 发送通道（避免与 PiModule 循环依赖） ──
    afterInit() {
        this.frpReconciliation?.bindDispatcher((socketId, dispatch) => this.sendReconcileDispatch(socketId, dispatch));
        this.piRequests.bindEmitter((socketId, request) => {
            this.server.to(socketId).emit(shared_1.Events.PI_REQUEST, request);
        });
        this.terminalBroker.bindEmitter((socketId, request) => {
            this.server.to(socketId).emit(shared_1.Events.TERMINAL_REQUEST, request);
        });
        this.updateChannel.bindEmitters({
            sendUpdateRequest: (clientId, request) => {
                this.server.to(clientId).emit(shared_1.Events.UPDATE_REQUEST, request);
            },
            broadcastShutdown: (notice) => {
                this.server.emit(shared_1.Events.SERVER_SHUTDOWN, notice);
            },
        });
    }
    // ── Connection lifecycle ──
    handleConnection(client) {
        const psk = client.handshake.auth?.psk;
        if (psk !== (0, client_psk_js_1.clientPsk)()) {
            client.emit("error", "invalid PSK");
            client.disconnect();
            return;
        }
        console.log(`[ws] connected: ${client.id}`);
    }
    async handleDisconnect(client) {
        const clientId = client.data.clientId;
        if (clientId) {
            await this.cleanupClientConnection(clientId, client.id);
        }
        else {
            // 未完成 REGISTER 的 socket 也可能持有 broker pending request。
            this.piRequests.disconnect(client.id);
            this.terminalBroker.disconnect(client.id);
        }
        await this.clientService.markOfflineBySocketId(client.id);
        console.log(`[ws] disconnected: ${clientId ?? client.id}`);
    }
    /** 扫描并收敛停止心跳的 Client；数据库先以 socket lease 原子摘除，避免误伤新连接。 */
    async sweepStaleClients() {
        const expired = await this.clientService.expireStaleClients();
        for (const client of expired) {
            if (client.socketId)
                await this.cleanupClientConnection(client.clientId, client.socketId);
            console.log(`[ws] heartbeat timeout: ${client.clientId}`);
        }
    }
    async cleanupClientConnection(clientId, socketId) {
        // 必须在 generation 队列外先释放等待 response 的 REST lease，避免断线死锁。
        this.piRequests.disconnect(socketId);
        this.terminalBroker.disconnect(socketId);
        // FRP 恢复周期只回收匹配 socket 的租约（service 内部判断）。
        void this.frpReconciliation?.disconnect(clientId, socketId);
        if (await this.piRuns.disconnectGeneration(clientId, socketId)) {
            await this.jobService.markDisconnected(clientId);
            await this.frpService.markInactiveByClientId(clientId);
        }
        await this.terminalService.handleClientDisconnect(clientId, socketId);
    }
    // ── Client events ──
    async handleRegister(client, data) {
        let register;
        try {
            // 信任边界：跨信任边界输入必须运行时校验；非法消息不持久化、不进入任何状态机。
            register = (0, shared_1.parseMachineRegister)(data);
        }
        catch {
            client.emit("error", "invalid register");
            client.disconnect();
            return { ok: false };
        }
        await this.clientService.register(register, client.id);
        client.data.clientId = register.clientId;
        client.join(register.clientId);
        await this.piRuns.markReconcilePending(register.clientId, client.id);
        await this.terminalService.handleClientRegistered(register.clientId, client.id);
        this.orchestrator.onClientRegistered(register.clientId, register.clientVersion);
        client.emit("ack", { event: shared_1.Events.REGISTER });
        console.log(`[ws] registered: ${register.clientId} (${register.hostname})`);
        return { ok: true };
    }
    // ── FRP runtime 状态上报（socket lease 信任边界；严格解析在 service 内） ──
    async handleFrpState(client, data) {
        const clientId = client.data.clientId;
        if (typeof clientId !== "string" || !this.frpReconciliation) {
            // 未注册 socket 或 service 缺失：失败关闭，不触发任何恢复。
            return {
                connectionGeneration: "",
                accepted: false,
                action: "stale",
            };
        }
        const ack = await this.frpReconciliation.handleState(clientId, client.id, data);
        // 兼容无 callback 的桥接：同步广播 ack 事件（Client 只接受本代 ack）。
        client.emit(shared_1.Events.FRP_STATE_ACK, ack);
        return ack;
    }
    /** reconcile 派发：精确发往 socketId（lease 信任边界），并广播 Job 更新。 */
    sendReconcileDispatch(socketId, d) {
        this.server.to(socketId).emit(shared_1.Events.JOB_DISPATCH, {
            jobId: d.jobId,
            type: d.type,
            payload: d.payload,
            timeout: d.timeout,
        });
        this.server.emit(shared_1.Events.JOB_UPDATE, {
            jobId: d.jobId,
            type: d.type,
            status: shared_1.JobStatus.RUNNING,
        });
    }
    // ── 自更新事件 ──
    handleUpdateReady(data) {
        this.orchestrator.onUpdateReady(data.clientId, data.releaseVersion);
    }
    handleUpdateFailed(data) {
        this.orchestrator.onUpdateFailed(data.clientId, data.releaseVersion, data.reason);
    }
    // ── Pi 事件（复用现有 PSK 连接） ──
    async handlePiResponse(client, data) {
        if (typeof client.data.clientId !== "string")
            return;
        try {
            const parsed = (0, shared_1.parsePiResponse)(data);
            // response 不进入 generation queue；pending lease 直接校验 socketId。
            this.piRequests.resolve(client.id, parsed);
        }
        catch {
            // 非法响应忽略
        }
    }
    async handlePiEvent(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parsePiEvent)(data);
            if (parsed.clientId !== clientId)
                return; // 身份绑定：禁止伪造其他 Client 事件
            await this.piRuns.withReconciledSocket(clientId, client.id, () => this.piEvents.publish(parsed));
        }
        catch {
            // 非法事件忽略
        }
    }
    async handlePiState(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parsePiStateReport)(data);
            if (parsed.clientId !== clientId)
                return; // 身份绑定
            const result = await this.piRuns.reconcileGeneration(clientId, client.id, parsed);
            return result;
        }
        catch {
            // 非法报告忽略
            return { acceptedRunIds: [], closedRunIds: [], reportAgain: false };
        }
    }
    async handleHeartbeat(data) {
        await this.clientService.heartbeat(data);
    }
    // ── 终端事件（复用现有 PSK 连接；身份来自 socket 绑定） ──
    async handleTerminalResponse(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parseTerminalClientResponse)(data);
            // 响应由 broker 关联；service 仅做防御性校验
            this.terminalBroker.resolve(client.id, parsed);
            await this.terminalService.handleClientResponse(clientId, client.id, parsed);
        }
        catch {
            // 非法响应忽略
        }
    }
    async handleTerminalOutput(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parseTerminalOutputChunk)(data);
            await this.terminalService.handleClientOutput(clientId, parsed);
        }
        catch {
            // 非法块忽略
        }
    }
    async handleTerminalExit(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parseTerminalExitReport)(data);
            await this.terminalService.handleClientExit(clientId, parsed);
        }
        catch {
            // 非法报告忽略
        }
    }
    async handleTerminalState(client, data) {
        const clientId = client.data.clientId;
        if (!clientId)
            return;
        try {
            const parsed = (0, shared_1.parseTerminalStateReport)(data);
            if (parsed.clientId !== clientId)
                return; // 身份绑定
            const result = await this.terminalService.handleClientState(clientId, client.id, parsed);
            return result;
        }
        catch {
            // 非法报告忽略
            return { acceptedSessionIds: [], closeSessionIds: [] };
        }
    }
    async handleStatusReport(client, data) {
        await this.clientService.bindSocket(data.clientId, client.id);
        client.join(data.clientId);
        const dispatches = await this.jobService.reconcileOnReconnect(data.clientId, data);
        for (const r of data.jobs) {
            const status = r.status === "running"
                ? shared_1.JobStatus.RUNNING
                : r.status === "waiting_input"
                    ? shared_1.JobStatus.WAITING_INPUT
                    : r.status === "done"
                        ? shared_1.JobStatus.DONE
                        : shared_1.JobStatus.ERROR;
            // Fetch job to get type (best-effort, might be null during reconnect)
            const job = await this.jobService.findById(r.jobId);
            this.server.emit(shared_1.Events.JOB_UPDATE, {
                jobId: r.jobId,
                type: job?.type ?? "exec",
                status,
                result: r.exitCode != null ? { exitCode: r.exitCode } : undefined,
            });
        }
        for (const d of dispatches) {
            this.sendDispatch(d);
        }
    }
    // ── Job output ──
    async handleJobStdout(data) {
        await this.jobService.appendOutputRaw(data.jobId, data.text);
        this.server.emit(shared_1.Events.JOB_STDOUT, data);
    }
    async handleJobStderr(data) {
        await this.jobService.appendOutputRaw(data.jobId, data.text);
        this.server.emit(shared_1.Events.JOB_STDERR, data);
    }
    async handleJobProgress(data) {
        await this.jobService.updateProgress(data.jobId, data.loaded, data.total);
    }
    async handleJobDone(data) {
        const raw = data;
        const type = raw.type;
        // ── FRP reconcile：system Job 由 reconciliation service 直接终结，不走 create/delete 收敛 ──
        if (type === "frp.reconcile") {
            if (raw.error) {
                await this.frpReconciliation?.handleLocalFailure(data.jobId, typeof raw.error.code === "string" ? raw.error.code : "FRP_RECONCILE_FAILED");
            }
            else {
                await this.frpReconciliation?.handleLocalResult(data.jobId, raw.result);
            }
            return;
        }
        if (type === "exec") {
            // ── Exec error 终态（基础设施失败） ──
            if (raw.error) {
                const errorCode = raw.error.code || "EXEC_FAILED";
                const errorMessage = raw.error.message || "";
                const result = { errorCode, errorMessage };
                if (raw.stdout)
                    result.stdout = raw.stdout;
                if (raw.stderr)
                    result.stderr = raw.stderr;
                const next = await this.jobService.markDone(data.jobId, type, result);
                this.server.emit(shared_1.Events.JOB_UPDATE, {
                    jobId: data.jobId,
                    type,
                    status: shared_1.JobStatus.ERROR,
                    errorCode,
                    errorMessage,
                    result: undefined,
                });
                if (next)
                    this.sendDispatch(next);
                return;
            }
            // ── Exec 正常退出 ──
            const exitCode = raw.exitCode ?? 1;
            const result = { exitCode };
            if (raw.stdout)
                result.stdout = raw.stdout;
            if (raw.stderr)
                result.stderr = raw.stderr;
            const status = exitCode === 0 ? shared_1.JobStatus.DONE : shared_1.JobStatus.ERROR;
            const next = await this.jobService.markDone(data.jobId, type, result);
            this.server.emit(shared_1.Events.JOB_UPDATE, {
                jobId: data.jobId,
                type,
                status,
                result,
            });
            if (next)
                this.sendDispatch(next);
            return;
        }
        // ── FRP 回调：Client 只完成本地动作，Server 再以 Dashboard 收敛 ──
        if (type === "frp.create" || type === "frp.delete") {
            const outcome = raw.error
                ? await this.frpService.failClientOperation(data.jobId, type, raw.error.code || "IO_ERROR", raw.error.message || "")
                : await this.frpService.settleClientOperation(data.jobId, type);
            if (!outcome.terminal) {
                this.sendDispatch(outcome.dispatch);
                return;
            }
            const result = {
                ...outcome.result,
                ...(outcome.errorCode
                    ? {
                        errorCode: outcome.errorCode,
                        errorMessage: outcome.errorMessage,
                    }
                    : {}),
            };
            const next = await this.jobService.markDone(data.jobId, type, result);
            this.server.emit(shared_1.Events.JOB_UPDATE, {
                jobId: data.jobId,
                type,
                status: outcome.errorCode ? shared_1.JobStatus.ERROR : shared_1.JobStatus.DONE,
                errorCode: outcome.errorCode,
                errorMessage: outcome.errorMessage,
                result: outcome.result,
            });
            if (outcome.relatedJob) {
                const relatedNext = await this.jobService.markDone(outcome.relatedJob.jobId, "frp.create", {
                    errorCode: outcome.relatedJob.errorCode,
                    errorMessage: outcome.relatedJob.errorMessage,
                });
                this.server.emit(shared_1.Events.JOB_UPDATE, {
                    jobId: outcome.relatedJob.jobId,
                    type: "frp.create",
                    status: shared_1.JobStatus.ERROR,
                    errorCode: outcome.relatedJob.errorCode,
                    errorMessage: outcome.relatedJob.errorMessage,
                });
                if (relatedNext)
                    this.sendDispatch(relatedNext);
            }
            if (next)
                this.sendDispatch(next);
            return;
        }
        // ── 其他 Job 类型 ──
        // ── 非 exec error 终态 ──
        if (raw.error) {
            const errorCode = raw.error.code || "IO_ERROR";
            const errorMessage = raw.error.message || "";
            await this.jobService.markDone(data.jobId, type, { errorCode, errorMessage });
            this.server.emit(shared_1.Events.JOB_UPDATE, {
                jobId: data.jobId,
                type,
                status: shared_1.JobStatus.ERROR,
                errorCode,
                errorMessage,
                result: undefined,
            });
            return;
        }
        let result = raw.result;
        if (type === "frp.list") {
            const next = await this.jobService.markDone(data.jobId, type, result ?? {});
            this.server.emit(shared_1.Events.JOB_UPDATE, {
                jobId: data.jobId,
                type,
                status: shared_1.JobStatus.DONE,
                result: raw.result,
            });
            if (next)
                this.sendDispatch(next);
            return;
        }
        // file.export 完成后确认上传，使用 File 表中上传阶段持久化的真实 key
        if (type === "file.export" && result?.fileId && result?.sha256) {
            const file = await this.fileService.confirmUpload(result.fileId, result.sha256);
            result = { ...result, key: file.key };
        }
        const next = await this.jobService.markDone(data.jobId, type, result);
        this.server.emit(shared_1.Events.JOB_UPDATE, {
            jobId: data.jobId,
            type,
            status: shared_1.JobStatus.DONE,
            result,
        });
        if (next)
            this.sendDispatch(next);
    }
    async handleJobCancelled(data) {
        const next = await this.jobService.markCancelled(data.jobId);
        const job = await this.jobService.findById(data.jobId);
        this.server.emit(shared_1.Events.JOB_UPDATE, {
            jobId: data.jobId,
            type: job?.type ?? "exec",
            status: shared_1.JobStatus.CANCELLED,
        });
        if (next)
            this.sendDispatch(next);
    }
    handleJobCancelFailed(data) {
        console.error(`[ws] cancel failed: ${data.jobId} - ${data.reason}`);
        this.server.emit(shared_1.Events.JOB_CANCEL_FAILED, data);
    }
    // ── Public API (called by controller) ──
    sendDispatch(d) {
        if (d.type === "exec") {
            const p = d.payload;
            if (p.mode === "script") {
                this.server.to(d.clientId).emit(shared_1.Events.JOB_DISPATCH, {
                    jobId: d.jobId,
                    type: "exec",
                    mode: "script",
                    executable: p.executable,
                    args: p.args,
                    script: p.script,
                    cwd: p.cwd,
                    timeout: d.timeout,
                });
            }
            else {
                this.server.to(d.clientId).emit(shared_1.Events.JOB_DISPATCH, {
                    jobId: d.jobId,
                    type: "exec",
                    mode: "command",
                    command: (p.command ?? ""),
                    cwd: p.cwd,
                    timeout: d.timeout,
                });
            }
        }
        else {
            this.server.to(d.clientId).emit(shared_1.Events.JOB_DISPATCH, {
                jobId: d.jobId,
                type: d.type,
                payload: d.payload,
                timeout: d.timeout,
            });
        }
        this.server.emit(shared_1.Events.JOB_UPDATE, {
            jobId: d.jobId,
            type: d.type,
            status: shared_1.JobStatus.RUNNING,
        });
    }
    sendCancel(clientId, jobId) {
        this.server.to(clientId).emit(shared_1.Events.JOB_CANCEL, { jobId });
    }
};
exports.ClientGateway = ClientGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", Function)
], ClientGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.REGISTER),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleRegister", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.FRP_STATE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleFrpState", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.UPDATE_READY),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientGateway.prototype, "handleUpdateReady", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.UPDATE_FAILED),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientGateway.prototype, "handleUpdateFailed", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.PI_RESPONSE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handlePiResponse", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.PI_EVENT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handlePiEvent", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.PI_STATE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handlePiState", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.HEARTBEAT),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleHeartbeat", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_RESPONSE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleTerminalResponse", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_OUTPUT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleTerminalOutput", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_EXIT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleTerminalExit", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.TERMINAL_STATE),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleTerminalState", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.STATUS_REPORT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleStatusReport", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_STDOUT),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleJobStdout", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_STDERR),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleJobStderr", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_PROGRESS),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleJobProgress", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_DONE),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleJobDone", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_CANCELLED),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ClientGateway.prototype, "handleJobCancelled", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_CANCEL_FAILED),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ClientGateway.prototype, "handleJobCancelFailed", null);
exports.ClientGateway = ClientGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({ namespace: "/client", cors: { origin: process.env.VCPDECK_CORS_ORIGIN || "http://localhost:5173" } }),
    __param(0, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __param(1, (0, common_1.Inject)(job_service_js_1.JobService)),
    __param(2, (0, common_1.Inject)(file_service_js_1.FileService)),
    __param(3, (0, common_1.Inject)(frp_service_js_1.FrpService)),
    __param(4, (0, common_1.Inject)(pi_request_broker_js_1.PiRequestBroker)),
    __param(5, (0, common_1.Inject)(pi_event_broker_js_1.PiEventBroker)),
    __param(6, (0, common_1.Inject)(pi_run_service_js_1.PiRunService)),
    __param(7, (0, common_1.Inject)(terminal_service_js_1.TerminalService)),
    __param(8, (0, common_1.Inject)(terminal_request_broker_js_1.TerminalRequestBroker)),
    __param(9, (0, common_1.Inject)((0, common_1.forwardRef)(() => release_orchestrator_js_1.ReleaseOrchestrator))),
    __param(10, (0, common_1.Inject)((0, common_1.forwardRef)(() => update_channel_js_1.GatewayUpdateChannel))),
    __param(11, (0, common_1.Optional)()),
    __param(11, (0, common_1.Inject)(frp_reconciliation_service_js_1.FrpReconciliationService)),
    __metadata("design:paramtypes", [client_service_js_1.ClientService, job_service_js_1.JobService, file_service_js_1.FileService, frp_service_js_1.FrpService, pi_request_broker_js_1.PiRequestBroker, pi_event_broker_js_1.PiEventBroker, pi_run_service_js_1.PiRunService, terminal_service_js_1.TerminalService, terminal_request_broker_js_1.TerminalRequestBroker, release_orchestrator_js_1.ReleaseOrchestrator, update_channel_js_1.GatewayUpdateChannel, frp_reconciliation_service_js_1.FrpReconciliationService])
], ClientGateway);
