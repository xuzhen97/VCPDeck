import {
	BadRequestException,
	Body,
	Controller,
	Header,
	HttpException,
	Inject,
	InternalServerErrorException,
	Param,
	Post,
} from "@nestjs/common";
import type { ActorContext, ReleaseInfo } from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { ReleaseError } from "./release.service.js";
import {
	ReleaseUploadContract,
	ReleaseUploadError,
	ReleaseUploadService,
	type ReleaseUploadApiPart,
	type ReleaseUploadApiSession,
} from "./release-upload.service.js";

const ERROR_STATUS: Record<string, number> = {
	RELEASE_DUPLICATE_VERSION: 409,
	RELEASE_ARCHIVE_EXISTS: 409,
	RELEASE_UPLOAD_SESSION_NOT_FOUND: 404,
	RELEASE_UPLOAD_SESSION_EXPIRED: 410,
	RELEASE_UPLOAD_SESSION_CONFLICT: 409,
	RELEASE_UPLOAD_SIZE_MISMATCH: 400,
	RELEASE_UPLOAD_PROVIDER_FAILED: 502,
};

/** Release 外部 Provider 直传控制面 API；不接收构件正文。 */
@Controller("api/releases/uploads")
export class ReleaseUploadController {
	constructor(
		@Inject(ReleaseUploadService)
		private readonly uploads: ReleaseUploadService,
	) {}

	@Post()
	@Header("Cache-Control", "no-store")
	async create(
		@Body() raw: unknown,
		@Actor() actor?: ActorContext,
	): Promise<ReleaseUploadApiSession> {
		const input = this.parse(() => ReleaseUploadContract.parseCreate(raw));
		try {
			return await this.uploads.createSession(input, actor);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Post(":sessionId/parts")
	@Header("Cache-Control", "no-store")
	async refreshParts(
		@Param("sessionId") sessionId: string,
		@Body() raw: unknown,
	): Promise<{ parts: ReleaseUploadApiPart[] }> {
		const { partNumbers } = this.parse(() =>
			ReleaseUploadContract.parseRefresh(raw),
		);
		try {
			return await this.uploads.refreshParts(sessionId, partNumbers);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	@Post(":sessionId/complete")
	@Header("Cache-Control", "no-store")
	async complete(
		@Param("sessionId") sessionId: string,
		@Body() raw: unknown,
	): Promise<{ release: ReleaseInfo }> {
		const { uploadedBytes } = this.parse(() =>
			ReleaseUploadContract.parseComplete(raw),
		);
		try {
			return await this.uploads.completeSession(sessionId, uploadedBytes);
		} catch (error) {
			throw this.toHttp(error);
		}
	}

	private parse<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			throw new BadRequestException(
				error instanceof Error ? error.message : "请求无效",
			);
		}
	}

	private toHttp(error: unknown): HttpException {
		if (error instanceof ReleaseUploadError || error instanceof ReleaseError) {
			return new HttpException(
				{ code: error.code, message: error.message },
				ERROR_STATUS[error.code] ?? 500,
			);
		}
		return new InternalServerErrorException("Release 上传处理失败");
	}
}
