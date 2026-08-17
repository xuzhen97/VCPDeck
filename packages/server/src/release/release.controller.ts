/**
 * Release REST API：更新包上传、列表、下载。
 * 上传采用 raw stream（POST body 为 zip 字节，version/sha256 走 query），
 * 避免引入 multipart/multer 依赖。详见 docs/design/release-and-update.md。
 */
import {
	BadRequestException,
	Controller,
	Get,
	HttpException,
	Inject,
	NotFoundException,
	Param,
	Post,
	Query,
	Req,
	Res,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { Response } from "express";
import { ReleaseError, ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
import { Public } from "../auth/public.decorator.js";
import { Actor } from "../auth/actor.decorator.js";
import type { ActorContext, ReleasePlatform } from "@vcpdeck/shared";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isPlatform(v: string | undefined): v is ReleasePlatform {
	return v === "win-x64" || v === "linux-x64";
}

/** release 存储目录（默认相对 server 运行目录，可经环境变量覆盖） */
export function releasesDir(): string {
	return process.env.VCPDECK_RELEASES_DIR || "./data/releases";
}

/** release zip 最终存储路径（按平台分开；绝对路径，res.sendFile 要求） */
export function releaseZipPath(version: string, platform: ReleasePlatform): string {
	return resolve(
		process.env.VCPDECK_RELEASES_DIR || "./data/releases",
		`vcpdeck-${version}-${platform}.zip`,
	);
}

/** 上传临时目录（校验通过后移动到最终路径） */
const UPLOAD_TMP_DIR = join(tmpdir(), "vcpdeck-release-upload");

/** ReleaseError code → HTTP 状态 */
const RELEASE_ERROR_STATUS: Record<string, number> = {
	RELEASE_DUPLICATE_VERSION: 409,
	RELEASE_NOT_FOUND: 404,
	RELEASE_INVALID_TRANSITION: 409,
	RELEASE_SHA256_MISMATCH: 400,
};

function toHttp(e: ReleaseError): HttpException {
	return new HttpException(
		{ code: e.code, message: e.message },
		RELEASE_ERROR_STATUS[e.code] ?? 500,
	);
}

/** 移动到最终路径；跨盘 EXDEV 时回退 copy+rm */
async function moveFile(src: string, dest: string): Promise<void> {
	try {
		await rename(src, dest);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
		await copyFile(src, dest);
		await rm(src, { force: true });
	}
}

@Controller("api/releases")
export class ReleaseController {
	constructor(
		@Inject(ReleaseService) private readonly service: ReleaseService,
		@Inject(ReleaseOrchestrator)
		private readonly orchestrator: ReleaseOrchestrator,
	) {}

	@Get()
	async list(
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	) {
		return this.service.list(
			page ? Math.max(1, parseInt(page, 10)) : undefined,
			pageSize ? Math.min(100, Math.max(1, parseInt(pageSize, 10))) : undefined,
		);
	}

	/** 更新包下载：客户端 launcher 使用，公开（完整性由 sha256 校验兑底）；按平台选包 */
	@Public()
	@Get(":version/file")
	async download(
		@Param("version") version: string,
		@Res() res: Response,
		@Query("platform") platform?: string,
	) {
		if (!isPlatform(platform)) {
			throw new BadRequestException("platform 应为 win-x64 或 linux-x64");
		}
		const info = await this.service.findByVersion(version);
		if (!info) {
			throw new NotFoundException({
				code: "RELEASE_NOT_FOUND",
				message: `release ${version} 不存在`,
			});
		}
		if (!info.archives[platform]) {
			throw new NotFoundException({
				code: "RELEASE_ARCHIVE_MISSING",
				message: `release ${version} 缺少 ${platform} 构件`,
			});
		}
		res.sendFile(
			releaseZipPath(version, platform),
			{ headers: { "content-type": "application/zip" } },
			(err?: Error | null) => {
				if (err && !res.headersSent) {
					res.status(404).json({
						code: "RELEASE_FILE_MISSING",
						message: "更新包文件不存在",
					});
				}
			},
		);
	}

	/**
	 * 上传更新包：POST /api/releases/upload?version=x.y.z&platform=win-x64|linux-x64&sha256=<64hex>
	 * body 为 zip 原始字节（content-type: application/zip）。两个平台各上传一次；
	 * 两个平台构件齐备后才自动触发更新。操作者由 AuthGuard 注入，审计用。
	 */
	@Post("upload")
	async upload(
		@Req() req: IncomingMessage,
		@Query("version") version?: string,
		@Query("platform") platform?: string,
		@Query("sha256") sha256?: string,
		@Actor() actor?: ActorContext,
	) {
		if (!version || !VERSION_RE.test(version)) {
			throw new BadRequestException("版本号格式应为 x.y.z");
		}
		if (!isPlatform(platform)) {
			throw new BadRequestException("platform 应为 win-x64 或 linux-x64");
		}
		if (!sha256 || !SHA256_RE.test(sha256)) {
			throw new BadRequestException("sha256 应为 64 位十六进制");
		}

		await mkdir(UPLOAD_TMP_DIR, { recursive: true });
		const tempPath = join(UPLOAD_TMP_DIR, randomUUID());
		let moved = false;
		try {
			await pipeline(req, createWriteStream(tempPath));
			const ok = await this.service.verifyZipSha256(tempPath, sha256);
			if (!ok) {
				throw new ReleaseError(
					"RELEASE_SHA256_MISMATCH",
					"文件 sha256 与声明不符",
				);
			}
			const finalPath = releaseZipPath(version, platform);
			await mkdir(releasesDir(), { recursive: true });
			await moveFile(tempPath, finalPath);
			moved = true;
			const archive = {
				sha256,
				fileName: `vcpdeck-${version}-${platform}.zip`,
				size: (await stat(finalPath)).size,
			};
			const existing = await this.service.findByVersion(version);
			const release = existing
				? await this.service.addArchive(version, platform, archive)
				: await this.service.create({
						version,
						archives: { [platform]: archive },
						createdByName: actor?.displayName,
						createdVia: actor?.source,
					});
			// 两个平台构件齐备才触发自更新（不阻塞上传响应；失败由编排器落库标记）
			if (this.service.hasAllArchives(release)) {
				void this.orchestrator
					.startRelease(version)
					.catch((e: unknown) => {
						console.error(`[release] 触发更新失败: ${version}`, e);
					});
			}
			return { release };
		} catch (e) {
			if (e instanceof ReleaseError) throw toHttp(e);
			throw e;
		} finally {
			if (!moved) {
				await rm(tempPath, { force: true }).catch(() => undefined);
			}
		}
	}
}
