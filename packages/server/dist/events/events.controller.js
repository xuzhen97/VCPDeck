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
exports.EventsController = void 0;
const common_1 = require("@nestjs/common");
const job_service_js_1 = require("../job/job.service.js");
const client_psk_js_1 = require("../client/client-psk.js");
const client_service_js_1 = require("../client/client.service.js");
const client_gateway_js_1 = require("./client.gateway.js");
const storage_service_js_1 = require("../storage/storage.service.js");
const actor_decorator_js_1 = require("../auth/actor.decorator.js");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const INVALID_JOB_PAYLOAD = "INVALID_JOB_PAYLOAD";
function normalizeAndValidateExecPayload(payload) {
    const mode = payload.mode;
    const command = payload.command;
    const executable = payload.executable;
    const args = payload.args;
    const script = payload.script;
    const cwd = payload.cwd;
    // ── 旧 payload 兼容：缺少 mode 且存在 command → command 模式 ──
    if (mode === undefined && command !== undefined) {
        const normalized = { mode: "command", command };
        if (cwd !== undefined)
            normalized.cwd = cwd;
        return normalized;
    }
    // ── command 模式 ──
    if (mode === "command") {
        if (command === undefined || typeof command !== "string" || command === "") {
            throw Object.assign(new Error("command must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
        }
        if (executable !== undefined || args !== undefined || script !== undefined) {
            throw Object.assign(new Error("command mode must not include executable/args/script"), { code: INVALID_JOB_PAYLOAD });
        }
        const normalized = { mode: "command", command };
        if (cwd !== undefined) {
            if (typeof cwd !== "string" || cwd === "")
                throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
            normalized.cwd = cwd;
        }
        return normalized;
    }
    // ── script 模式 ──
    if (mode === "script") {
        if (executable === undefined || typeof executable !== "string" || executable === "") {
            throw Object.assign(new Error("executable must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
        }
        if (!Array.isArray(args)) {
            throw Object.assign(new Error("args must be an array of strings"), { code: INVALID_JOB_PAYLOAD });
        }
        if (args.some((a) => typeof a !== "string")) {
            throw Object.assign(new Error("args must be an array of strings"), { code: INVALID_JOB_PAYLOAD });
        }
        if (script === undefined || typeof script !== "string") {
            throw Object.assign(new Error("script must be a string"), { code: INVALID_JOB_PAYLOAD });
        }
        if (command !== undefined) {
            throw Object.assign(new Error("script mode must not include command"), { code: INVALID_JOB_PAYLOAD });
        }
        const normalized = { mode: "script", executable, args, script };
        if (cwd !== undefined) {
            if (typeof cwd !== "string" || cwd === "")
                throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
            normalized.cwd = cwd;
        }
        return normalized;
    }
    // ── 非法 mode ──
    throw Object.assign(new Error(`Unknown exec mode: ${mode}`), { code: INVALID_JOB_PAYLOAD });
}
let EventsController = class EventsController {
    jobService;
    clientService;
    gateway;
    storageService;
    assertClientPsk(value) {
        if (!value || value !== (0, client_psk_js_1.clientPsk)()) {
            throw new common_1.UnauthorizedException({
                code: "CLIENT_AUTH_REQUIRED",
                message: "Client authentication required",
            });
        }
    }
    constructor(jobService, clientService, gateway, storageService) {
        this.jobService = jobService;
        this.clientService = clientService;
        this.gateway = gateway;
        this.storageService = storageService;
    }
    health() {
        return { ok: true };
    }
    /** 创建 Client 专用导出直传会话。 */
    async createClientExportSession(psk, body) {
        this.assertClientPsk(psk);
        return this.createExportSession(body);
    }
    /** 完成 Client 专用导出直传。 */
    async completeClientExportSession(jobId, psk, body) {
        this.assertClientPsk(psk);
        return this.completeExportSession(jobId, body);
    }
    /** 续期 Client 专用导出会话的指定分片 URL。 */
    async refreshClientExportPartUrls(jobId, psk, body) {
        this.assertClientPsk(psk);
        const partNumbers = body?.partNumbers;
        if (!Array.isArray(partNumbers) ||
            partNumbers.length === 0 ||
            partNumbers.some((value) => !Number.isInteger(value) || value <= 0) ||
            new Set(partNumbers).size !== partNumbers.length) {
            throw new common_1.BadRequestException({
                code: "INVALID_PART_NUMBERS",
                message: "partNumbers must contain unique positive integers",
            });
        }
        return this.storageService.refreshDirectPartUrls(jobId, partNumbers);
    }
    async createJob(body, actor) {
        let result = null;
        let dispatch = null;
        try {
            const type = body.type || "exec";
            let payload = body.payload || {};
            // ── 仅对 exec 类型做校验与规范化 ──
            if (type === "exec") {
                try {
                    payload = normalizeAndValidateExecPayload(payload);
                }
                catch (e) {
                    throw new common_1.BadRequestException({ code: e.code || INVALID_JOB_PAYLOAD, message: e.message });
                }
            }
            // ── timeout 校验 ──
            if (body.timeout !== undefined) {
                if (typeof body.timeout !== "number" || !Number.isFinite(body.timeout) || body.timeout <= 0 || !Number.isInteger(body.timeout)) {
                    throw new common_1.BadRequestException({ code: INVALID_JOB_PAYLOAD, message: "timeout must be a positive integer" });
                }
            }
            const r = await this.jobService.create({
                clientId: body.clientId,
                type,
                payload,
                timeout: body.timeout,
            }, actor);
            result = r.result;
            dispatch = r.dispatch;
        }
        catch (e) {
            throw new common_1.BadRequestException(e.message || e);
        }
        if (dispatch) {
            this.gateway.sendDispatch(dispatch);
        }
        return result;
    }
    /** 创建浏览器直传 Storage 的文件上传会话。 */
    async createUploadSession(body, actor) {
        try {
            return await this.jobService.createUploadSession(body, actor);
        }
        catch (e) {
            throw new common_1.BadRequestException({
                code: e.code ?? "INVALID_UPLOAD_SESSION",
                message: e.message ?? String(e),
            });
        }
    }
    /** 完成 Storage 上传并激活远程文件导入 Job。 */
    async completeUploadSession(jobId, body) {
        try {
            const { result, dispatch } = await this.jobService.completeUploadSession(jobId, body);
            if (dispatch)
                this.gateway.sendDispatch(dispatch);
            return result;
        }
        catch (e) {
            throw new common_1.BadRequestException({
                code: e.code ?? "UPLOAD_SESSION_INVALID",
                message: e.message ?? String(e),
            });
        }
    }
    /** 创建导出直传会话（Client stat 文件后协商分片 URL）。 */
    async createExportSession(body) {
        const jobId = body?.jobId;
        const size = body?.size;
        if (typeof jobId !== "string" || jobId === "" || !Number.isInteger(size) || (size ?? 0) < 0) {
            throw new common_1.BadRequestException({
                code: "INVALID_EXPORT_SESSION",
                message: "jobId and size are required",
            });
        }
        return this.storageService.createExportSession(jobId, size);
    }
    /** 完成导出直传并返回真实 storage key。 */
    async completeExportSession(jobId, body) {
        const uploadedBytes = body?.uploadedBytes;
        if (!Number.isInteger(uploadedBytes) || (uploadedBytes ?? 0) < 0) {
            throw new common_1.BadRequestException({
                code: "INVALID_EXPORT_SESSION",
                message: "uploadedBytes is required",
            });
        }
        return this.storageService.completeExportUpload(jobId, uploadedBytes);
    }
    /** 续期上传会话指定分片的直传 URL。 */
    async refreshPartUrls(jobId, body) {
        const partNumbers = body?.partNumbers;
        if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
            throw new common_1.BadRequestException({
                code: "INVALID_PART_NUMBERS",
                message: "partNumbers is required",
            });
        }
        return this.storageService.refreshDirectPartUrls(jobId, partNumbers);
    }
    /** 直传分片进度上报（节流由前端控制）。 */
    async updateProgress(jobId, body) {
        const loaded = body?.loaded;
        if (!Number.isFinite(loaded) || (loaded ?? 0) < 0) {
            throw new common_1.BadRequestException({
                code: "INVALID_PROGRESS",
                message: "loaded is required",
            });
        }
        await this.storageService.updateUploadProgress(jobId, loaded);
    }
    async cancelJob(jobId, actor) {
        const { cancelled, needsDispatch, clientId } = await this.jobService.cancel(jobId, actor);
        if (cancelled) {
            return { jobId, status: "cancelled" };
        }
        if (needsDispatch && clientId) {
            this.gateway.sendCancel(clientId, jobId);
            return { jobId, status: "cancelling" };
        }
        throw new Error("Unexpected cancel state");
    }
    async listClients() {
        return this.clientService.listOnline();
    }
    /** 修改客户端别名（全局唯一，改名后机器重连不会覆盖） */
    async renameClient(clientId, name) {
        if (typeof name !== "string" || name.trim() === "") {
            throw new common_1.BadRequestException({
                code: client_service_js_1.INVALID_CLIENT_NAME,
                message: "name must be a non-empty string",
            });
        }
        try {
            return await this.clientService.rename(clientId, name);
        }
        catch (error) {
            const { code, statusCode, message } = error;
            if (!code || !statusCode)
                throw error;
            throw new common_1.HttpException({ code, message }, statusCode);
        }
    }
    async listJobs(clientId, status, page, pageSize) {
        return this.jobService.list({
            clientId,
            status: status,
            page: page ? Math.max(1, parseInt(page, 10)) : undefined,
            pageSize: pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
        });
    }
    async getJob(jobId) {
        const job = await this.jobService.findById(jobId);
        if (!job)
            throw new common_1.NotFoundException(`Job "${jobId}" not found`);
        return job;
    }
    /** Job 输出 spool 全文；仅详情诊断时调用，不进入列表路径。 */
    async getJobOutput(jobId) {
        const job = await this.jobService.findById(jobId);
        if (!job)
            throw new common_1.NotFoundException(`Job "${jobId}" not found`);
        const output = await this.jobService.readJobOutput(jobId);
        return { jobId, output };
    }
};
exports.EventsController = EventsController;
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Get)("health"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], EventsController.prototype, "health", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Post)("files/client-export-sessions"),
    __param(0, (0, common_1.Headers)("x-vcpdeck-psk")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "createClientExportSession", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Post)("files/client-export-sessions/:jobId/complete"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Headers)("x-vcpdeck-psk")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "completeClientExportSession", null);
__decorate([
    (0, public_decorator_js_1.Public)(),
    (0, common_1.Post)("files/client-export-sessions/:jobId/part-urls"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Headers)("x-vcpdeck-psk")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "refreshClientExportPartUrls", null);
__decorate([
    (0, common_1.Post)("jobs"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "createJob", null);
__decorate([
    (0, common_1.Post)("files/upload-sessions"),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "createUploadSession", null);
__decorate([
    (0, common_1.Post)("files/upload-sessions/:jobId/complete"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "completeUploadSession", null);
__decorate([
    (0, common_1.Post)("files/export-sessions"),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "createExportSession", null);
__decorate([
    (0, common_1.Post)("files/export-sessions/:jobId/complete"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "completeExportSession", null);
__decorate([
    (0, common_1.Post)("files/upload-sessions/:jobId/part-urls"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "refreshPartUrls", null);
__decorate([
    (0, common_1.Post)("files/upload-sessions/:jobId/progress"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "updateProgress", null);
__decorate([
    (0, common_1.Post)("jobs/:jobId/cancel"),
    __param(0, (0, common_1.Param)("jobId")),
    __param(1, (0, actor_decorator_js_1.Actor)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "cancelJob", null);
__decorate([
    (0, common_1.Get)("clients"),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "listClients", null);
__decorate([
    (0, common_1.Patch)("clients/:clientId/name"),
    __param(0, (0, common_1.Param)("clientId")),
    __param(1, (0, common_1.Body)("name")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "renameClient", null);
__decorate([
    (0, common_1.Get)("jobs"),
    __param(0, (0, common_1.Query)("clientId")),
    __param(1, (0, common_1.Query)("status")),
    __param(2, (0, common_1.Query)("page")),
    __param(3, (0, common_1.Query)("pageSize")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "listJobs", null);
__decorate([
    (0, common_1.Get)("jobs/:jobId"),
    __param(0, (0, common_1.Param)("jobId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "getJob", null);
__decorate([
    (0, common_1.Get)("jobs/:jobId/output"),
    __param(0, (0, common_1.Param)("jobId")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], EventsController.prototype, "getJobOutput", null);
exports.EventsController = EventsController = __decorate([
    (0, common_1.Controller)("api"),
    __param(0, (0, common_1.Inject)(job_service_js_1.JobService)),
    __param(1, (0, common_1.Inject)(client_service_js_1.ClientService)),
    __param(2, (0, common_1.Inject)(client_gateway_js_1.ClientGateway)),
    __param(3, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __metadata("design:paramtypes", [job_service_js_1.JobService, client_service_js_1.ClientService, client_gateway_js_1.ClientGateway, storage_service_js_1.StorageService])
], EventsController);
