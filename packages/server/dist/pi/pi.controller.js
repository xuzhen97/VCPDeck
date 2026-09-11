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
exports.PiController = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const client_service_js_1 = require("../client/client.service.js");
const pi_event_broker_js_1 = require("./pi-event-broker.js");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
const pi_run_service_js_1 = require("./pi-run.service.js");
const pi_attachment_service_js_1 = require("./pi-attachment.service.js");
function badRequest(code, message) {
    return new common_1.BadRequestException({ code, message });
}
function isPiError(error) {
    return error instanceof Error && "code" in error &&
        typeof error.code === "string" &&
        shared_1.PI_ERROR_CODES.includes(error.code);
}
function requireObject(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw badRequest("PI_PROTOCOL_INVALID", "body must be an object");
    }
}
function requireCwd(body) {
    requireObject(body);
    if (typeof body.rootDir !== "string" || typeof body.relativePath !== "string") {
        throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
    }
    return { rootDir: body.rootDir, relativePath: body.relativePath };
}
function optionalRunId(body) {
    requireObject(body);
    if (body.runId === undefined)
        return undefined;
    if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 256) {
        throw badRequest("PI_PROTOCOL_INVALID", "invalid runId");
    }
    return body.runId;
}
function requiredRunId(body) {
    const runId = optionalRunId(body);
    if (runId === undefined)
        throw badRequest("PI_PROTOCOL_INVALID", "runId required");
    return runId;
}
/** 机器命名空间的远程 Pi REST/SSE 接口 */
let PiController = class PiController {
    requests;
    events;
    runs;
    clients;
    attachments;
    constructor(requests, events, runs, clients, attachments) {
        this.requests = requests;
        this.events = events;
        this.runs = runs;
        this.clients = clients;
        this.attachments = attachments;
    }
    // ── helpers ──
    async requirePiClient(clientId) {
        const online = await this.clients.listOnline();
        const client = online.find((c) => c.clientId === clientId);
        if (!client) {
            throw new common_1.NotFoundException({
                code: "PI_CLIENT_DISCONNECTED",
                message: `Client "${clientId}" is offline or unknown`,
            });
        }
        if (!client.capabilities.includes("agent.pi") ||
            client.capabilityDetails.pi?.available !== true ||
            client.capabilityDetails.pi.sessionJobProtocolVersion !== shared_1.PI_SESSION_JOB_PROTOCOL_VERSION) {
            throw badRequest("PI_CLIENT_UNSUPPORTED", `Client "${clientId}" does not support Pi`);
        }
    }
    /** 在单一 ready generation 内执行 REST 编排，并稳定映射 broker/generation 错误。 */
    async withReconciledClient(clientId, operation) {
        try {
            return await this.runs.withReconciledClient(clientId, operation);
        }
        catch (err) {
            if (isPiError(err)) {
                throw badRequest(err.code, err.message);
            }
            throw err;
        }
    }
    /** 使用已有 generation lease 解析不透明 projectKey（不持久化）。 */
    async resolveProjectKey(lease, cwdRef) {
        const response = await this.requests.request(lease, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "project.resolve",
            cwdRef,
        });
        if (!response.ok) {
            throw badRequest(response.error.code, response.error.message);
        }
        return response.data.projectKey;
    }
    async requestOnce(lease, request) {
        try {
            const response = await this.requests.request(lease, request);
            if (!response.ok) {
                throw badRequest(response.error.code, response.error.message);
            }
            return response.data;
        }
        catch (err) {
            if (err instanceof Error && "code" in err) {
                throw badRequest(String(err.code), err.message);
            }
            throw err;
        }
    }
    requestForClient(clientId, request) {
        return this.withReconciledClient(clientId, (lease) => this.requestOnce(lease, request));
    }
    async assertSessionOwner(jobId, actor) {
        try {
            await this.runs.assertSessionOwner(jobId, actor.identityId);
        }
        catch (err) {
            if (isPiError(err))
                throw badRequest(err.code, err.message);
            throw err;
        }
    }
    async assertActiveOwner(jobId, runId, actor) {
        try {
            await this.runs.assertCurrentRunOwner(jobId, runId, actor.identityId);
        }
        catch (err) {
            if (err instanceof Error && "code" in err) {
                throw badRequest(String(err.code), err.message);
            }
            throw err;
        }
    }
    async assertIdle(clientId, projectKey) {
        try {
            await this.runs.assertIdleMutation(clientId, projectKey);
        }
        catch (err) {
            if (err instanceof Error && "code" in err) {
                throw badRequest(String(err.code), err.message);
            }
            throw err;
        }
    }
    // ── capability / models ──
    async capability(clientId) {
        const online = await this.clients.listOnline();
        const client = online.find((c) => c.clientId === clientId);
        if (!client) {
            return {
                available: false,
                code: "PI_CLIENT_DISCONNECTED",
                message: `Client "${clientId}" is offline or unknown`,
            };
        }
        return (client.capabilityDetails.pi ?? {
            available: false,
            code: "PI_CLIENT_UNSUPPORTED",
            message: "Client 版本不支持 Pi",
        });
    }
    async models(clientId, rootDir, relativePath) {
        await this.requirePiClient(clientId);
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        const data = await this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "models.list",
            cwdRef: { rootDir, relativePath },
        });
        return data.models;
    }
    // ── sessions ──
    async sessions(clientId, rootDir, relativePath) {
        await this.requirePiClient(clientId);
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        const data = await this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "sessions.list",
            cwdRef: { rootDir, relativePath },
        });
        return data.sessions;
    }
    async sessionDetail(clientId, sessionId, rootDir, relativePath) {
        await this.requirePiClient(clientId);
        return this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "session.get",
            cwdRef: { rootDir, relativePath },
            sessionId,
        });
    }
    async sessionContext(clientId, sessionId, rootDir, relativePath, leafId, cursor) {
        await this.requirePiClient(clientId);
        return this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "session.context",
            cwdRef: { rootDir, relativePath },
            sessionId,
            payload: {
                ...(leafId ? { leafId } : {}),
                ...(cursor ? { cursor } : {}),
            },
        });
    }
    async entryContent(clientId, sessionId, entryId, rootDir, relativePath, blockIndex) {
        await this.requirePiClient(clientId);
        return this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "session.entryContent",
            cwdRef: { rootDir, relativePath },
            sessionId,
            payload: {
                entryId,
                blockIndex: Number(blockIndex ?? 0),
            },
        });
    }
    async renameSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const { rootDir, relativePath, name } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (typeof name !== "string" || name.trim() === "") {
            throw badRequest("PI_PROTOCOL_INVALID", "name required");
        }
        // 从侧边栏对未打开的会话改名/删/克隆等：必须先把 Job 记录补上，再查 owner
        await this.runs.ensureSession(actor, { clientId, sessionId });
        await this.assertSessionOwner(sessionId, actor);
        await this.withReconciledClient(clientId, async (lease) => {
            const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
            await this.assertIdle(clientId, projectKey);
            await this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(),
                action: "session.rename",
                cwdRef: { rootDir, relativePath },
                sessionId,
                payload: { name },
            });
        });
        return { ok: true };
    }
    async deleteSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const cwdRef = requireCwd(body);
        return this.withReconciledClient(clientId, async (lease) => {
            await this.runs.ensureSession(actor, { clientId, sessionId });
            const reservation = await this.runs.beginDelete(sessionId, actor.identityId);
            let response;
            try {
                response = await this.requests.request(lease, {
                    requestId: (0, node_crypto_1.randomUUID)(), action: "session.delete", cwdRef, sessionId,
                });
            }
            catch (error) {
                const code = error instanceof Error && "code" in error
                    ? String(error.code)
                    : undefined;
                if (code === "PI_REQUEST_TIMEOUT" || code === "PI_CLIENT_DISCONNECTED") {
                    throw badRequest(code, error instanceof Error ? error.message : code);
                }
                throw error;
            }
            if (response.ok || response.error.code === "PI_SESSION_NOT_FOUND") {
                await this.runs.commitDelete(sessionId, reservation.deleteToken);
                return { ok: true };
            }
            if (["PI_PROTOCOL_INVALID", "PI_PROJECT_NOT_ALLOWED", "PI_PROJECT_BUSY"].includes(response.error.code)) {
                await this.runs.rollbackDelete(sessionId, reservation.deleteToken);
                throw badRequest(response.error.code, response.error.message);
            }
            let confirmation;
            try {
                confirmation = await this.requests.request(lease, {
                    requestId: (0, node_crypto_1.randomUUID)(), action: "session.get", cwdRef, sessionId,
                });
            }
            catch (error) {
                const code = error instanceof Error && "code" in error
                    ? String(error.code)
                    : undefined;
                if (code === "PI_REQUEST_TIMEOUT" || code === "PI_CLIENT_DISCONNECTED") {
                    throw badRequest(code, error instanceof Error ? error.message : code);
                }
                throw error;
            }
            if (!confirmation.ok && confirmation.error.code === "PI_SESSION_NOT_FOUND") {
                await this.runs.commitDelete(sessionId, reservation.deleteToken);
                return { ok: true };
            }
            if (confirmation.ok) {
                await this.runs.rollbackDelete(sessionId, reservation.deleteToken);
                throw badRequest(response.error.code, response.error.message);
            }
            throw badRequest(confirmation.error.code, confirmation.error.message);
        });
    }
    async forkSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const { rootDir, relativePath, messageId } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (typeof messageId !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "messageId required");
        }
        await this.assertSessionOwner(sessionId, actor);
        return this.withReconciledClient(clientId, async (lease) => {
            const cwdRef = { rootDir, relativePath };
            const projectKey = await this.resolveProjectKey(lease, cwdRef);
            await this.assertIdle(clientId, projectKey);
            const data = await this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(), action: "session.fork", cwdRef, sessionId,
                payload: { messageId },
            });
            return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
        });
    }
    async cloneSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const { rootDir, relativePath } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        await this.assertSessionOwner(sessionId, actor);
        return this.withReconciledClient(clientId, async (lease) => {
            const cwdRef = { rootDir, relativePath };
            const projectKey = await this.resolveProjectKey(lease, cwdRef);
            await this.assertIdle(clientId, projectKey);
            const data = await this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(), action: "session.clone", cwdRef, sessionId,
            });
            return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
        });
    }
    async navigateSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const { rootDir, relativePath, targetId } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (typeof targetId !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "targetId required");
        }
        await this.assertSessionOwner(sessionId, actor);
        return this.withReconciledClient(clientId, async (lease) => {
            const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
            await this.assertIdle(clientId, projectKey);
            return this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(),
                action: "session.navigate",
                cwdRef: { rootDir, relativePath },
                sessionId,
                payload: { targetId },
            });
        });
    }
    // ── agent ──
    async ensureCreatedSession(lease, actor, clientId, cwdRef, data) {
        const sessionId = data?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw badRequest("PI_PROTOCOL_INVALID", "Client returned invalid sessionId");
        }
        let original;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.runs.ensureSession(actor, { clientId, sessionId });
                return { sessionId, jobId: sessionId };
            }
            catch (error) {
                original ??= error;
            }
        }
        try {
            await this.requestOnce(lease, { requestId: (0, node_crypto_1.randomUUID)(), action: "session.delete", cwdRef, sessionId });
        }
        catch { /* best effort; timeout/disconnect remains uncertain */ }
        throw original;
    }
    async newSession(clientId, body, actor) {
        await this.requirePiClient(clientId);
        const cwdRef = requireCwd(body);
        return this.withReconciledClient(clientId, async (lease) => {
            const data = await this.requestOnce(lease, { requestId: (0, node_crypto_1.randomUUID)(), action: "session.new", cwdRef });
            return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
        });
    }
    async openSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const cwdRef = requireCwd(body);
        return this.withReconciledClient(clientId, async (lease) => {
            await this.requestOnce(lease, { requestId: (0, node_crypto_1.randomUUID)(), action: "session.get", cwdRef, sessionId });
            await this.runs.ensureSession(actor, { clientId, sessionId });
            const snapshot = await this.runs.snapshot(sessionId, actor.identityId);
            const agentState = (0, shared_1.parsePiAgentState)(await this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(), action: "agent.state", cwdRef, sessionId,
                jobId: snapshot.runId ? sessionId : undefined,
                runId: snapshot.runId ?? undefined,
            }));
            if (snapshot.runId)
                await this.runs.reconcileOpen(sessionId, snapshot.runId, agentState);
            return { job: await this.runs.snapshot(sessionId, actor.identityId), agentState };
        });
    }
    async completeSession(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const requestedRunId = optionalRunId(body);
        return this.withReconciledClient(clientId, async (lease) => {
            await this.runs.assertSessionOwner(sessionId, actor.identityId);
            const before = await this.runs.snapshot(sessionId, actor.identityId);
            if (requestedRunId && before.runId !== requestedRunId)
                throw new common_1.ConflictException({ code: "PI_CONTROL_FORBIDDEN", message: "Run is no longer current" });
            const runId = before.runId ?? requestedRunId;
            if ((before.status === "running" || before.status === "waiting_input") && runId) {
                await this.requestOnce(lease, { requestId: (0, node_crypto_1.randomUUID)(), action: "agent.abort", sessionId, jobId: sessionId, runId });
            }
            if (!await this.runs.completeSession(sessionId, runId)) {
                const current = await this.runs.snapshot(sessionId, actor.identityId);
                if (current.runId !== runId)
                    throw new common_1.ConflictException({ code: "PI_CONTROL_FORBIDDEN", message: "Session run changed during completion" });
            }
            return this.runs.snapshot(sessionId, actor.identityId);
        });
    }
    async agentState(clientId, sessionId, rootDir, relativePath) {
        await this.requirePiClient(clientId);
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        return this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "agent.state",
            cwdRef: { rootDir, relativePath },
            sessionId,
        });
    }
    async prompt(clientId, sessionId, body, actor) {
        await this.requirePiClient(clientId);
        const { rootDir, relativePath, type, submissionId } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (type !== "prompt") {
            throw badRequest("PI_PROTOCOL_INVALID", "type must be 'prompt'");
        }
        if (typeof submissionId !== "string" || submissionId.length === 0) {
            throw badRequest("PI_PROTOCOL_INVALID", "submissionId required");
        }
        if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
            throw badRequest("PI_PROTOCOL_INVALID", "prompt required");
        }
        return this.withReconciledClient(clientId, async (lease) => {
            const [projectKey] = await Promise.all([
                this.resolveProjectKey(lease, { rootDir, relativePath }),
                this.runs.ensureSession(actor, { clientId, sessionId }),
            ]);
            let run;
            try {
                run = await this.runs.startRun(actor, { clientId, sessionId, projectKey });
            }
            catch (err) {
                if (!isPiError(err) || err.code !== "PI_PROJECT_BUSY")
                    throw err;
                const previous = await this.runs.snapshot(sessionId, actor.identityId);
                if (!previous.runId)
                    throw new common_1.ConflictException({ code: err.code, message: err.message });
                const state = (0, shared_1.parsePiAgentState)(await this.requestOnce(lease, {
                    requestId: (0, node_crypto_1.randomUUID)(), action: "agent.state", cwdRef: { rootDir, relativePath },
                    sessionId, jobId: sessionId, runId: previous.runId,
                }));
                await this.runs.reconcileOpen(sessionId, previous.runId, state);
                try {
                    run = await this.runs.startRun(actor, { clientId, sessionId, projectKey });
                }
                catch (retryError) {
                    if (isPiError(retryError) && retryError.code === "PI_PROJECT_BUSY") {
                        throw new common_1.ConflictException({ code: retryError.code, message: retryError.message });
                    }
                    throw retryError;
                }
            }
            const { jobId, runId } = run;
            // 先发布 run_created（submissionId 绑定），再 dispatch，保证首个 Agent 事件不丢
            await this.events.publish({
                clientId,
                sessionId,
                jobId,
                runId,
                event: { type: "run_created", sessionId, submissionId, runId },
            });
            let dispatchError;
            try {
                const response = await this.requests.request(lease, {
                    requestId: (0, node_crypto_1.randomUUID)(),
                    action: "agent.prompt",
                    cwdRef: { rootDir, relativePath },
                    sessionId,
                    jobId,
                    runId,
                    payload: {
                        prompt: body.prompt,
                        submissionId,
                        ...(Array.isArray(body.images) && body.images.length > 0
                            ? { attachments: body.images }
                            : {}),
                    },
                });
                if (!response.ok) {
                    await this.runs.finishRun(jobId, runId);
                    dispatchError = badRequest(response.error.code, response.error.message);
                }
                else {
                    await this.runs.accept(jobId, runId);
                }
            }
            catch (error) {
                dispatchError = error;
                const code = error instanceof Error && "code" in error
                    ? String(error.code)
                    : undefined;
                if (code === "PI_CLIENT_DISCONNECTED") {
                    await this.runs.markRunDisconnected(jobId, runId);
                }
                else if (code === "PI_REQUEST_TIMEOUT") {
                    try {
                        const stateResponse = await this.requests.request(lease, {
                            requestId: (0, node_crypto_1.randomUUID)(), action: "agent.state",
                            cwdRef: { rootDir, relativePath }, sessionId, jobId, runId,
                        });
                        if (stateResponse.ok) {
                            const state = (0, shared_1.parsePiAgentState)(stateResponse.data);
                            if ((0, shared_1.isPiAgentIdle)(state)) {
                                await this.runs.finishRun(jobId, runId);
                            }
                            else {
                                await this.runs.accept(jobId, runId);
                                await this.runs.reconcileOpen(jobId, runId, state);
                            }
                        }
                    }
                    catch (stateError) {
                        if (stateError instanceof Error && "code" in stateError
                            && String(stateError.code) === "PI_CLIENT_DISCONNECTED") {
                            await this.runs.markRunDisconnected(jobId, runId);
                        }
                    }
                }
            }
            const current = await this.runs.snapshot(sessionId, actor.identityId);
            if (current.status === "done" || current.status === "cancelled") {
                try {
                    await this.requests.request(lease, {
                        requestId: (0, node_crypto_1.randomUUID)(), action: "agent.abort",
                        sessionId, jobId, runId,
                    });
                }
                catch { /* best effort: only the dispatched run is addressed */ }
                throw new common_1.ConflictException({
                    code: "PI_CONTROL_FORBIDDEN",
                    message: "Session completed while the prompt was dispatching",
                });
            }
            if (dispatchError)
                throw dispatchError;
            return { jobId, runId, sessionId };
        });
    }
    stream(clientId, sessionId) {
        // SSE 是 session 级；Observer 无需 Owner
        return this.events.stream(clientId, sessionId);
    }
    async running(clientId) {
        await this.requirePiClient(clientId);
        return this.runs.listActiveByClient(clientId);
    }
    // ── 图片附件（临时 Storage + FileRef） ──
    async createAttachments(clientId, body) {
        await this.requirePiClient(clientId);
        if (!Array.isArray(body.images) || body.images.length === 0) {
            throw badRequest("PI_PROTOCOL_INVALID", "images required");
        }
        const images = body.images.map((img) => {
            if (typeof img.filename !== "string" ||
                typeof img.size !== "number" ||
                typeof img.mimeType !== "string") {
                throw badRequest("PI_PROTOCOL_INVALID", "invalid image descriptor");
            }
            return { filename: img.filename, size: img.size, mimeType: img.mimeType };
        });
        return this.attachments.createPromptUploads(clientId, images);
    }
    async completeAttachment(clientId, attachmentId) {
        await this.requirePiClient(clientId);
        return this.attachments.completePromptUpload(attachmentId, clientId);
    }
    async deleteAttachment(clientId, attachmentId) {
        await this.requirePiClient(clientId);
        await this.attachments.deleteAttachment(attachmentId, clientId);
        return { ok: true };
    }
    // ── 活动回合控制（Owner only） ──
    async controlAction(clientId, sessionId, runId, action, actor, payload) {
        await this.requirePiClient(clientId);
        await this.assertActiveOwner(sessionId, runId, actor);
        return this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action,
            sessionId,
            jobId: sessionId,
            runId,
            ...(payload ? { payload } : {}),
        });
    }
    async steer(clientId, sessionId, body, actor) {
        const runId = requiredRunId(body);
        if (typeof body.message !== "string")
            throw badRequest("PI_PROTOCOL_INVALID", "message required");
        return this.controlAction(clientId, sessionId, runId, "agent.steer", actor, {
            message: body.message,
        });
    }
    async followUp(clientId, sessionId, body, actor) {
        const runId = requiredRunId(body);
        if (typeof body.message !== "string")
            throw badRequest("PI_PROTOCOL_INVALID", "message required");
        return this.controlAction(clientId, sessionId, runId, "agent.followUp", actor, {
            message: body.message,
        });
    }
    async abort(clientId, sessionId, body, actor) {
        const runId = requiredRunId(body);
        await this.requirePiClient(clientId);
        await this.assertActiveOwner(sessionId, runId, actor);
        await this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "agent.abort",
            sessionId,
            jobId: sessionId,
            runId,
        });
        await this.runs.finishRun(sessionId, runId);
        return { ok: true };
    }
    async compact(clientId, sessionId, body, actor) {
        const runId = requiredRunId(body);
        return this.controlAction(clientId, sessionId, runId, "agent.compact", actor, {
            ...(typeof body.customInstructions === "string"
                ? { customInstructions: body.customInstructions }
                : {}),
        });
    }
    async abortCompact(clientId, sessionId, body, actor) {
        return this.controlAction(clientId, sessionId, requiredRunId(body), "agent.abortCompact", actor);
    }
    async extensionResponse(clientId, sessionId, body, actor) {
        const runId = requiredRunId(body);
        if (typeof body.requestId !== "string")
            throw badRequest("PI_PROTOCOL_INVALID", "requestId required");
        await this.requirePiClient(clientId);
        await this.assertActiveOwner(sessionId, runId, actor);
        await this.requestForClient(clientId, {
            requestId: (0, node_crypto_1.randomUUID)(),
            action: "extension.respond",
            sessionId,
            jobId: sessionId,
            runId,
            payload: {
                requestId: body.requestId,
                ...(body.value !== undefined ? { value: body.value } : {}),
                ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
                ...(body.cancelled === true ? { cancelled: true } : {}),
            },
        });
        return { ok: true };
    }
    // ── 空闲项目操作（idle mutation lock） ──
    async idleAction(clientId, rootDir, relativePath, action, sessionId, payload, actor) {
        await this.requirePiClient(clientId);
        if (sessionId && actor)
            await this.assertSessionOwner(sessionId, actor);
        return this.withReconciledClient(clientId, async (lease) => {
            const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
            await this.assertIdle(clientId, projectKey);
            return this.requestOnce(lease, {
                requestId: (0, node_crypto_1.randomUUID)(),
                action,
                cwdRef: { rootDir, relativePath },
                ...(sessionId ? { sessionId } : {}),
                ...(payload ? { payload } : {}),
            });
        });
    }
    async setModel(clientId, sessionId, body, actor) {
        const { rootDir, relativePath, provider, modelId } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (typeof provider !== "string" || typeof modelId !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "provider/modelId required");
        }
        return this.idleAction(clientId, rootDir, relativePath, "model.set", sessionId, {
            provider,
            modelId,
        }, actor);
    }
    async setThinking(clientId, sessionId, body, actor) {
        const { rootDir, relativePath, level } = body;
        if (typeof rootDir !== "string" || typeof relativePath !== "string") {
            throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
        }
        if (!(0, shared_1.isPiThinkingLevel)(level)) {
            throw badRequest("PI_PROTOCOL_INVALID", "invalid thinking level");
        }
        return this.idleAction(clientId, rootDir, relativePath, "thinking.set", sessionId, {
            level,
        }, actor);
    }
};
exports.PiController = PiController;
__decorate([
    (0, common_1.Get)("capability"),
    __param(0, (0, common_1.Param)("clientId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "capability", null);
__decorate([
    (0, common_1.Get)("models"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Query)("rootDir")),
    __param(2, (0, common_1.Query)("relativePath")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "models", null);
__decorate([
    (0, common_1.Get)("sessions"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Query)("rootDir")),
    __param(2, (0, common_1.Query)("relativePath")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "sessions", null);
__decorate([
    (0, common_1.Get)("sessions/:sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Query)("rootDir")),
    __param(3, (0, common_1.Query)("relativePath")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "sessionDetail", null);
__decorate([
    (0, common_1.Get)("sessions/:sessionId/context"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Query)("rootDir")),
    __param(3, (0, common_1.Query)("relativePath")),
    __param(4, (0, common_1.Query)("leafId")),
    __param(5, (0, common_1.Query)("cursor")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "sessionContext", null);
__decorate([
    (0, common_1.Get)("sessions/:sessionId/entries/:entryId/content"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Param)("entryId")),
    __param(3, (0, common_1.Query)("rootDir")),
    __param(4, (0, common_1.Query)("relativePath")),
    __param(5, (0, common_1.Query)("blockIndex")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "entryContent", null);
__decorate([
    (0, common_1.Patch)("sessions/:sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "renameSession", null);
__decorate([
    (0, common_1.Delete)("sessions/:sessionId"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "deleteSession", null);
__decorate([
    (0, common_1.Post)("sessions/:sessionId/fork"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "forkSession", null);
__decorate([
    (0, common_1.Post)("sessions/:sessionId/clone"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "cloneSession", null);
__decorate([
    (0, common_1.Post)("sessions/:sessionId/navigate"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "navigateSession", null);
__decorate([
    (0, common_1.Post)("agent/new"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "newSession", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/open"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "openSession", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/complete"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "completeSession", null);
__decorate([
    (0, common_1.Get)("agent/:sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Query)("rootDir")),
    __param(3, (0, common_1.Query)("relativePath")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "agentState", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "prompt", null);
__decorate([
    (0, common_1.Sse)("agent/:sessionId/events"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PiController.prototype, "stream", null);
__decorate([
    (0, common_1.Get)("running"),
    __param(0, (0, common_1.Param)("clientId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "running", null);
__decorate([
    (0, common_1.Post)("attachments"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "createAttachments", null);
__decorate([
    (0, common_1.Post)("attachments/:attachmentId/complete"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("attachmentId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "completeAttachment", null);
__decorate([
    (0, common_1.Delete)("attachments/:attachmentId"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("attachmentId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "deleteAttachment", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/steer"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "steer", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/follow-up"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "followUp", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/abort"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "abort", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/compact"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "compact", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/abort-compact"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "abortCompact", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/extension-response"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "extensionResponse", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/model"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "setModel", null);
__decorate([
    (0, common_1.Post)("agent/:sessionId/thinking"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Param)("sessionId")),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object]),
    __metadata("design:returntype", Promise)
], PiController.prototype, "setThinking", null);
exports.PiController = PiController = __decorate([
    (0, common_1.Controller)("api/clients/:clientId/pi"),
    __param(0, (0, common_1.Inject)(pi_request_broker_js_1.PiRequestBroker)),
    __param(1, (0, common_1.Inject)(pi_event_broker_js_1.PiEventBroker)),
    __param(2, (0, common_1.Inject)(pi_run_service_js_1.PiRunService)),
    __param(3, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __param(4, (0, common_1.Inject)(pi_attachment_service_js_1.PiAttachmentService)),
    __metadata("design:paramtypes", [pi_request_broker_js_1.PiRequestBroker, pi_event_broker_js_1.PiEventBroker, pi_run_service_js_1.PiRunService, client_service_js_1.ClientService, pi_attachment_service_js_1.PiAttachmentService])
], PiController);
