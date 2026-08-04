import {
  BadRequestException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  Get,
  Body,
  Param,
  Query,
} from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { ClientGateway } from "./client.gateway.js";
import { Actor } from "../auth/actor.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type {
  JobCreate,
  DispatchPayload,
  ActorContext,
  JobStatus,
  FileUploadSessionCreate,
} from "@vcpdeck/shared";

const INVALID_JOB_PAYLOAD = "INVALID_JOB_PAYLOAD";

function normalizeAndValidateExecPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const mode = payload.mode;
  const command = payload.command;
  const executable = payload.executable;
  const args = payload.args;
  const script = payload.script;
  const cwd = payload.cwd;

  // ── 旧 payload 兼容：缺少 mode 且存在 command → command 模式 ──
  if (mode === undefined && command !== undefined) {
    const normalized: Record<string, unknown> = { mode: "command", command };
    if (cwd !== undefined) normalized.cwd = cwd;
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
    const normalized: Record<string, unknown> = { mode: "command", command };
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd === "") throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
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
    const normalized: Record<string, unknown> = { mode: "script", executable, args, script };
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || cwd === "") throw Object.assign(new Error("cwd must be a non-empty string"), { code: INVALID_JOB_PAYLOAD });
      normalized.cwd = cwd;
    }
    return normalized;
  }

  // ── 非法 mode ──
  throw Object.assign(new Error(`Unknown exec mode: ${mode}`), { code: INVALID_JOB_PAYLOAD });
}

@Controller("api")
export class EventsController {
  constructor(
    @Inject(JobService) private readonly jobService: JobService,
    @Inject(ClientService) private readonly clientService: ClientService,
    @Inject(ClientGateway) private readonly gateway: ClientGateway,
  ) {}

  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }

  @Post("jobs")
  async createJob(@Body() body: JobCreate, @Actor() actor: ActorContext) {
    let result: { jobId: string; status: string; type: string } | null = null;
    let dispatch: DispatchPayload | null = null;
    try {
      const type = body.type || "exec";
      let payload = body.payload || {};

      // ── 仅对 exec 类型做校验与规范化 ──
      if (type === "exec") {
        try {
          payload = normalizeAndValidateExecPayload(payload);
        } catch (e: any) {
          throw new BadRequestException({ code: e.code || INVALID_JOB_PAYLOAD, message: e.message });
        }
      }

      // ── timeout 校验 ──
      if (body.timeout !== undefined) {
        if (typeof body.timeout !== "number" || !Number.isFinite(body.timeout) || body.timeout <= 0 || !Number.isInteger(body.timeout)) {
          throw new BadRequestException({ code: INVALID_JOB_PAYLOAD, message: "timeout must be a positive integer" });
        }
      }

      const r = await this.jobService.create(
        {
          clientId: body.clientId,
          type,
          payload,
          timeout: body.timeout,
        },
        actor,
      );
      result = r.result;
      dispatch = r.dispatch;
    } catch (e: any) {
      throw new BadRequestException(e.message || e);
    }
    if (dispatch) {
      this.gateway.sendDispatch(dispatch);
    }
    return result;
  }

  /** 创建浏览器直传 Storage 的文件上传会话。 */
  @Post("files/upload-sessions")
  async createUploadSession(
    @Body() body: FileUploadSessionCreate,
    @Actor() actor: ActorContext,
  ) {
    try {
      return await this.jobService.createUploadSession(body, actor);
    } catch (e: any) {
      throw new BadRequestException({
        code: e.code ?? "INVALID_UPLOAD_SESSION",
        message: e.message ?? String(e),
      });
    }
  }

  /** 完成 Storage 上传并激活远程文件导入 Job。 */
  @Post("files/upload-sessions/:jobId/complete")
  async completeUploadSession(@Param("jobId") jobId: string) {
    try {
      const { result, dispatch } =
        await this.jobService.completeUploadSession(jobId);
      if (dispatch) this.gateway.sendDispatch(dispatch);
      return result;
    } catch (e: any) {
      throw new BadRequestException({
        code: e.code ?? "UPLOAD_SESSION_INVALID",
        message: e.message ?? String(e),
      });
    }
  }

  @Post("jobs/:jobId/cancel")
  async cancelJob(@Param("jobId") jobId: string, @Actor() actor: ActorContext) {
    const { cancelled, needsDispatch, clientId } =
      await this.jobService.cancel(jobId, actor);
    if (cancelled) {
      return { jobId, status: "cancelled" };
    }
    if (needsDispatch && clientId) {
      this.gateway.sendCancel(clientId, jobId);
      return { jobId, status: "cancelling" };
    }
    throw new Error("Unexpected cancel state");
  }

  @Get("clients")
  async listClients() {
    return this.clientService.listOnline();
  }

  @Get("jobs")
  async listJobs(
    @Query("clientId") clientId?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.jobService.list({
      clientId,
      status: status as JobStatus | undefined,
      page: page ? Math.max(1, parseInt(page, 10)) : undefined,
      pageSize: pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
    });
  }

  @Get("jobs/:jobId")
  async getJob(@Param("jobId") jobId: string) {
    const job = await this.jobService.findById(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found`);
    return job;
  }
}
