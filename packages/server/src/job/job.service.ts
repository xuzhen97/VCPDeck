import { Inject, Injectable, Optional } from "@nestjs/common";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobLogService } from "./job-log.service.js";
import { JobStatus, type JobProgress } from "@vcpdeck/shared";
import {
	TAILNET_CAPABILITY,
	parseTailnetJobPayload,
	type TailnetJobPayload,
} from "@vcpdeck/shared";
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
import { TailnetKeyService } from "../tailnet/tailnet-key.service.js";
import { randomUUID } from "node:crypto";
import type { UploadTarget } from "@vcpdeck/shared";

/** 已脱离 Job 的 Agent 类型:通用 Job 入口一律排除。 */
const AGENT_JOB_TYPES = ["agent.session", "agent.run"];

/** 心跳租约宽限（ms）：心跳 5 秒一次，30 秒足以覆盖抖动与新派发的上报延迟。 */
const HEARTBEAT_LEASE_MS = 30_000;

/**
 * 首个在心跳里登记传输 Job 的 Client 版本。
 * 更老的 Client 只上报 exec（传输不在 executor 的 activeJobs 里），
 * 若也纳入对账，会把正在跑的长传输误判成孤儿 Job。
 */
const TRANSFER_LEASE_MIN_CLIENT_VERSION = "0.22.4";

/** 传输类 Job：仅当 Client 会登记租约时才纳入心跳对账。 */
const TRANSFER_JOB_TYPES = ["file.export", "file.import"];

/** 逐段比较 `major.minor.patch`（忽略预发布后缀），用于能力门槛判断。 */
function isVersionAtLeast(version: string, minimum: string): boolean {
	if (!version) return false;
	const parse = (value: string) =>
		value
			.split("-")[0]!
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const current = parse(version);
	const required = parse(minimum);
	for (let index = 0; index < 3; index++) {
		const left = current[index] ?? 0;
		const right = required[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

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

/** Job 输出 spool 目录（相对路径按 ADR-0014 锚定 VCPDECK_APP_DIR，版本目录外不漂移）。 */
const JOB_OUTPUT_BASE_DIR = "./data/job-outputs";

/** 解析 Job 输出 spool 根目录；绝对路径原样，相对路径锚定 appDir 或 cwd。 */
export function resolveJobOutputDir(
	appDir = process.env.VCPDECK_APP_DIR,
): string {
	return resolve(appDir || process.cwd(), JOB_OUTPUT_BASE_DIR);
}

@Injectable()
export class JobService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
    @Inject(FileService) private readonly fileService: FileService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() private readonly outputDir: string = resolveJobOutputDir(),
    // Job 诊断事件链（ADR-0054）；测试可省略，省略时只保留原有行为。
    @Optional() @Inject(JobLogService) private readonly jobLog?: JobLogService,
    // Tailnet 凭据预留/终结（ADR-0062）；测试可不传
    @Optional() @Inject(TailnetKeyService) private readonly tailnetKeys?: TailnetKeyService,
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
    await this.recordCreated(jobId, "file.import", payload, actor, null);

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
    // ADR-0049：Agent 专用 Job 类型已退役。历史行仍可读（列表按类型过滤），
    // 但不再接受新建，也不降级为普通 shell。
    if (AGENT_JOB_TYPES.includes(params.type)) {
      throw Object.assign(new Error("Agent job types are retired"), {
        code: "INVALID_JOB_TYPE",
        statusCode: 400,
      });
    }
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

    if (params.type === "tailnet.manage") {
      return this.createTailnetJob(params, actor, client);
    }
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
    await this.recordCreated(
      jobId,
      params.type,
      finalPayload,
      actor,
      params.timeout ?? null,
    );

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

  /** Tailnet 管理 Job：同机在途唯一 + 凭据原子预留，任一失败整体回滚。 */
  private async createTailnetJob(
    params: {
      clientId: string;
      type: string;
      payload: Record<string, unknown>;
    },
    actor: ActorContext,
    client: { id: string; capabilities: string },
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
    let payload: TailnetJobPayload;
    try {
      payload = parseTailnetJobPayload(params.payload);
    } catch (error) {
      throw Object.assign(new Error((error as Error).message), {
        code: "INVALID_JOB_PAYLOAD",
        statusCode: 400,
      });
    }
    if (!parseCapabilities(client.capabilities).includes(TAILNET_CAPABILITY)) {
      throw Object.assign(
        new Error(`Client "${params.clientId}" lacks "tailnet.manage" capability`),
        { code: "TAILNET_OPERATION_MISMATCH", statusCode: 400 },
      );
    }
    if (!this.tailnetKeys) {
      throw Object.assign(new Error("Tailnet 密钥服务不可用"), {
        code: "TAILNET_KEY_UNAVAILABLE",
        statusCode: 503,
      });
    }

    const jobId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      try {
        await tx.tailnetClientOperation.create({
          data: { clientId: params.clientId, jobId },
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") {
          throw Object.assign(new Error("该机器已有 Tailnet 管理任务在途"), {
            code: "TAILNET_OPERATION_BUSY",
            statusCode: 409,
          });
        }
        throw error;
      }
      if (payload.action === "ensure") {
        await this.tailnetKeys!.reserve(tx as never, payload.credentialId, jobId);
      }
      await tx.job.create({
        data: {
          id: jobId,
          clientId: params.clientId,
          type: params.type,
          status: "pending",
          payload: JSON.stringify(payload),
          timeout: null,
          createdByIdentityId: actor.identityId,
          createdByName: actor.displayName,
          createdVia: actor.source,
        },
      });
    });

    await this.recordCreated(
      jobId,
      params.type,
      payload as unknown as Record<string, unknown>,
      actor,
      null,
    );
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

  /**
   * Tailnet Job 的唯一终结入口：条件终结 Job、按是否已交付密钥结算凭据、
   * 删除机器占位。重复调用幂等（count=0 时仍清理残余占位）。
   */
  private async finalizeTailnet(
    jobId: string,
    status: "done" | "error" | "cancelled",
    result: Record<string, unknown> | null,
  ): Promise<{
    job: { id: string; clientId: string; createdAt: Date; finishedAt: Date | null } | null;
    changed: boolean;
  }> {
    const errorCode =
      typeof result?.errorCode === "string" ? result.errorCode : null;
    const errorMessage =
      typeof result?.errorMessage === "string"
        ? result.errorMessage.slice(0, 200)
        : null;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.job.updateMany({
        where: {
          id: jobId,
          status: { in: ["pending", "running", "waiting_input", "disconnected"] },
        },
        data: {
          status,
          result: result ? JSON.stringify(result) : null,
          errorCode: status === "error" ? errorCode : null,
          errorMessage: status === "error" ? errorMessage : null,
          finishedAt: new Date(),
        },
      });
      const credential = await tx.tailnetCredential.findFirst({
        where: { reservedJobId: jobId },
      });
      const outcome =
        !credential || credential.issuedAt === null
          ? "unused"
          : status === "done"
            ? "consumed"
            : "uncertain";
      await this.tailnetKeys?.settle(tx as never, jobId, outcome);
      await tx.tailnetClientOperation.deleteMany({ where: { jobId } });
      const job = await tx.job.findUnique({
        where: { id: jobId },
        select: { id: true, clientId: true, createdAt: true, finishedAt: true },
      });
      return { job, changed: updated.count > 0 };
    });
  }

  /** stdout/stderr 片段落盘（tee）；Job 不存在时静默忽略，不阻塞实时转发。 */
  async appendOutputRaw(jobId: string, text: string) {
    if (!text) return;
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    await mkdir(this.outputDir, { recursive: true });
    await appendFile(join(this.outputDir, `${jobId}.log`), text, "utf8");
  }

  /**
   * 读取 Job 输出 spool 全文；仅详情查询时调用。
   * 返回 null 表示 Job 不存在或没有输出文件。
   */
  async readJobOutput(jobId: string): Promise<string | null> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return null;
    try {
      return await readFile(join(this.outputDir, `${jobId}.log`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
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

    if (type === "tailnet.manage") {
      const finalized = await this.finalizeTailnet(
        jobId,
        effectiveStatus === "error" ? "error" : "done",
        result,
      );
      if (!finalized.job) throw new Error(`Job "${jobId}" not found`);
      if (finalized.changed) {
        await this.recordSettled(finalized.job, result, effectiveStatus);
      }
      return this.scheduler.onFinished(finalized.job.clientId);
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
    await this.recordSettled(job, result, effectiveStatus);
    return this.scheduler.onFinished(job.clientId);
  }

  async markCancelled(jobId: string): Promise<DispatchPayload | null> {
    const existing = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (existing?.type === "tailnet.manage") {
      const finalized = await this.finalizeTailnet(jobId, "cancelled", null);
      if (!finalized.job) return null;
      if (finalized.changed) {
        await this.jobLog?.record({
          jobId,
          event: "cancel_confirmed",
          source: "server",
          data: { by: "server", fromStatus: existing.status },
        });
      }
      return this.scheduler.onFinished(finalized.job.clientId);
    }
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    await this.jobLog?.record({
      jobId,
      event: "cancel_confirmed",
      source: "server",
      data: {
        durationMs: Math.max(
          0,
          (job.finishedAt ?? new Date()).getTime() - job.createdAt.getTime(),
        ),
      },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  /**
   * 客户端确认它已不再持有该 Job（收到 JOB_CANCEL_FAILED，reason `Job not found`）时收尾。
   *
   * 典型来源：Client 换代/重启后内存里的 Job 映射丢失，此后再没人会上报它的终态。
   * 不在此收尾，它会永久停在 running/disconnected：占住该 Client 的并发槽
   * （MAX_CONCURRENT_JOBS），并让发布 drain 永远等不到收敛 —— 发版被它自己卡死
   * （2026-10-10 生产：两条 17 小时的 exec Job 阻塞了整个发布）。
   *
   * 返回该 Client 可继续派发的载荷（若有）。
   */
  async failOrphaned(
    jobId: string,
    reason: string,
  ): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return null;
    if (
      job.status !== "running" &&
      job.status !== "waiting_input" &&
      job.status !== "disconnected"
    ) {
      // 已是终态（或 pending 由 cancel 直接处理）→ 不覆盖既有结果。
      return null;
    }
    if (job.type === "tailnet.manage") {
      await this.finalizeTailnet(jobId, "error", {
        errorCode: "JOB_ORPHANED",
        errorMessage: reason.slice(0, 200),
      });
      await this.jobLog?.record({
        jobId,
        event: "orphaned",
        source: "server",
        level: "error",
        code: "JOB_ORPHANED",
        message: reason.slice(0, 200),
        data: { fromStatus: job.status },
      });
      return this.scheduler.onFinished(job.clientId);
    }
    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: "error",
        finishedAt: new Date(),
        errorCode: "JOB_ORPHANED",
        errorMessage: reason.slice(0, 200),
      },
    });
    await this.jobLog?.record({
      jobId,
      event: "orphaned",
      source: "server",
      level: "error",
      code: "JOB_ORPHANED",
      message: reason.slice(0, 200),
      data: { fromStatus: job.status },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  /**
   * 用心跳租约对账：Client 在线且心跳新鲜，但它的 `runningJobs` 已不再包含某条
   * `running` Job 时，判定该 Job 已在 Client 侧丢失（Client 换代、进程重启、
   * 内存映射丢失），按 `JOB_ORPHANED` 收尾并返回可继续派发的载荷。
   *
   * 心跳每 5 秒上报一次，`HEARTBEAT_LEASE_MS` 同时用于两条判据：
   * 1. 心跳本身超过该时长未更新 → 不做判断（离线收敛负责）；
   * 2. Job 刚派发时心跳还没带上它 → 留一个宽限期再判，避免误杀新 Job。
   *
   * 不做这一步时，僵尸 `running` Job 会永久占住并发槽，并让发布 drain 等到
   * 10 分钟超时、把版本号作废（2026-11-06 生产事故）。
   */
  async reconcileOrphanedJobs(now = Date.now()): Promise<DispatchPayload[]> {
    const clients = await this.prisma.client.findMany({
      where: { online: true },
      select: { id: true, runningJobs: true, lastHeartbeatAt: true, clientVersion: true },
    });
    const dispatches: DispatchPayload[] = [];
    for (const client of clients) {
      const heartbeatAt = client.lastHeartbeatAt?.getTime() ?? 0;
      if (now - heartbeatAt > HEARTBEAT_LEASE_MS) continue;
      const reported = new Set<string>(safeJsonParse<string[]>(client.runningJobs, []));
      // 老版本 Client 不上报传输租约：对它们只看非传输 Job，否则会误杀长传输
      const leasesTransfers = isVersionAtLeast(
        client.clientVersion,
        TRANSFER_LEASE_MIN_CLIENT_VERSION,
      );
      const jobs = await this.prisma.job.findMany({
        where: {
          clientId: client.id,
          status: "running",
          ...(leasesTransfers ? {} : { type: { notIn: TRANSFER_JOB_TYPES } }),
        },
        select: { id: true, startedAt: true, createdAt: true },
      });
      for (const job of jobs) {
        if (reported.has(job.id)) continue;
        const since = (job.startedAt ?? job.createdAt).getTime();
        if (now - since < HEARTBEAT_LEASE_MS) continue;
        const next = await this.failOrphaned(
          job.id,
          "Client 心跳未上报该 Job，判定为已在客户端丢失",
        );
        if (next) dispatches.push(next);
      }
    }
    return dispatches;
  }

  async markDisconnected(clientId: string) {
    // 先取受影响的 Job 再收敛：updateMany 不返回行，事件链需要逐 Job 留证。
    const affected = await this.prisma.job.findMany({
      where: { clientId, status: { in: ["running", "waiting_input"] } },
      select: { id: true, status: true },
    });
    await this.prisma.job.updateMany({
      where: { clientId, status: { in: ["running", "waiting_input"] } },
      data: { status: "disconnected" },
    });
    for (const job of affected) {
      await this.jobLog?.record({
        jobId: job.id,
        event: "client_offline",
        source: "server",
        level: "warn",
        data: { fromStatus: job.status },
      });
    }
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
          await this.jobLog?.record({
            jobId: r.jobId,
            event: "reconciled",
            source: "server",
            data: { reportedStatus: r.status, previousStatus: job.status },
          });
        }
      } else {
        const newStatus = r.status === "done" ? "done" : "error";
        if (job.type === "tailnet.manage") {
          await this.finalizeTailnet(r.jobId, newStatus, {
            exitCode: r.exitCode ?? 1,
          });
        } else {
          await this.prisma.job.update({
            where: { id: r.jobId },
            data: {
              status: newStatus,
              result: JSON.stringify({ exitCode: r.exitCode ?? 1 }),
              finishedAt: new Date(),
            },
          });
        }
        await this.jobLog?.record({
          jobId: r.jobId,
          event: "reconciled",
          source: "server",
          level: newStatus === "error" ? "warn" : "info",
          data: { reportedStatus: r.status, previousStatus: job.status },
        });
        const d = await this.scheduler.onFinished(clientId);
        if (d) dispatches.push(d);
      }
    }

    return dispatches;
  }

  async cancel(jobId: string, actor: ActorContext): Promise<{
    cancelled: boolean;
    needsDispatch: boolean;
    clientId?: string;
  }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job "${jobId}" not found`);
    if (AGENT_JOB_TYPES.includes(job.type)) {
      throw Object.assign(
        new Error("Agent sessions are not controllable as jobs"),
        { code: "INVALID_JOB_TYPE" },
      );
    }

    // 取消者必须进持久化审计：此前 actor 被丢弃，事后无法回答"谁取消的"。
    if (
      job.status === "pending" ||
      job.status === "waiting_input" ||
      job.status === "running" ||
      job.status === "disconnected"
    ) {
      await this.jobLog?.record({
        jobId,
        event: "cancel_requested",
        source: "server",
        data: {
          actor: actor.displayName,
          via: actor.source,
          fromStatus: job.status,
          requestId: actor.requestId,
        },
      });
    }

    if (job.status === "pending" || job.status === "waiting_input") {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      // 待派发阶段由 Server 直接终结：补一条终态事件，避免链上只剩 cancel_requested。
      await this.jobLog?.record({
        jobId,
        event: "cancel_confirmed",
        source: "server",
        data: { by: "server", fromStatus: job.status },
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
    status?: JobStatus | "active";
    page?: number;
    pageSize?: number;
  } = {}): Promise<PaginatedResult<JobInfo>> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
    const where: Record<string, unknown> = {};
    if (options.clientId) where.clientId = options.clientId;
    // ADR-0049:Agent 专用能力已退役;历史遗留行与存量 agent.run
    // 不得再出现在通用 Job 列表或统计中(只保留最小退役数据过滤)。
    where.type = { notIn: AGENT_JOB_TYPES };
    if (options.status === "active") {
      where.status = { in: ["pending", "running", "waiting_input"] };
      // 与基础 Agent 排除合并,不能覆盖:否则 active 视图会重新混入 Agent。
      where.type = {
        notIn: [
          ...AGENT_JOB_TYPES,
          "file.roots",
          "file.list",
          "file.stat",
          "file.readText",
          "frp.list",
        ],
      };
    } else if (options.status) {
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

  async findById(jobId: string): Promise<JobInfo | null> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        client: {
          select: { hostname: true, name: true },
        },
      },
    });
    if (!job) return null;
    return toJobInfo(job);
  }

  /** `job:log` 相位上报的归属校验：返回 Job 所属 clientId，不存在返回 null。 */
  async findOwnerClientId(jobId: string): Promise<string | null> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { clientId: true },
    });
    return job?.clientId ?? null;
  }

  /** 记录 Job 出生事件：只放标识与模式，绝不放命令、脚本或参数正文。 */
  private async recordCreated(
    jobId: string,
    type: string,
    payload: Record<string, unknown>,
    actor: ActorContext,
    timeoutMs: number | null,
  ): Promise<void> {
    if (!this.jobLog) return;
    const mode = typeof payload.mode === "string" ? payload.mode : undefined;
    await this.jobLog.record({
      jobId,
      event: "created",
      source: "server",
      data: {
        via: actor.source,
        actor: actor.displayName,
        type,
        ...(mode ? { mode } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        requestId: actor.requestId,
      },
    });
  }

  /** 记录终态事件：附带耗时与输出字节数，便于区分"没输出"与"输出后卡住"。 */
  private async recordSettled(
    job: { id: string; createdAt: Date; finishedAt: Date | null },
    result: Record<string, unknown>,
    status: string,
  ): Promise<void> {
    if (!this.jobLog) return;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const exitCode =
      typeof result.exitCode === "number" ? result.exitCode : undefined;
    const errorCode =
      typeof result.errorCode === "string" ? result.errorCode : undefined;
    const errorMessage =
      typeof result.errorMessage === "string" ? result.errorMessage : undefined;
    const finishedAt = job.finishedAt ?? new Date();
    await this.jobLog.record({
      jobId: job.id,
      event: "settled",
      source: "server",
      level: status === "error" ? "error" : "info",
      ...(errorCode ? { code: errorCode } : {}),
      ...(errorMessage ? { message: errorMessage.slice(0, 200) } : {}),
      data: {
        status,
        durationMs: Math.max(0, finishedAt.getTime() - job.createdAt.getTime()),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(errorCode ? { errorCode } : {}),
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        spoolBytes: await this.spoolBytes(job.id),
      },
    });
  }

  /** Job 输出 spool 的落盘字节数；无文件视为 0。 */
  private async spoolBytes(jobId: string): Promise<number> {
    try {
      const info = await stat(join(this.outputDir, `${jobId}.log`));
      return info.size;
    } catch {
      return 0;
    }
  }
}

/** Job payload 安全投影：reconcile 仅公开 allowlist 字段；frp.create 剥离 frpsInfo.authToken。 */
function projectPublicPayload(type: string, rawPayload: unknown): Record<string, unknown> {
	const payload = (rawPayload ?? {}) as Record<string, unknown>;
	if (type === "frp.reconcile") {
		const projection: Record<string, unknown> = {};
		if (typeof payload.attempt === "number") projection.attempt = payload.attempt;
		if (Array.isArray(payload.mappings)) projection.mappingCount = payload.mappings.length;
		if (typeof payload.connectionGeneration === "string")
			projection.connectionGeneration = payload.connectionGeneration;
		if (typeof payload.expectedRuntimeGeneration === "number")
			projection.expectedRuntimeGeneration = payload.expectedRuntimeGeneration;
		return projection;
	}
	if (type === "frp.create" || type === "frp.delete") {
		const frpsInfo = payload.frpsInfo;
		if (frpsInfo && typeof frpsInfo === "object" && !Array.isArray(frpsInfo)) {
			const { authToken: _removed, ...rest } = frpsInfo as Record<string, unknown>;
			return { ...payload, frpsInfo: rest };
		}
	}
	return payload;
}

function toJobInfo(j: {
  id: string;
  clientId: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  progress: string | null;
  timeout: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdByIdentityId: string | null;
  createdByName: string | null;
  createdVia: string | null;
  client: { hostname: string; name: string | null } | null;
}): JobInfo {
  return {
    jobId: j.id,
    clientId: j.clientId,
    clientName: j.client?.name ?? j.client?.hostname ?? null,
    type: j.type,
    status: j.status as JobStatus,
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
