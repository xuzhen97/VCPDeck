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
exports.EventsGateway = void 0;
const common_1 = require("@nestjs/common");
const websockets_1 = require("@nestjs/websockets");
const client_service_js_1 = require("../client/client.service.js");
const job_service_js_1 = require("../job/job.service.js");
const shared_1 = require("@vcpdeck/shared");
const PSK = process.env.VCPDECK_PSK || "vcpdeck-dev-psk";
let EventsGateway = class EventsGateway {
    clientService;
    jobService;
    server;
    constructor(clientService, jobService) {
        this.clientService = clientService;
        this.jobService = jobService;
    }
    // ── Connection lifecycle ──
    handleConnection(client) {
        const psk = client.handshake.auth?.psk;
        if (psk !== PSK) {
            client.emit("error", "invalid PSK");
            client.disconnect();
            return;
        }
        console.log(`[ws] connected: ${client.id}`);
    }
    async handleDisconnect(client) {
        const clientId = await this.clientService.getClientIdBySocketId(client.id);
        if (clientId) {
            await this.jobService.markDisconnected(clientId);
        }
        await this.clientService.markOfflineBySocketId(client.id);
        console.log(`[ws] disconnected: ${clientId ?? client.id}`);
    }
    // ── Client events ──
    async handleRegister(client, data) {
        await this.clientService.register(data, client.id);
        client.join(data.clientId);
        client.emit("ack", { event: shared_1.Events.REGISTER });
        console.log(`[ws] registered: ${data.clientId} (${data.hostname})`);
    }
    async handleHeartbeat(data) {
        await this.clientService.heartbeat(data);
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
    async handleJobDone(data) {
        const raw = data;
        const type = raw.type;
        const result = type === "exec" ? { exitCode: raw.exitCode } : raw.result;
        const next = await this.jobService.markDone(data.jobId, type, result);
        const status = type === "exec" && result.exitCode !== 0
            ? shared_1.JobStatus.ERROR
            : shared_1.JobStatus.DONE;
        this.server.emit(shared_1.Events.JOB_UPDATE, {
            jobId: data.jobId,
            type,
            status,
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
            const execPayload = d.payload;
            this.server.to(d.clientId).emit(shared_1.Events.JOB_DISPATCH, {
                jobId: d.jobId,
                type: "exec",
                command: execPayload.command,
                timeout: d.timeout,
            });
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
exports.EventsGateway = EventsGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", Function)
], EventsGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.REGISTER),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleRegister", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.HEARTBEAT),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleHeartbeat", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.STATUS_REPORT),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleStatusReport", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_STDOUT),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleJobStdout", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_STDERR),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleJobStderr", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_DONE),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleJobDone", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_CANCELLED),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsGateway.prototype, "handleJobCancelled", null);
__decorate([
    (0, websockets_1.SubscribeMessage)(shared_1.Events.JOB_CANCEL_FAILED),
    __param(0, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], EventsGateway.prototype, "handleJobCancelFailed", null);
exports.EventsGateway = EventsGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({ cors: { origin: "*" } }),
    __param(0, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __param(1, (0, common_1.Inject)(job_service_js_1.JobService)),
    __metadata("design:paramtypes", [client_service_js_1.ClientService, job_service_js_1.JobService])
], EventsGateway);
