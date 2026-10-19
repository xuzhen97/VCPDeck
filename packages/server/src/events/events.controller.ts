import {
  Optional,
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  Get,
  Patch,
  Put,
  Body,
  Param,
  Query,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { JobService } from "../job/job.service.js";
import { JobLogService } from "../job/job-log.service.js";
import { clientPsk } from "../client/client-psk.js";
import {
  ClientService,
  INVALID_CLIENT_ANNOTATIONS,
  INVALID_CLIENT_NAME,
  INVALID_DSH_WEB_URL,
} from "../client/client.service.js";
import { ClientGateway } from "./client.gateway.js";
import { DshWebService } from "../dsh-web/dsh-web.service.js";
import { StorageService } from "../storage/storage.service.js";
import { Actor } from "../auth/actor.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type {
  JobCreate,
  DispatchPayload,
  ActorContext,
  JobStatus,
  FileUploadSessionCreate,
  ClientAnnotationsInput,
} from "@vcpdeck/shared";
import { JOB_LOG_LEVELS, type JobLogLevel } from "@vcpdeck/shared";
import { parseClientAnnotationsInput, parseClientDshWebUrl } from "@vcpdeck/shared";

const INVALID_JOB_PAYLOAD = "INVALID_JOB_PAYLOAD";

/** 解析注解输入；非法输入统一映射为 400。 */
function parseAnnotationsOrThrow(value: unknown): ClientAnnotationsInput {
  try {
    return parseClientAnnotationsInput(value);
  } catch (error) {
    throw new BadRequestException({
      code: INVALID_CLIENT_ANNOTATIONS,
      message: (error as Error).message,
    });
  }
}

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
	private assertClientPsk(value: string | undefined): void {
		if (!value || value !== clientPsk()) {
			throw new UnauthorizedException({
				code: "CLIENT_AUTH_REQUIRED",
				message: "Client authentication required",
			});
		}
	}
	constructor(
		@Inject(JobService) private readonly jobService: JobService,
		@Inject(JobLogService) private readonly jobLogService: JobLogService,
		@Inject(ClientService) private readonly clientService: ClientService,
		@Inject(ClientGateway) private readonly gateway: ClientGateway,
		@Inject(StorageService) private readonly storageService: StorageService,
		@Optional()
		@Inject(DshWebService)
		private readonly dshWebService?: DshWebService,
	) {}

  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }

  	/** 创建 Client 专用导出直传会话。 */
	@Public()
	@Post("files/client-export-sessions")
	async createClientExportSession(
		@Headers("x-vcpdeck-psk") psk: string | undefined,
		@Body() body: { jobId?: string; size?: number },
	) {
		this.assertClientPsk(psk);
		return this.createExportSession(body);
	}

	/** 完成 Client 专用导出直传。 */
	@Public()
	@Post("files/client-export-sessions/:jobId/complete")
	async completeClientExportSession(
		@Param("jobId") jobId: string,
		@Headers("x-vcpdeck-psk") psk: string | undefined,
		@Body() body: { uploadedBytes?: number },
	) {
		this.assertClientPsk(psk);
		return this.completeExportSession(jobId, body);
	}

	/** 续期 Client 专用导出会话的指定分片 URL。 */
	@Public()
	@Post("files/client-export-sessions/:jobId/part-urls")
	async refreshClientExportPartUrls(
		@Param("jobId") jobId: string,
		@Headers("x-vcpdeck-psk") psk: string | undefined,
		@Body() body: { partNumbers?: number[] },
	) {
		this.assertClientPsk(psk);
		const partNumbers = body?.partNumbers;
		if (
			!Array.isArray(partNumbers) ||
			partNumbers.length === 0 ||
			partNumbers.some((value) => !Number.isInteger(value) || value <= 0) ||
			new Set(partNumbers).size !== partNumbers.length
		) {
			throw new BadRequestException({
				code: "INVALID_PART_NUMBERS",
				message: "partNumbers must contain unique positive integers",
			});
		}
		return this.storageService.refreshDirectPartUrls(jobId, partNumbers);
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
  async completeUploadSession(
    @Param("jobId") jobId: string,
    @Body() body: { uploadedBytes?: number },
  ) {
    try {
      const { result, dispatch } = await this.jobService.completeUploadSession(
        jobId,
        body,
      );
      if (dispatch) this.gateway.sendDispatch(dispatch);
      return result;
    } catch (e: any) {
      throw new BadRequestException({
        code: e.code ?? "UPLOAD_SESSION_INVALID",
        message: e.message ?? String(e),
      });
    }
  }

  /** 创建导出直传会话（Client stat 文件后协商分片 URL）。 */
  @Post("files/export-sessions")
  async createExportSession(@Body() body: { jobId?: string; size?: number }) {
    const jobId = body?.jobId;
    const size = body?.size;
    if (typeof jobId !== "string" || jobId === "" || !Number.isInteger(size) || (size ?? 0) < 0) {
      throw new BadRequestException({
        code: "INVALID_EXPORT_SESSION",
        message: "jobId and size are required",
      });
    }
    return this.storageService.createExportSession(jobId, size as number);
  }

  /** 完成导出直传并返回真实 storage key。 */
  @Post("files/export-sessions/:jobId/complete")
  async completeExportSession(
    @Param("jobId") jobId: string,
    @Body() body: { uploadedBytes?: number },
  ) {
    const uploadedBytes = body?.uploadedBytes;
    if (!Number.isInteger(uploadedBytes) || (uploadedBytes ?? 0) < 0) {
      throw new BadRequestException({
        code: "INVALID_EXPORT_SESSION",
        message: "uploadedBytes is required",
      });
    }
    return this.storageService.completeExportUpload(jobId, uploadedBytes as number);
  }

  /** 续期上传会话指定分片的直传 URL。 */
  @Post("files/upload-sessions/:jobId/part-urls")
  async refreshPartUrls(
    @Param("jobId") jobId: string,
    @Body() body: { partNumbers?: number[] },
  ) {
    const partNumbers = body?.partNumbers;
    if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
      throw new BadRequestException({
        code: "INVALID_PART_NUMBERS",
        message: "partNumbers is required",
      });
    }
    return this.storageService.refreshDirectPartUrls(jobId, partNumbers);
  }

  /** 直传分片进度上报（节流由前端控制）。 */
  @Post("files/upload-sessions/:jobId/progress")
  async updateProgress(@Param("jobId") jobId: string, @Body() body: { loaded?: number }) {
    const loaded = body?.loaded;
    if (!Number.isFinite(loaded) || (loaded ?? 0) < 0) {
      throw new BadRequestException({
        code: "INVALID_PROGRESS",
        message: "loaded is required",
      });
    }
    await this.storageService.updateUploadProgress(jobId, loaded as number);
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

  /** 修改客户端别名（全局唯一，改名后机器重连不会覆盖） */
  @Patch("clients/:clientId/name")
  async renameClient(
    @Param("clientId") clientId: string,
    @Body("name") name: unknown,
  ) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new BadRequestException({
        code: INVALID_CLIENT_NAME,
        message: "name must be a non-empty string",
      });
    }
    try {
      return await this.clientService.rename(clientId, name);
    } catch (error) {
      const { code, statusCode, message } = error as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      if (!code || !statusCode) throw error;
      throw new HttpException({ code, message }, statusCode);
    }
  }

  /** 全量替换操作者注解；空对象清除。 */
  @Put("clients/:clientId/annotations")
  async updateClientAnnotations(
    @Param("clientId") clientId: string,
    @Body() body: unknown,
  ) {
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : null;
    if (!record || !Object.hasOwn(record, "annotations")) {
      throw new BadRequestException({
        code: INVALID_CLIENT_ANNOTATIONS,
        message: "annotations is required",
      });
    }

    const input = parseAnnotationsOrThrow(record.annotations);
    try {
      return await this.clientService.updateAnnotations(clientId, input);
    } catch (error) {
      const { code, statusCode, message } = error as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      if (!code || !statusCode) throw error;
      throw new HttpException({ code, message }, statusCode);
    }
  }

	/** 远程 DSH 服务未装配时给出稳定错误，而不是 500。 */
	private requireDshWeb(): DshWebService {
		if (!this.dshWebService) {
			throw new HttpException(
				{ code: "DSH_WEB_UNAVAILABLE", message: "远程 DSH 通道未启用" },
				503,
			);
		}
		return this.dshWebService;
	}

	/** 远程 DSH 受管通道状态（ADR-0059 修订）。 */
	@Get("clients/:clientId/dsh-web")
	async getClientDshWeb(@Param("clientId") clientId: string) {
		try {
			return await this.requireDshWeb().status(clientId);
		} catch (error) {
			const { code, statusCode, message } = error as {
				code?: string;
				statusCode?: number;
				message?: string;
			};
			if (!code || !statusCode) throw error;
			throw new HttpException({ code, message }, statusCode);
		}
	}

	/** 一键启动：代起 dsh web 并自动建 FRP 映射。 */
	@Post("clients/:clientId/dsh-web/start")
	async startClientDshWeb(@Param("clientId") clientId: string) {
		try {
			return await this.requireDshWeb().start(clientId);
		} catch (error) {
			const { code, statusCode, message } = error as {
				code?: string;
				statusCode?: number;
				message?: string;
			};
			if (!code || !statusCode) throw error;
			throw new HttpException({ code, message }, statusCode);
		}
	}

	/** 一键停止：停进程、删 FRP 映射、清空地址。外部托管时等价于解除登记。 */
	@Post("clients/:clientId/dsh-web/stop")
	async stopClientDshWeb(@Param("clientId") clientId: string) {
		try {
			return await this.requireDshWeb().stop(clientId);
		} catch (error) {
			const { code, statusCode, message } = error as {
				code?: string;
				statusCode?: number;
				message?: string;
			};
			if (!code || !statusCode) throw error;
			throw new HttpException({ code, message }, statusCode);
		}
	}

	/**
	 * 解除外部托管的登记（ADR-0059 决策 12）。
	 *
	 * 只清 VCPDeck 侧的入口与归属，不动目标机进程：常驻的 `dsh web`
	 * 归 systemd / docker / 操作者自己管。
	 */
	@Delete("clients/:clientId/dsh-web")
	@HttpCode(200)
	async detachClientDshWeb(@Param("clientId") clientId: string) {
		try {
			return await this.requireDshWeb().detach(clientId);
		} catch (error) {
			const { code, statusCode, message } = error as {
				code?: string;
				statusCode?: number;
				message?: string;
			};
			if (!code || !statusCode) throw error;
			throw new HttpException({ code, message }, statusCode);
		}
	}
  /**
   * 登记/清除远程 DSH WebUI 地址（[ADR-0059]）。
   *
   * 只登记，不验证可达性：地址由操作者经 FRP/内网暴露，Server 不去探测
   * （探测会形成 SSRF 面，且目标往往只在操作者本机网络可达）。
   */
  @Put("clients/:clientId/dsh-web")
  async updateClientDshWeb(
    @Param("clientId") clientId: string,
    @Body() body: unknown,
  ) {
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : null;
    if (!record || !Object.hasOwn(record, "url")) {
      throw new BadRequestException({
        code: INVALID_DSH_WEB_URL,
        message: "url is required (string or null)",
      });
    }

    let url: string | null;
    try {
      url = parseClientDshWebUrl(record.url);
    } catch (error) {
      throw new BadRequestException({
        code: INVALID_DSH_WEB_URL,
        message: (error as Error).message,
      });
    }

    try {
      return await this.clientService.setDshWebUrl(clientId, url);
    } catch (error) {
      const { code, statusCode, message } = error as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      if (!code || !statusCode) throw error;
      throw new HttpException({ code, message }, statusCode);
    }
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
      status: status as JobStatus | "active" | undefined,
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

  /** Job 输出 spool 全文；仅详情诊断时调用，不进入列表路径。 */
  @Get("jobs/:jobId/output")
  async getJobOutput(@Param("jobId") jobId: string) {
    const job = await this.jobService.findById(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found`);
    const output = await this.jobService.readJobOutput(jobId);
    return { jobId, output };
  }

  /**
   * Job 日志事件链（ADR-0054）：按 seq 升序增量拉取。
   *
   * `nextSeq` 是下一次请求的游标；返回条数小于 `limit` 即表示已到末尾。
   */
  @Get("jobs/:jobId/logs")
  async listJobLogs(
    @Param("jobId") jobId: string,
    @Query("since") since?: string,
    @Query("limit") limit?: string,
    @Query("level") level?: string,
  ) {
    const job = await this.jobService.findById(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found`);

    let logLevel: JobLogLevel | undefined;
    if (level !== undefined) {
      if (!(JOB_LOG_LEVELS as readonly string[]).includes(level)) {
        throw new BadRequestException({
          code: "INVALID_JOB_LOG_QUERY",
          message: "level must be info, warn or error",
        });
      }
      logLevel = level as JobLogLevel;
    }

    const sinceSeq = parseNonNegativeInteger(since, "since");
    const limitCount = parsePositiveInteger(limit, "limit");

    return this.jobLogService.list(jobId, {
      ...(sinceSeq !== undefined ? { since: sinceSeq } : {}),
      ...(limitCount !== undefined ? { limit: limitCount } : {}),
      ...(logLevel !== undefined ? { level: logLevel } : {}),
    });
  }
}

/** 解析可选的非负整数查询参数；非法值直接拒绝，不猜测修正。 */
function parseNonNegativeInteger(
  raw: string | undefined,
  field: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException({
      code: "INVALID_JOB_LOG_QUERY",
      message: `${field} must be a non-negative integer`,
    });
  }
  return value;
}

/** 解析可选的正整数查询参数。 */
function parsePositiveInteger(
  raw: string | undefined,
  field: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new BadRequestException({
      code: "INVALID_JOB_LOG_QUERY",
      message: `${field} must be a positive integer`,
    });
  }
  return value;
}
