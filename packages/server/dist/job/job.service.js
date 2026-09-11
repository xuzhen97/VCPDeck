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
exports.JobService = void 0;
exports.resolveJobOutputDir = resolveJobOutputDir;
const common_1 = require("@nestjs/common");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const prisma_service_js_1 = require("../prisma/prisma.service.js");
const job_scheduler_js_1 = require("./job.scheduler.js");
const shared_1 = require("@vcpdeck/shared");
const file_service_js_1 = require("../file/file.service.js");
const storage_service_js_1 = require("../storage/storage.service.js");
const node_crypto_1 = require("node:crypto");
const FILE_READ_TYPES = ["file.list", "file.stat", "file.readText", "file.export", "file.roots"];
const FILE_WRITE_TYPES = [
    "file.writeText",
    "file.mkdir",
    "file.delete",
    "file.move",
    "file.import",
];
function parseCapabilities(raw) {
    if (Array.isArray(raw))
        return raw;
    if (typeof raw === "string") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    return [];
}
function safeJsonParse(raw, fallback) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** 解析 progress JSON，无效返回 null */
function parseProgress(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.loaded === "number" && typeof parsed.total === "number") {
            return { loaded: parsed.loaded, total: parsed.total };
        }
    }
    catch {
        // 无效 JSON 按无进度处理
    }
    return null;
}
/** Job 输出 spool 目录（相对路径按 ADR-0014 锚定 VCPDECK_APP_DIR，版本目录外不漂移）。 */
const JOB_OUTPUT_BASE_DIR = "./data/job-outputs";
/** 解析 Job 输出 spool 根目录；绝对路径原样，相对路径锚定 appDir 或 cwd。 */
function resolveJobOutputDir(appDir = process.env.VCPDECK_APP_DIR) {
    return (0, node_path_1.resolve)(appDir || process.cwd(), JOB_OUTPUT_BASE_DIR);
}
let JobService = class JobService {
    prisma;
    scheduler;
    fileService;
    storage;
    outputDir;
    constructor(prisma, scheduler, fileService, storage, outputDir = resolveJobOutputDir()) {
        this.prisma = prisma;
        this.scheduler = scheduler;
        this.fileService = fileService;
        this.storage = storage;
        this.outputDir = outputDir;
    }
    /** 创建等待浏览器上传的文件导入会话。 */
    async createUploadSession(input, actor) {
        const client = await this.prisma.client.findUnique({
            where: { id: input.clientId },
        });
        if (!client) {
            throw Object.assign(new Error(`Client "${input.clientId}" not found — register the client first`), { code: "CLIENT_NOT_FOUND" });
        }
        if (!client.online) {
            throw Object.assign(new Error(`Client "${input.clientId}" is offline`), {
                code: "CLIENT_OFFLINE",
            });
        }
        const caps = parseCapabilities(client.capabilities);
        if (!caps.includes("file.write")) {
            throw Object.assign(new Error(`Client "${input.clientId}" lacks "file.write" capability`), { code: "CAPABILITY_MISSING" });
        }
        if (typeof input.rootDir !== "string" ||
            input.rootDir.trim() === "" ||
            typeof input.targetPath !== "string" ||
            input.targetPath.trim() === "" ||
            typeof input.filename !== "string" ||
            input.filename.trim() === "") {
            throw Object.assign(new Error("rootDir, targetPath and filename are required"), {
                code: "INVALID_UPLOAD_SESSION",
            });
        }
        if (!Number.isFinite(input.size) || !Number.isInteger(input.size) || input.size < 0) {
            throw Object.assign(new Error("size must be a non-negative integer"), {
                code: "INVALID_UPLOAD_SESSION",
            });
        }
        if (input.mimeType !== undefined && typeof input.mimeType !== "string") {
            throw Object.assign(new Error("mimeType must be a string"), {
                code: "INVALID_UPLOAD_SESSION",
            });
        }
        const jobId = (0, node_crypto_1.randomUUID)();
        const pending = await this.fileService.createPending(jobId, input.clientId, {
            jobId,
            clientId: input.clientId,
            filename: input.filename,
            size: input.size,
            mimeType: input.mimeType,
        });
        const backend = await this.storage.getBackendConfig();
        const payload = {
            rootDir: input.rootDir,
            targetPath: input.targetPath,
            fileId: pending.fileId,
            overwrite: input.overwrite === true,
            storageKind: backend.kind,
        };
        await this.prisma.job.create({
            data: {
                id: jobId,
                clientId: input.clientId,
                type: "file.import",
                status: "waiting_input",
                payload: JSON.stringify(payload),
                timeout: null,
                createdByIdentityId: actor.identityId,
                createdByName: actor.displayName,
                createdVia: actor.source,
            },
        });
        let upload;
        if (backend.kind === "alibaba") {
            const session = await this.storage.createDirectUploadSession(input.size, input.filename, pending.fileId);
            upload = { kind: "direct", ...session };
        }
        else {
            upload = {
                kind: "proxy",
                url: pending.uploadUrl,
                expiresAt: pending.expiresAt,
            };
        }
        return {
            jobId,
            fileId: pending.fileId,
            status: shared_1.JobStatus.WAITING_INPUT,
            upload,
        };
    }
    /** 确认 Storage 上传并激活文件导入 Job。 */
    async completeUploadSession(jobId, body) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job) {
            throw Object.assign(new Error(`Upload session "${jobId}" not found`), {
                code: "UPLOAD_SESSION_NOT_FOUND",
            });
        }
        if (job.type !== "file.import") {
            throw Object.assign(new Error(`Job "${jobId}" is not a file import`), {
                code: "INVALID_UPLOAD_SESSION",
            });
        }
        if (job.status === "cancelled") {
            throw Object.assign(new Error(`Upload session "${jobId}" was cancelled`), {
                code: "UPLOAD_SESSION_CANCELLED",
            });
        }
        const activeStatuses = new Set([
            "pending",
            "running",
            "done",
            "error",
            "disconnected",
        ]);
        if (activeStatuses.has(job.status)) {
            return {
                result: {
                    jobId,
                    status: job.status,
                    type: job.type,
                },
                dispatch: null,
            };
        }
        if (job.status !== "waiting_input") {
            throw Object.assign(new Error(`Invalid upload session status "${job.status}"`), {
                code: "INVALID_UPLOAD_SESSION",
            });
        }
        const payload = safeJsonParse(job.payload, {});
        if (!payload.fileId) {
            throw Object.assign(new Error("Upload session file is missing"), {
                code: "FILE_NOT_READY",
            });
        }
        const file = await this.fileService.findById(payload.fileId);
        if (!file) {
            throw Object.assign(new Error("Upload session file is missing"), {
                code: "FILE_NOT_READY",
            });
        }
        const backend = await this.storage.getBackendConfig();
        if (backend.kind === "alibaba") {
            // 直连后端：浏览器已完成分片直传，Server 校验字节数并合并分片
            if (typeof body?.uploadedBytes !== "number") {
                throw Object.assign(new Error("uploadedBytes is required"), {
                    code: "SIZE_MISMATCH",
                });
            }
            await this.storage.completeDirectUploadSession(payload.fileId, body.uploadedBytes);
        }
        else if (file.status !== "completed") {
            throw Object.assign(new Error("File upload is not complete"), {
                code: "FILE_NOT_READY",
            });
        }
        const download = await this.fileService.createDownloadToken(payload.fileId);
        const finalPayload = {
            ...payload,
            downloadRef: {
                id: payload.fileId,
                key: file.key,
                url: download.downloadUrl,
                method: "GET",
                expiresAt: 0,
                direct: backend.kind === "alibaba",
            },
            size: download.size,
        };
        await this.prisma.job.update({
            where: { id: jobId },
            data: {
                status: "pending",
                payload: JSON.stringify(finalPayload),
                progress: JSON.stringify({ loaded: 0, total: download.size }),
            },
        });
        const dispatch = await this.scheduler.tryDispatch(job.clientId);
        return {
            result: {
                jobId,
                status: dispatch?.jobId === jobId ? shared_1.JobStatus.RUNNING : shared_1.JobStatus.PENDING,
                type: job.type,
            },
            dispatch,
        };
    }
    async create(params, actor) {
        const client = await this.prisma.client.findUnique({
            where: { id: params.clientId },
        });
        if (!client) {
            throw new Error(`Client "${params.clientId}" not found — register the client first`);
        }
        if (!client.online) {
            throw new Error(`Client "${params.clientId}" is offline`);
        }
        // Capability 校验
        const caps = parseCapabilities(client.capabilities);
        if (FILE_READ_TYPES.includes(params.type) && !caps.includes("file.read")) {
            throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.read" capability`), { statusCode: 400 });
        }
        if (FILE_WRITE_TYPES.includes(params.type) && !caps.includes("file.write")) {
            throw Object.assign(new Error(`Client "${params.clientId}" lacks "file.write" capability`), { statusCode: 400 });
        }
        const jobId = (0, node_crypto_1.randomUUID)();
        // 文件传输编排
        let finalPayload = { ...params.payload };
        if (params.type === "file.export") {
            const p = params.payload;
            const { fileId, key, uploadUrl, expiresAt } = await this.fileService.createPending(jobId, params.clientId, {
                jobId,
                clientId: params.clientId,
                filename: p.path.split(/[/\\]/).pop() || "file",
                size: 0,
            });
            const backend = await this.storage.getBackendConfig();
            if (backend.kind === "alibaba") {
                // 直连后端：Client stat 文件后协商直传会话（size 未知，无法预创建分片任务）
                finalPayload = {
                    ...finalPayload,
                    uploadRef: {
                        id: fileId,
                        key,
                        url: "",
                        method: "PUT",
                        expiresAt: 0,
                        direct: true,
                    },
                };
            }
            else {
                finalPayload = {
                    ...finalPayload,
                    uploadRef: {
                        id: fileId,
                        key,
                        url: uploadUrl,
                        method: "PUT",
                        expiresAt,
                    },
                };
            }
        }
        else if (params.type === "file.import") {
            const p = params.payload;
            const dl = await this.fileService.createDownloadToken(p.fileId);
            const backend = await this.storage.getBackendConfig();
            finalPayload = {
                ...finalPayload,
                downloadRef: {
                    id: p.fileId,
                    key: "",
                    url: dl.downloadUrl,
                    method: "GET",
                    expiresAt: 0,
                    direct: backend.kind === "alibaba",
                },
                size: dl.size,
            };
        }
        await this.prisma.job.create({
            data: {
                id: jobId,
                clientId: params.clientId,
                type: params.type,
                status: "pending",
                payload: JSON.stringify(finalPayload),
                timeout: params.timeout ?? null,
                createdByIdentityId: actor.identityId,
                createdByName: actor.displayName,
                createdVia: actor.source,
            },
        });
        const dispatch = await this.scheduler.tryDispatch(params.clientId);
        return {
            result: {
                jobId,
                status: dispatch ? shared_1.JobStatus.RUNNING : shared_1.JobStatus.PENDING,
                type: params.type,
            },
            dispatch,
        };
    }
    /** stdout/stderr 片段落盘（tee）；Job 不存在时静默忽略，不阻塞实时转发。 */
    async appendOutputRaw(jobId, text) {
        if (!text)
            return;
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job)
            return;
        await (0, promises_1.mkdir)(this.outputDir, { recursive: true });
        await (0, promises_1.appendFile)((0, node_path_1.join)(this.outputDir, `${jobId}.log`), text, "utf8");
    }
    /**
     * 读取 Job 输出 spool 全文；仅详情查询时调用。
     * 返回 null 表示 Job 不存在或没有输出文件。
     */
    async readJobOutput(jobId) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job)
            return null;
        try {
            return await (0, promises_1.readFile)((0, node_path_1.join)(this.outputDir, `${jobId}.log`), "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
    }
    /** 更新 job 传输段进度（file.export 上传时由 client 上报） */
    async updateProgress(jobId, loaded, total) {
        await this.prisma.job.update({
            where: { id: jobId },
            data: { progress: JSON.stringify({ loaded, total }) },
        });
    }
    async markDone(jobId, type, result) {
        let effectiveStatus;
        if (result?.errorCode) {
            effectiveStatus = "error";
        }
        else if (type === "exec" && result?.exitCode !== 0 && result?.exitCode !== undefined) {
            effectiveStatus = "error";
        }
        else {
            effectiveStatus = "done";
        }
        const job = await this.prisma.job.update({
            where: { id: jobId },
            data: {
                status: effectiveStatus,
                result: JSON.stringify(result),
                errorCode: result.errorCode ?? null,
                errorMessage: result.errorMessage ?? null,
                finishedAt: new Date(),
            },
        });
        return this.scheduler.onFinished(job.clientId);
    }
    async markCancelled(jobId) {
        const job = await this.prisma.job.update({
            where: { id: jobId },
            data: { status: "cancelled", finishedAt: new Date() },
        });
        return this.scheduler.onFinished(job.clientId);
    }
    async markDisconnected(clientId) {
        await this.prisma.job.updateMany({
            where: { clientId, status: { in: ["running", "waiting_input"] } },
            data: { status: "disconnected" },
        });
    }
    async reconcileOnReconnect(clientId, report) {
        const dispatches = [];
        for (const r of report.jobs) {
            const job = await this.prisma.job.findUnique({
                where: { id: r.jobId },
            });
            if (!job || job.clientId !== clientId)
                continue;
            if (r.status === "running" || r.status === "waiting_input") {
                if (job.status === "disconnected" ||
                    job.status === "running" ||
                    job.status === "waiting_input") {
                    await this.prisma.job.update({
                        where: { id: r.jobId },
                        data: { status: r.status },
                    });
                }
            }
            else {
                const newStatus = r.status === "done" ? "done" : "error";
                await this.prisma.job.update({
                    where: { id: r.jobId },
                    data: {
                        status: newStatus,
                        result: JSON.stringify({ exitCode: r.exitCode ?? 1 }),
                        finishedAt: new Date(),
                    },
                });
                const d = await this.scheduler.onFinished(clientId);
                if (d)
                    dispatches.push(d);
            }
        }
        return dispatches;
    }
    async cancel(jobId, _actor) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job)
            throw new Error(`Job "${jobId}" not found`);
        if (job.status === "pending" || job.status === "waiting_input") {
            await this.prisma.job.update({
                where: { id: jobId },
                data: { status: "cancelled", finishedAt: new Date() },
            });
            return { cancelled: true, needsDispatch: false };
        }
        if (job.status === "running" || job.status === "disconnected") {
            return { cancelled: false, needsDispatch: true, clientId: job.clientId };
        }
        throw new Error(`Cannot cancel job in status "${job.status}"`);
    }
    async list(options = {}) {
        const page = Math.max(1, options.page ?? 1);
        const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
        const where = {};
        if (options.clientId)
            where.clientId = options.clientId;
        if (options.status === "active") {
            where.status = { in: ["pending", "running", "waiting_input"] };
            where.type = {
                notIn: [
                    "file.roots",
                    "file.list",
                    "file.stat",
                    "file.readText",
                    "frp.list",
                ],
            };
        }
        else if (options.status) {
            where.status = options.status;
        }
        const [jobs, total] = await Promise.all([
            this.prisma.job.findMany({
                where,
                include: {
                    client: {
                        select: { hostname: true, name: true },
                    },
                },
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.job.count({ where }),
        ]);
        return {
            data: jobs.map(toJobInfo),
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    async findById(jobId) {
        const job = await this.prisma.job.findUnique({
            where: { id: jobId },
            include: {
                client: {
                    select: { hostname: true, name: true },
                },
            },
        });
        if (!job)
            return null;
        return toJobInfo(job);
    }
};
exports.JobService = JobService;
exports.JobService = JobService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(prisma_service_js_1.PrismaService)),
    __param(1, (0, common_1.Inject)(job_scheduler_js_1.JobScheduler)),
    __param(2, (0, common_1.Inject)(file_service_js_1.FileService)),
    __param(3, (0, common_1.Inject)(storage_service_js_1.StorageService)),
    __param(4, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_js_1.PrismaService, job_scheduler_js_1.JobScheduler, file_service_js_1.FileService, storage_service_js_1.StorageService, String])
], JobService);
/** Job payload 安全投影：reconcile 仅公开 allowlist 字段；frp.create 剥离 frpsInfo.authToken。 */
function projectPublicPayload(type, rawPayload) {
    const payload = (rawPayload ?? {});
    if (type === "frp.reconcile") {
        const projection = {};
        if (typeof payload.attempt === "number")
            projection.attempt = payload.attempt;
        if (Array.isArray(payload.mappings))
            projection.mappingCount = payload.mappings.length;
        if (typeof payload.connectionGeneration === "string")
            projection.connectionGeneration = payload.connectionGeneration;
        if (typeof payload.expectedRuntimeGeneration === "number")
            projection.expectedRuntimeGeneration = payload.expectedRuntimeGeneration;
        return projection;
    }
    if (type === "frp.create" || type === "frp.delete") {
        const frpsInfo = payload.frpsInfo;
        if (frpsInfo && typeof frpsInfo === "object" && !Array.isArray(frpsInfo)) {
            const { authToken: _removed, ...rest } = frpsInfo;
            return { ...payload, frpsInfo: rest };
        }
    }
    return payload;
}
function toJobInfo(j) {
    return {
        jobId: j.id,
        clientId: j.clientId,
        clientName: j.client?.name ?? j.client?.hostname ?? null,
        type: j.type,
        status: j.status,
        payload: projectPublicPayload(j.type, safeJsonParse(j.payload, {})),
        result: j.result ? safeJsonParse(j.result, null) : null,
        progress: parseProgress(j.progress),
        timeout: j.timeout,
        errorCode: j.errorCode,
        errorMessage: j.errorMessage,
        createdAt: j.createdAt.toISOString(),
        startedAt: j.startedAt?.toISOString() ?? null,
        finishedAt: j.finishedAt?.toISOString() ?? null,
        createdByIdentityId: j.createdByIdentityId ?? null,
        createdByName: j.createdByName ?? null,
        createdVia: j.createdVia ?? null,
    };
}
