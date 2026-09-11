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
exports.PiRunService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const shared_2 = require("@vcpdeck/shared");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const SETTLEMENT_GRACE_MS = 30_000;
const EMPTY_SESSION_PAYLOAD = "{}";
const ACTIVE_STATUSES = [
    shared_1.JobStatus.PENDING,
    shared_1.JobStatus.RUNNING,
    shared_1.JobStatus.WAITING_INPUT,
    shared_1.JobStatus.DISCONNECTED,
];
function piError(code, message) {
    return Object.assign(new Error(message), { code });
}
function parsePayload(raw) {
    try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value))
            return {};
        const payload = value;
        const keys = Object.keys(payload);
        if (keys.length === 1 && keys[0] === "runId"
            && typeof payload.runId === "string" && payload.runId.length > 0) {
            return { runId: payload.runId };
        }
        if (keys.length === 2 && keys.includes("deleteToken") && keys.includes("previousStatus")
            && typeof payload.deleteToken === "string" && payload.deleteToken.length > 0
            && (payload.previousStatus === "idle" || payload.previousStatus === "done" || payload.previousStatus === "error")) {
            return { deleteToken: payload.deleteToken, previousStatus: payload.previousStatus };
        }
        return {};
    }
    catch {
        return {};
    }
}
function runPayload(runId) {
    return JSON.stringify({ runId });
}
function deletePayload(deleteToken, previousStatus) {
    return JSON.stringify({ deleteToken, previousStatus });
}
function safePiErrorMessage(code) {
    const messages = {
        PI_PROTOCOL_INVALID: "Pi protocol input was invalid",
        PI_CLIENT_UNSUPPORTED: "Pi client is unsupported",
        PI_NODE_UNSUPPORTED: "Node.js version is unsupported",
        PI_BASH_NOT_FOUND: "Bash was not found on the client",
        PI_RUNTIME_UNAVAILABLE: "Pi runtime is unavailable",
        PI_AUTH_UNAVAILABLE: "Pi authentication is unavailable",
        PI_MODEL_NOT_FOUND: "Pi model was not found",
        PI_PROJECT_NOT_ALLOWED: "Pi project is not allowed",
        PI_SESSION_NOT_FOUND: "Pi session was not found",
        PI_PROJECT_BUSY: "Pi project has an active run",
        PI_CONTROL_FORBIDDEN: "Pi session control is forbidden",
        PI_CLIENT_DISCONNECTED: "Pi client disconnected",
        PI_WORKER_EXITED: "Pi worker exited unexpectedly",
        PI_CLIENT_RESTARTED: "Client restarted before the Pi run could be recovered",
        PI_IMAGE_INVALID: "Pi image is invalid",
        PI_IMAGE_TOO_LARGE: "Pi image is too large",
        PI_REQUEST_TIMEOUT: "Pi request timed out",
        PI_STATE_PENDING: "Pi client state reconciliation is pending",
    };
    return messages[code] ?? "Pi session failed";
}
/** Pi Session Job 的原子状态机与短期连接代次租约。 */
let PiRunService = class PiRunService {
    prisma;
    locks = new Map();
    settlementTimers = new Map();
    generations = new Map();
    queues = new Map();
    constructor(prisma) {
        this.prisma = prisma;
    }
    lockKey(clientId, projectKey) {
        return `${clientId}:${projectKey}`;
    }
    settlementKey(jobId, runId) {
        return `${jobId}:${runId}`;
    }
    async serialized(clientId, operation) {
        const previous = this.queues.get(clientId) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        this.queues.set(clientId, tail);
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
            if (this.queues.get(clientId) === tail)
                this.queues.delete(clientId);
        }
    }
    requireGeneration(clientId, socketId) {
        const generation = this.generations.get(clientId);
        if (!generation?.ready || (socketId !== undefined && generation.socketId !== socketId)) {
            throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
        }
        return generation;
    }
    async findSession(jobId) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job || job.type !== "agent.session") {
            throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
        }
        return job;
    }
    setLock(clientId, projectKey, jobId, runId) {
        this.locks.set(this.lockKey(clientId, projectKey), { clientId, projectKey, jobId, runId });
    }
    releaseLock(jobId, runId) {
        for (const [key, lock] of this.locks) {
            if (lock.jobId === jobId && lock.runId === runId)
                this.locks.delete(key);
        }
    }
    /** 仅供精确 run 测试与短期编排判断。 */
    hasLock(jobId, runId) {
        return [...this.locks.values()].some((lock) => lock.jobId === jobId && lock.runId === runId);
    }
    async ensureSession(actor, input) {
        const existing = await this.prisma.job.findUnique({ where: { id: input.sessionId } });
        if (existing) {
            if (existing.clientId !== input.clientId || existing.type !== "agent.session") {
                throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
            }
            return;
        }
        try {
            await this.prisma.job.create({
                data: {
                    id: input.sessionId,
                    clientId: input.clientId,
                    type: "agent.session",
                    status: shared_1.JobStatus.IDLE,
                    payload: EMPTY_SESSION_PAYLOAD,
                    progress: null,
                    createdByIdentityId: actor.identityId,
                    createdByName: actor.displayName,
                    createdVia: actor.source,
                },
            });
        }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "P2002"))
                throw error;
            const winner = await this.prisma.job.findUnique({ where: { id: input.sessionId } });
            if (!winner || winner.clientId !== input.clientId || winner.type !== "agent.session") {
                throw piError("PI_SESSION_NOT_FOUND", "Session id belongs to a different resource");
            }
        }
    }
    async snapshot(sessionId, identityId) {
        const job = await this.findSession(sessionId);
        const payload = parsePayload(job.payload);
        return {
            jobId: job.id,
            sessionId: job.id,
            status: job.status,
            runId: ACTIVE_STATUSES.includes(job.status)
                && typeof payload.runId === "string" ? payload.runId : null,
            ownerName: job.createdByName ?? null,
            isOwner: job.createdByIdentityId === identityId,
            ...(job.errorCode ? { errorCode: job.errorCode } : {}),
            ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
        };
    }
    async startRun(actor, input) {
        const runId = (0, node_crypto_1.randomUUID)();
        const key = this.lockKey(input.clientId, input.projectKey);
        if (this.locks.has(key))
            throw piError("PI_PROJECT_BUSY", "Project has an active run");
        this.setLock(input.clientId, input.projectKey, input.sessionId, runId);
        try {
            const updated = await this.prisma.job.updateMany({
                where: {
                    id: input.sessionId,
                    clientId: input.clientId,
                    type: "agent.session",
                    status: { in: [shared_1.JobStatus.IDLE, shared_1.JobStatus.DONE] },
                    payload: EMPTY_SESSION_PAYLOAD,
                    createdByIdentityId: actor.identityId,
                },
                data: {
                    status: shared_1.JobStatus.PENDING,
                    payload: runPayload(runId),
                    progress: null,
                    result: null,
                    startedAt: null,
                    finishedAt: null,
                    errorCode: null,
                    errorMessage: null,
                },
            });
            if (updated.count === 0)
                throw piError("PI_PROJECT_BUSY", "Session is not idle");
            return { jobId: input.sessionId, runId };
        }
        catch (error) {
            this.releaseLock(input.sessionId, runId);
            throw error;
        }
    }
    async accept(jobId, runId) {
        return this.runTransition(jobId, runId, [shared_1.JobStatus.PENDING], { status: shared_1.JobStatus.RUNNING, startedAt: new Date() });
    }
    async waitForInput(jobId, runId) {
        return this.runTransition(jobId, runId, [shared_1.JobStatus.PENDING, shared_1.JobStatus.RUNNING], { status: shared_1.JobStatus.WAITING_INPUT });
    }
    async resume(jobId, runId) {
        return this.runTransition(jobId, runId, [shared_1.JobStatus.WAITING_INPUT], { status: shared_1.JobStatus.RUNNING });
    }
    async finishRun(jobId, runId) {
        const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
            status: shared_1.JobStatus.IDLE,
            payload: EMPTY_SESSION_PAYLOAD,
            progress: null,
            finishedAt: null,
        });
        if (updated)
            this.releaseLock(jobId, runId);
        return updated;
    }
    async completeSession(jobId, runId) {
        const now = new Date();
        if (runId !== undefined) {
            const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
                status: shared_1.JobStatus.DONE,
                payload: EMPTY_SESSION_PAYLOAD,
                progress: null,
                finishedAt: now,
            });
            if (updated)
                this.releaseLock(jobId, runId);
            if (updated)
                return true;
        }
        if (runId !== undefined)
            return false;
        const completed = await this.prisma.job.updateMany({
            where: {
                id: jobId,
                type: "agent.session",
                status: { in: [shared_1.JobStatus.IDLE, shared_1.JobStatus.ERROR] },
                payload: EMPTY_SESSION_PAYLOAD,
            },
            data: {
                status: shared_1.JobStatus.DONE,
                progress: null,
                finishedAt: now,
                errorCode: null,
                errorMessage: null,
            },
        });
        if (completed.count > 0)
            return true;
        const unchanged = await this.prisma.job.updateMany({
            where: {
                id: jobId,
                type: "agent.session",
                status: shared_1.JobStatus.DONE,
                payload: EMPTY_SESSION_PAYLOAD,
            },
            data: { status: shared_1.JobStatus.DONE },
        });
        return unchanged.count > 0;
    }
    async failSession(jobId, runId, code) {
        const updated = await this.runTransition(jobId, runId, ACTIVE_STATUSES, {
            status: shared_1.JobStatus.ERROR,
            payload: EMPTY_SESSION_PAYLOAD,
            progress: null,
            finishedAt: new Date(),
            errorCode: code,
            errorMessage: safePiErrorMessage(code),
        });
        if (updated)
            this.releaseLock(jobId, runId);
        return updated;
    }
    async reconcileOpen(jobId, runId, state) {
        if ((0, shared_2.isPiAgentIdle)(state)) {
            return this.finishRun(jobId, runId);
        }
        const target = state.waitingForExtensionInput || state.status === "waiting_for_extension_input"
            ? shared_1.JobStatus.WAITING_INPUT
            : shared_1.JobStatus.RUNNING;
        return this.runTransition(jobId, runId, [shared_1.JobStatus.RUNNING, shared_1.JobStatus.WAITING_INPUT, shared_1.JobStatus.DISCONNECTED], { status: target });
    }
    async beginDelete(jobId, identityId) {
        const job = await this.findSession(jobId);
        if (job.createdByIdentityId !== identityId)
            throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can delete it");
        const payload = parsePayload(job.payload);
        if (job.status === shared_1.JobStatus.CANCELLED && payload.deleteToken && payload.previousStatus) {
            return { deleteToken: payload.deleteToken, previousStatus: payload.previousStatus, existingReservation: true };
        }
        if (![shared_1.JobStatus.IDLE, shared_1.JobStatus.DONE, shared_1.JobStatus.ERROR].includes(job.status)) {
            throw piError("PI_PROJECT_BUSY", "Session has an active run");
        }
        const deleteToken = (0, node_crypto_1.randomUUID)();
        const previousStatus = job.status;
        const updated = await this.prisma.job.updateMany({
            where: { id: jobId, type: "agent.session", status: previousStatus, payload: EMPTY_SESSION_PAYLOAD },
            data: { status: shared_1.JobStatus.CANCELLED, payload: deletePayload(deleteToken, previousStatus), progress: null, finishedAt: new Date() },
        });
        if (updated.count === 0)
            throw piError("PI_PROJECT_BUSY", "Session state changed during deletion");
        return { deleteToken, previousStatus, existingReservation: false };
    }
    async rollbackDelete(jobId, deleteToken) {
        const job = await this.findSession(jobId);
        const payload = parsePayload(job.payload);
        if (!payload.previousStatus || payload.deleteToken !== deleteToken)
            return false;
        const updated = await this.prisma.job.updateMany({
            where: { id: jobId, type: "agent.session", status: shared_1.JobStatus.CANCELLED, payload: deletePayload(deleteToken, payload.previousStatus) },
            data: { status: payload.previousStatus, payload: EMPTY_SESSION_PAYLOAD, progress: null },
        });
        return updated.count > 0;
    }
    async commitDelete(jobId, deleteToken) {
        const job = await this.findSession(jobId);
        const payload = parsePayload(job.payload);
        if (!payload.previousStatus || payload.deleteToken !== deleteToken)
            return false;
        const updated = await this.prisma.job.updateMany({
            where: { id: jobId, type: "agent.session", status: shared_1.JobStatus.CANCELLED, payload: deletePayload(deleteToken, payload.previousStatus) },
            data: { status: shared_1.JobStatus.CANCELLED, payload: EMPTY_SESSION_PAYLOAD, progress: null },
        });
        return updated.count > 0;
    }
    async assertSessionOwner(jobId, identityId) {
        const job = await this.findSession(jobId);
        if (job.createdByIdentityId !== identityId)
            throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can control it");
    }
    async assertCurrentRunOwner(jobId, runId, identityId) {
        const job = await this.findSession(jobId);
        if (job.createdByIdentityId !== identityId || job.payload !== runPayload(runId) || !ACTIVE_STATUSES.includes(job.status)) {
            throw piError("PI_CONTROL_FORBIDDEN", "Only the current run owner can control it");
        }
    }
    async scheduleSettlement(jobId, runId, onSettle) {
        this.cancelSettlement(jobId, runId);
        const key = this.settlementKey(jobId, runId);
        const timer = setTimeout(() => {
            this.settlementTimers.delete(key);
            void this.findSession(jobId)
                .then((job) => {
                if (job.payload === runPayload(runId)
                    && ACTIVE_STATUSES.includes(job.status)) {
                    return onSettle();
                }
            })
                .catch(() => { });
        }, SETTLEMENT_GRACE_MS);
        this.settlementTimers.set(key, timer);
    }
    cancelSettlement(jobId, runId) {
        const key = this.settlementKey(jobId, runId);
        const timer = this.settlementTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.settlementTimers.delete(key);
        }
    }
    async markReconcilePending(clientId, socketId) {
        await this.serialized(clientId, async () => {
            this.generations.set(clientId, { socketId, ready: false });
        });
    }
    async withReconciledClient(clientId, operation) {
        const generation = this.requireGeneration(clientId);
        const socketId = generation.socketId;
        return this.serialized(clientId, async () => {
            this.requireGeneration(clientId, socketId);
            return operation({ clientId, socketId });
        });
    }
    async withReconciledSocket(clientId, socketId, operation) {
        this.requireGeneration(clientId, socketId);
        return this.serialized(clientId, async () => {
            this.requireGeneration(clientId, socketId);
            return operation();
        });
    }
    async reconcileGeneration(clientId, socketId, report) {
        return this.serialized(clientId, async () => {
            const generation = this.generations.get(clientId);
            if (!generation || generation.socketId !== socketId || generation.ready) {
                throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
            }
            const ack = await this.reconcileReport(clientId, report);
            if (!ack.reportAgain)
                generation.ready = true;
            return ack;
        });
    }
    /** 将不确定 dispatch 的 matching run 精确标记为断线。 */
    async markRunDisconnected(jobId, runId) {
        return this.runTransition(jobId, runId, [shared_1.JobStatus.PENDING, shared_1.JobStatus.RUNNING, shared_1.JobStatus.WAITING_INPUT], { status: shared_1.JobStatus.DISCONNECTED });
    }
    async disconnectGeneration(clientId, socketId) {
        return this.serialized(clientId, async () => {
            const generation = this.generations.get(clientId);
            if (!generation || generation.socketId !== socketId)
                return false;
            this.generations.delete(clientId);
            const jobs = await this.listActiveSessionJobs(clientId);
            for (const job of jobs) {
                const runId = parsePayload(job.payload).runId;
                if (!runId || ![shared_1.JobStatus.PENDING, shared_1.JobStatus.RUNNING, shared_1.JobStatus.WAITING_INPUT].includes(job.status))
                    continue;
                await this.runTransition(job.id, runId, [shared_1.JobStatus.PENDING, shared_1.JobStatus.RUNNING, shared_1.JobStatus.WAITING_INPUT], { status: shared_1.JobStatus.DISCONNECTED });
            }
            return true;
        });
    }
    async reconcileReport(clientId, report) {
        const acceptedRunIds = [];
        const closedRunIds = [];
        const activeReports = report.runs.filter((run) => run.status === "running" || run.status === "waiting_input");
        const duplicateKeys = new Set();
        const seenKeys = new Set();
        for (const run of activeReports) {
            if (!run.projectKey)
                continue;
            if (seenKeys.has(run.projectKey))
                duplicateKeys.add(run.projectKey);
            seenKeys.add(run.projectKey);
        }
        for (const run of activeReports) {
            const job = await this.prisma.job.findUnique({ where: { id: run.jobId } });
            if (!job || job.clientId !== clientId || job.type !== "agent.session" || job.payload !== runPayload(run.runId) || !ACTIVE_STATUSES.includes(job.status)) {
                closedRunIds.push(run.runId);
                continue;
            }
            if (run.projectKey && duplicateKeys.has(run.projectKey)) {
                await this.failSession(run.jobId, run.runId, "PI_PROTOCOL_INVALID");
                closedRunIds.push(run.runId);
                continue;
            }
            const status = run.status === "waiting_input" ? shared_1.JobStatus.WAITING_INPUT : shared_1.JobStatus.RUNNING;
            if (await this.runTransition(run.jobId, run.runId, ACTIVE_STATUSES, { status })) {
                acceptedRunIds.push(run.runId);
                if (run.projectKey)
                    this.setLock(clientId, run.projectKey, run.jobId, run.runId);
            }
        }
        for (const run of report.runs.filter((candidate) => candidate.status === "idle" || candidate.status === "done")) {
            const job = await this.prisma.job.findUnique({ where: { id: run.jobId } });
            if (job?.clientId === clientId && await this.finishRun(run.jobId, run.runId))
                acceptedRunIds.push(run.runId);
        }
        for (const run of report.runs.filter((candidate) => candidate.status === "error")) {
            const job = await this.prisma.job.findUnique({ where: { id: run.jobId } });
            if (job?.clientId === clientId && await this.failSession(run.jobId, run.runId, "PI_WORKER_EXITED")) {
                acceptedRunIds.push(run.runId);
            }
        }
        const reported = new Set(report.runs.map((run) => `${run.jobId}:${run.runId}`));
        for (const job of await this.listActiveSessionJobs(clientId)) {
            const runId = parsePayload(job.payload).runId;
            if (!runId || reported.has(`${job.id}:${runId}`))
                continue;
            await this.failSession(job.id, runId, "PI_CLIENT_RESTARTED");
        }
        return { acceptedRunIds, closedRunIds, reportAgain: closedRunIds.length > 0 };
    }
    async assertIdleMutation(clientId, projectKey) {
        if (this.locks.has(this.lockKey(clientId, projectKey)))
            throw piError("PI_PROJECT_BUSY", "Project has an active turn");
    }
    async listAllRuns() {
        return this.prisma.job.findMany({ where: { type: "agent.run" } });
    }
    async listActiveByClient(clientId) {
        const jobs = await this.prisma.job.findMany({
            where: { clientId, type: "agent.session", status: { in: [...ACTIVE_STATUSES] } },
        });
        return jobs.flatMap((job) => {
            const runId = parsePayload(job.payload).runId;
            return typeof runId === "string" ? [{ jobId: job.id, runId, sessionId: job.id, status: job.status }] : [];
        });
    }
    async listActiveSessionJobs(clientId) {
        return this.prisma.job.findMany({
            where: { clientId, type: "agent.session", status: { in: [...ACTIVE_STATUSES] } },
        });
    }
    async runTransition(jobId, runId, statuses, data) {
        const updated = await this.prisma.job.updateMany({
            where: { id: jobId, type: "agent.session", status: { in: [...statuses] }, payload: runPayload(runId) },
            data,
        });
        return updated.count > 0;
    }
};
exports.PiRunService = PiRunService;
exports.PiRunService = PiRunService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService])
], PiRunService);
