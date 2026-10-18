/**
 * 功能目录 REST（ADR-0056）。
 *
 * 输入一律经 Shared 严格 parser；`active` 不可手写，只能由验证上报产生。
 * 错误只返回稳定 code 与安全文案。
 */
import {
	Body,
	Controller,
	Get,
	HttpException,
	Inject,
	Param,
	Patch,
	Post,
	Query,
} from "@nestjs/common";
import {
	type ActorContext,
	type FeatureInfo,
	FeatureProtocolError,
	parseFeatureCreateInput,
	parseFeatureUpdateInput,
	parseFeatureVerificationReport,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { FeatureError, FeatureService } from "./feature.service.js";

/** 业务/协议错误 → HTTP；其余异常原样抛出交给全局处理。 */
function featureHttpError(error: unknown): HttpException {
	if (error instanceof FeatureProtocolError) {
		return new HttpException(
			{ code: "INVALID_FEATURE_INPUT", message: error.message },
			400,
		);
	}
	if (error instanceof FeatureError) {
		return new HttpException(
			{ code: error.code, message: error.message },
			error.statusCode,
		);
	}
	throw error;
}

/** 解析页码；非法值回落到 1，不猜测。 */
function pageOf(value: unknown): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** 解析页大小并夹到 1–100（仓库既定约定）。 */
function clampPageSize(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) return 20;
	return Math.min(100, Math.max(1, parsed));
}

@Controller("api/features")
export class FeatureController {
	constructor(@Inject(FeatureService) private readonly features: FeatureService) {}

	/** 分页列表；retired 由调用方通过 status 显式过滤。 */
	@Get()
	async list(
		@Query("clientId") clientId?: string,
		@Query("scope") scope?: string,
		@Query("status") status?: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.features.list({
			clientId: clientId || undefined,
			scope: scope || undefined,
			status: status || undefined,
			page: pageOf(page),
			pageSize: clampPageSize(pageSize),
		});
	}

	/** 单条详情。 */
	@Get(":id")
	async get(@Param("id") id: string) {
		try {
			return await this.features.get(id);
		} catch (error) {
			throw featureHttpError(error);
		}
	}

	/** 创建条目；可内联提交一次验证结果。 */
	@Post()
	async create(
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<FeatureInfo> {
		try {
			return await this.features.create(parseFeatureCreateInput(body), actor);
		} catch (error) {
			throw featureHttpError(error);
		}
	}

	/** 更新契约或人工降级/退役。 */
	@Patch(":id")
	async update(
		@Param("id") id: string,
		@Body() body: unknown,
	): Promise<FeatureInfo> {
		try {
			return await this.features.update(id, parseFeatureUpdateInput(body));
		} catch (error) {
			throw featureHttpError(error);
		}
	}

	/** 上报一次验证结果；这是 `active` 的唯一来源。 */
	@Post(":id/verifications")
	async reportVerification(
		@Param("id") id: string,
		@Body() body: unknown,
	): Promise<FeatureInfo> {
		try {
			return await this.features.reportVerification(
				id,
				parseFeatureVerificationReport(body),
			);
		} catch (error) {
			throw featureHttpError(error);
		}
	}
}

/** 机器维度的条目列表（机器工作区「功能」Tab 直接使用）。 */
@Controller("api/clients/:clientId/features")
export class ClientFeatureController {
	constructor(@Inject(FeatureService) private readonly features: FeatureService) {}

	@Get()
	async list(
		@Param("clientId") clientId: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.features.listByClient(clientId, pageOf(page), clampPageSize(pageSize));
	}
}
