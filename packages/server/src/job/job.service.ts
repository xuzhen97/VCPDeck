import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobStatus, type JobProgress } from "@vcpdeck/shared";
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
  ActorContext,
  PaginatedResult,
  FileUploadSession,
  FileUploadSessionCreate,
} from "@vcpdeck/shared";
import { FileService } from "../file/file.service.js";
import { StorageService } from "../storage/storage.service.js";
import { randomUUID } from "node:crypto";
import type { UploadTarget } from "@vcpdeck/shared";

const FILE_READ_TYPES = ["file.list", "file.stat", "file.readText", "file.export", "file.roots"];
const FILE_WRITE_TYPES = [
	"file.writeText",
	"file.mkdir",
	"file.delete",
	"file.move",
	"file.import",
];

function parseCapabilities(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw as string[];
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as string[];
		} catch {
			return [];
		}
	}
	return [];
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 解析 progress JSON，无效返回 null */
function parseProgress(raw: string | null): JobProgress | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<JobProgress>;
    if (typeof parsed.loaded === "number" && typeof parsed.total === "number") {
      return { loaded: parsed.loaded, total: parsed.total };
    }
  } catch {
    // 无效 JSON 按无进度处理
  }
  return null;
}

@Injectable()
export class JobService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
    @Inject(FileService) private readonly fileService: FileService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** 创建等待浏览器上传的文件导入会话。 */
  async createUploadSession(
    input: FileUploadSessionCreate,
    actor: ActorContext,
  ): Promise<FileUploadSession> {
    const client = await this.prisma.client.findUnique({
      where: { id: input.clientId },
    });
    if (!client) {
      throw Object.assign(
        new Error(`Client "${input.clientId}" not found — register the client first`),
        { code: "CLIENT_NOT_FOUND" },
      );
    }
    if (!client.online) {
      throw Object.assign(new Error(`Client "${input.clientId}" is offline`), {
        code: "CLIENT_OFFLINE",
      });
    }

    const caps = parseCapabilities(client.capabilities);
    if (!caps.includes("file.write")) {
      throw Object.assign(
        new Error(`Client "${input.clientId}" lacks "file.write" capability`),
        { code: "CAPABILITY_MISSING" },
      );
    }
    if (
      typeof input.rootDir !== "string" ||
      input.rootDir.trim() === "" ||
      typeof input.targetPath !== "string" ||
      input.targetPath.trim() === "" ||
      typeof input.filename !== "string" ||
      input.filename.trim() === ""
    ) {
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

    const jobId = randomUUID();
    const pending = await this.fileService.createPending(jobId, input.clientId, {
      jobId,
      clientId: input.clientId,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
    });
    const payload = {
      rootDir: input.rootDir,
      targetPath: input.targetPath,
      fileId: pending.fileId,
      overwrite: input.overwrite === true,
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

    const backend = await this.storage.getBackendConfig();
    let upload: UploadTarget;
    if (backend.kind === "alibaba") {
      const session = await this.storage.createDirectUploadSession(
            input.size,
            input.filename,
            pending.fileId,
      );
      upload = { kind: "direct", ...session };
    } else {
      upload = {
            kind: "proxy",
            url: pending.uploadUrl,
            expiresAt: pending.expiresAt,
      };
    }

    return {
      jobId,
      fileId: pending.fileId,
      status: JobStatus.WAITING_INPUT,
      upload,
    };
  }

  /** 确认 Storage 上传并激活文件导入 Job。 */
  async completeUploadSession(
    jobId: string,
    body?: { uploadedBytes?: number },
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
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
          status: job.status as JobStatus,
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

    const payload = safeJsonParse<{
      rootDir?: string;
      targetPath?: string;
      fileId?: string;
      overwrite?: boolean;
    }>(job.payload, {});
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
      await this.storage.completeDirectUploadSession(
        payload.fileId,
        body.uploadedBytes,
      );
    } else if (file.status !== "completed") {
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
        method: "GET" as const,
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
        status:
          dispatch?.jobId === jobId ? JobStatus.RUNNING : JobStatus.PENDING,
        type: job.type,
      },
      dispatch,
    };
  }

  async create(
    params: {
      clientId: string;
      type: string;
      payload: Record<string, unknown>;
      timeout?: number;
    },
    actor: ActorContext,
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
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
      throw Object.assign(
        new Error(`Client "${params.clientId}" lacks "file.read" capability`),
        { statusCode: 400 },
      );
    }
    if (FILE_WRITE_TYPES.includes(params.type) && !caps.includes("file.write")) {
      throw Object.assign(
        new Error(`Client "${params.clientId}" lacks "file.write" capability`),
        { statusCode: 400 },
      );
    }

    const jobId = randomUUID();

    // 文件传输编排
    let finalPayload = { ...params.payload };
    if (params.type === "file.export") {
      const p = params.payload as { path: string; rootDir: string };
      const { fileId, key, uploadUrl, expiresAt } =
        await this.fileService.createPending(jobId, params.clientId, {
          jobId,
          clientId: params.clientId,
          filename:
            p.path.split(/[/\\]/).pop() || "file",
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
            method: "PUT" as const,
            expiresAt: 0,
            direct: true,
          },
        };
      } else {
        finalPayload = {
          ...finalPayload,
          uploadRef: {
            id: fileId,
            key,
            url: uploadUrl,
            method: "PUT" as const,
            expiresAt,
          },
        };
      }
    } else if (params.type === "file.import") {
      const p = params.payload as {
        targetPath: string;
        rootDir: string;
        fileId: string;
      };
      const dl = await this.fileService.createDownloadToken(p.fileId);
      const backend = await this.storage.getBackendConfig();
      finalPayload = {
        ...finalPayload,
        downloadRef: {
          id: p.fileId,
          key: "",
          url: dl.downloadUrl,
          method: "GET" as const,
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
        status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING,
        type: params.type,
      },
      dispatch,
    };
  }

  async appendOutputRaw(jobId: string, _text: string) {
    // ponytail: stdout/stderr 暂不持久化，仅实时转发。后续加 output spool 时在此实现。
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
  }

  /** 更新 job 传输段进度（file.export 上传时由 client 上报） */
  async updateProgress(
    jobId: string,
    loaded: number,
    total: number,
  ): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { progress: JSON.stringify({ loaded, total }) },
    });
  }

  async markDone(
    jobId: string,
    type: string,
    result: Record<string, unknown>,
  ): Promise<DispatchPayload | null> {
    let effectiveStatus: string;

    if (result?.errorCode) {
      effectiveStatus = "error";
    } else if (type === "exec" && (result as any)?.exitCode !== 0 && (result as any)?.exitCode !== undefined) {
      effectiveStatus = "error";
    } else {
      effectiveStatus = "done";
    }

    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: effectiveStatus,
        result: JSON.stringify(result),
        errorCode: (result.errorCode as string) ?? null,
        errorMessage: (result.errorMessage as string) ?? null,
        finishedAt: new Date(),
      },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markCancelled(jobId: string): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markDisconnected(clientId: string) {
    await this.prisma.job.updateMany({
      where: { clientId, status: { in: ["running", "waiting_input"] } },
      data: { status: "disconnected" },
    });
  }

  async reconcileOnReconnect(
    clientId: string,
    report: StatusReport,
  ): Promise<DispatchPayload[]> {
    const dispatches: DispatchPayload[] = [];

    for (const r of report.jobs) {
      const job = await this.prisma.job.findUnique({
        where: { id: r.jobId },
      });
      if (!job || job.clientId !== clientId) continue;

      if (r.status === "running" || r.status === "waiting_input") {
        if (
          job.status === "disconnected" ||
          job.status === "running" ||
          job.status === "waiting_input"
        ) {
          await this.prisma.job.update({
            where: { id: r.jobId },
            data: { status: r.status },
          });
        }
      } else {
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
        if (d) dispatches.push(d);
      }
    }

    return dispatches;
  }

  async cancel(jobId: string, _actor: ActorContext): Promise<{ // ponytail: actor 预留，后续 cancel 时记录到 JobEvent
    cancelled: boolean;
    needsDispatch: boolean;
    clientId?: string;
  }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job "${jobId}" not found`);

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

  async list(options: {
    clientId?: string;
    status?: JobStatus;
    page?: number;
    pageSize?: number;
  } = {}): Promise<PaginatedResult<JobInfo>> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    const where: Record<string, unknown> = {};
    if (options.clientId) where.clientId = options.clientId;
    if (options.status) where.status = options.status;

    const [jobs, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        include: {
          client: {
            select: { hostname: true },
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

  async findById(jobId: string): Promise<JobInfo | null> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        client: {
          select: { hostname: true },
        },
      },
    });
    if (!job) return null;
    return toJobInfo(job);
  }
}

function toJobInfo(j: {
  id: string;
  clientId: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  progress: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdByIdentityId: string | null;
  createdByName: string | null;
  createdVia: string | null;
  client: { hostname: string } | null;
}): JobInfo {
  return {
    jobId: j.id,
    clientId: j.clientId,
    clientName: j.client?.hostname ?? null,
    type: j.type,
    status: j.status as JobStatus,
    payload: safeJsonParse(j.payload, {}),
    result: j.result ? safeJsonParse(j.result, null) : null,
    progress: parseProgress(j.progress),
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
