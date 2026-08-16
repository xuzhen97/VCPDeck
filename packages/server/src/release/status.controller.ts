/**
 * 状态端点：GET /api/status 返回服务端版本与当前活动 release。
 * 供 Launcher 健康探活与前端展示；详见 docs/design/release-and-update.md。
 */
import { Controller, Get, Inject } from "@nestjs/common";
import { VERSION } from "@vcpdeck/shared";
import { Public } from "../auth/public.decorator.js";
import { ReleaseService } from "./release.service.js";

@Controller("api/status")
export class StatusController {
	constructor(
		@Inject(ReleaseService) private readonly releases: ReleaseService,
	) {}

	/** launcher 健康探活使用，公开 */
	@Public()
	@Get()
	async get() {
		return {
			serverVersion: VERSION,
			activeRelease: await this.releases.getActiveRelease(),
		};
	}
}
