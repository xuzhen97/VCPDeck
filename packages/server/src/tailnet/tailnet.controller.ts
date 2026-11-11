import {
	BadRequestException,
	Body,
	Controller,
	Delete,
	Get,
	HttpException,
	Inject,
	Param,
	Post,
	Query,
} from "@nestjs/common";
import {
	JobType,
	parseTailnetJobPayload,
	parseTailnetKeyInput,
	type ActorContext,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { ClientGateway } from "../events/client.gateway.js";
import { JobService } from "../job/job.service.js";
import { TailnetKeyService } from "./tailnet-key.service.js";
import { TailnetService } from "./tailnet.service.js";

/**
 * Tailnet 管理入口（ADR-0062）。
 *
 * 所有端点沿用全局认证与身份上下文，绝不声明 `@Public()`；
 * 密钥正文只在 Client 的 socket 单播中出现，REST 投影永不返回。
 */
@Controller("api/tailnet")
export class TailnetController {
	constructor(
		@Inject(TailnetKeyService) private readonly keys: TailnetKeyService,
		@Inject(TailnetService) private readonly tailnet: TailnetService,
		@Inject(JobService) private readonly jobs: JobService,
		@Inject(ClientGateway) private readonly gateway: ClientGateway,
	) {}

	@Post("keys")
	async importKey(@Body() body: unknown) {
		try {
			return await this.keys.importKey(parseTailnetKeyInput(body));
		} catch (error) {
			this.fail(error, "无法导入 Tailnet 密钥");
		}
	}

	@Get("keys")
	async listKeys(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		const parsedPage = Number.parseInt(page ?? "1", 10);
		const parsedSize = Number.parseInt(pageSize ?? "20", 10);
		const effectivePage = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
		const effectiveSize = Number.isFinite(parsedSize)
			? Math.min(100, Math.max(1, parsedSize))
			: 20;
		try {
			return await this.keys.listKeys(effectivePage, effectiveSize);
		} catch (error) {
			this.fail(error, "无法读取 Tailnet 密钥列表");
		}
	}

	@Delete("keys/:id")
	async deleteKey(@Param("id") id: string) {
		try {
			return await this.keys.deleteKey(id);
		} catch (error) {
			this.fail(error, "无法删除 Tailnet 密钥");
		}
	}

	@Get("clients/:clientId")
	async status(@Param("clientId") clientId: string) {
		try {
			return await this.tailnet.getStatus(clientId);
		} catch (error) {
			this.fail(error, "无法读取 Tailnet 状态");
		}
	}

	@Post("clients/:clientId/jobs")
	async manage(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	) {
		let payload: ReturnType<typeof parseTailnetJobPayload>;
		try {
			payload = parseTailnetJobPayload(body);
		} catch (error) {
			this.fail(error, "Tailnet 任务载荷不合法");
		}
		try {
			const created = await this.jobs.create(
				{ clientId, type: JobType.TAILNET_MANAGE, payload },
				actor,
			);
			if (created.dispatch) this.gateway.sendDispatch(created.dispatch);
			return created.result;
		} catch (error) {
			this.fail(error, "无法创建 Tailnet 管理任务");
		}
	}

	/** 统一映射：保留稳定 code/statusCode；解析类错误一律 400，绝不回显正文。 */
	private fail(error: unknown, fallback: string): never {
		const code = (error as { code?: unknown })?.code;
		const statusCode = (error as { statusCode?: unknown })?.statusCode;
		const message = (error as Error)?.message || fallback;
		if (
			typeof code === "string" &&
			typeof statusCode === "number" &&
			statusCode >= 400 &&
			statusCode < 600
		) {
			throw new HttpException({ code, message }, statusCode);
		}
		throw new BadRequestException({ code: "INVALID_TAILNET_INPUT", message });
	}
}
