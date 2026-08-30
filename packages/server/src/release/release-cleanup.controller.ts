import {
	ConflictException,
	Controller,
	Get,
	Inject,
	Post,
} from "@nestjs/common";
import { ReleaseError } from "./release.service.js";
import { ReleaseCleanupService } from "./release-cleanup.service.js";

/** Release archive 清理控制面 API；默认受全局认证保护。 */
@Controller("api/releases/cleanup")
export class ReleaseCleanupController {
	constructor(
		@Inject(ReleaseCleanupService)
		private readonly cleanup: ReleaseCleanupService,
	) {}

	/** 预览固定清理策略下的候选正文和上传会话。 */
	@Get("preview")
	preview() {
		return this.cleanup.preview();
	}

	/** 立即按固定清理策略执行一次清理。 */
	@Post("run")
	async run() {
		try {
			return await this.cleanup.run();
		} catch (error) {
			if (error instanceof ReleaseError && error.code === "RELEASE_CLEANUP_BUSY") {
				throw new ConflictException({
					code: error.code,
					message: error.message,
				});
			}
			throw error;
		}
	}
}
