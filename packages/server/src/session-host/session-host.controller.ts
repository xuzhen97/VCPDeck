/** @file 会话宿主实例元数据 REST API */

import { Controller, Get, Inject, Query } from "@nestjs/common";
import { SessionHostService } from "./session-host.service.js";

/** 解析分页参数：非法值回落默认，绝不把 NaN 带进查询。 */
function positiveInt(value: string | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(max, parsed);
}

@Controller("api/session-host/instances")
export class SessionHostController {
	constructor(@Inject(SessionHostService) private readonly service: SessionHostService) {}

	/** 分页列出实例元数据；pageSize 限制在 1–100。 */
	@Get()
	async list(
		@Query("clientId") clientId?: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.service.list(
			{ clientId },
			positiveInt(page, 1, Number.MAX_SAFE_INTEGER),
			positiveInt(pageSize, 20, 100),
		);
	}
}
