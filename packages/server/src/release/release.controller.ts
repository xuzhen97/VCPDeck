/**
 * Release REST API：更新包上传、列表、下载。
 * 上传采用 raw stream（POST body 为 zip 字节，version/sha256 走 query），
 * 避免引入 multipart/multer 依赖。详见 docs/design/release-and-update.md。
 */
import {
	BadRequestException,
	ConflictException,
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
import { constants, createWriteStream, existsSync } from "node:fs";
import { copyFile, link, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasesDir, releaseZipPath } from "./release-paths.js";
export { releasesDir, releaseZipPath } from "./release-paths.js";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { Response } from "express";
import { ReleaseError, ReleaseService } from "./release.service.js";
import { ReleaseOrchestrator } from "./release.orchestrator.js";
import { DirectUrlCache } from "./direct-url-cache.js";
import { StorageService } from "../storage/storage.service.js";
import { Public } from "../auth/public.decorator.js";
import { Actor } from "../auth/actor.decorator.js";
import {
	MIN_UPDATE_PLAN_LAUNCHER_VERSION,
	ReleaseArtifactErrorCode,
	ReleaseStatus,
	hasAllReleaseArchives,
	isReleaseArchiveAvailable,
	type ActorContext,
	type ReleaseDeltaCandidate,
	type ReleasePlatform,
} from "@vcpdeck/shared";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIRECT_URL_ATTEMPTS = 3;
const DIRECT_URL_RETRY_DELAYS_MS = [100, 250];

function isTransientProviderError(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(error instanceof Error && /HTTP (500|502|503|504)\b/.test(error.message))
	);
}

function providerErrorStatus(error: unknown): string {
	if (!(error instanceof Error)) return "unknown";
	return /HTTP (\d{3})\b/.exec(error.message)?.[1] ?? "network";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlatform(v: string | undefined): v is ReleasePlatform {
	return v === "win-x64" || v === "linux-x64" || v === "linux-x64-musl";
}

/** 纯数字三段版本解析（x.y.z），不依赖 semver；非法或缺省返回 null。 */
function parseXyz(value: string | undefined): [number, number, number] | null {
	if (!value) return null;
	const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
	if (!matched) return null;
	return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
}

/** x.y.z 逐段比较（不引入新依赖）：a < b 返回 -1，相等返回 0，否则 1。 */
function compareXyz(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): number {
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return 0;
}

/** Provider 返回的直链只允许带主机名的 HTTP(S) URL。 */
function safeDirectUrl(value: string): string | null {
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			!parsed.hostname ||
			parsed.username ||
			parsed.password
		) {
			return null;
		}
		return parsed.toString();
	} catch {
		return null;
	}
}

/** 上传临时目录（校验通过后移动到最终路径） */
const UPLOAD_TMP_DIR = join(tmpdir(), "vcpdeck-release-upload");

/** ReleaseError code → HTTP 状态 */
const RELEASE_ERROR_STATUS: Record<string, number> = {
	RELEASE_DUPLICATE_VERSION: 409,
	RELEASE_NOT_FOUND: 404,
	RELEASE_INVALID_TRANSITION: 409,
	RELEASE_SHA256_MISMATCH: 400,
	RELEASE_DIRECT_UPLOAD_REQUIRED: 409,
	RELEASE_CLIENT_NOT_FOUND: 404,
	RELEASE_RETRY_NOT_ALLOWED: 409,
	LAUNCHER_UPGRADE_REQUIRED: 403,
	RELEASE_ARTIFACTS_INCOMPLETE: 409,
};

function toHttp(e: ReleaseError): HttpException {
	return new HttpException(
		{ code: e.code, message: e.message },
		RELEASE_ERROR_STATUS[e.code] ?? 500,
	);
}

/** 移动到最终路径且不覆盖既有 archive；跨盘/不支持硬链接时独占复制。 */
async function moveFileExclusive(src: string, dest: string): Promise<void> {
	try {
		await link(src, dest);
		await rm(src, { force: true });
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw error;
		if (code !== "EXDEV" && code !== "EPERM" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
			throw error;
		}
	}
	await copyFile(src, dest, constants.COPYFILE_EXCL);
	await rm(src, { force: true });
}

@Controller("api/releases")
export class ReleaseController {
	/** 外部存储直链短时缓存（ADR-0019：用的时候现取，短 TTL 不暴露给目标机） */
	private readonly directUrls = new DirectUrlCache();

	constructor(
		@Inject(ReleaseService) private readonly service: ReleaseService,
		@Inject(ReleaseOrchestrator)
		private readonly orchestrator: ReleaseOrchestrator,
		@Inject(StorageService) private readonly storage: StorageService,
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

	/**
	 * 人工强制重试某个客户端的补更。
	 * 自动重试耗尽或退避未到期时的唯一兜底；永久失败仍被拒绝。
	 */
	@Post(":version/clients/:clientId/retry")
	async retryClient(
		@Param("version") version: string,
		@Param("clientId") clientId: string,
	) {
		try {
			const result = await this.orchestrator.retryClient(version, clientId);
			return { ...result, state: "retrying" };
		} catch (e) {
			if (e instanceof ReleaseError) throw toHttp(e);
			throw e;
		}
	}

	/** 更新包下载：客户端 launcher 使用，公开（完整性由 sha256 校验兑底）；按平台选包。
	 * 带 fromVersion 时下载该基线对应的增量包；缺省行为与迁移前逐字一致。 */
	@Public()
	@Get(":version/file")
	async download(
		@Param("version") version: string,
		@Res() res: Response,
		@Query("platform") platform?: string,
		@Query("fromVersion") fromVersion?: string,
	) {
		if (!isPlatform(platform)) {
			throw new BadRequestException(
				"platform 应为 win-x64、linux-x64 或 linux-x64-musl",
			);
		}
		// 空串按缺省处理；其余必须是 x.y.z，避免把查询参数拼进本地文件路径。
		const deltaFromVersion = fromVersion || undefined;
		if (deltaFromVersion && !VERSION_RE.test(deltaFromVersion)) {
			throw new BadRequestException("fromVersion 应为 x.y.z 格式");
		}
		const info = await this.service.findByVersionWithStorage(version);
		if (!info) {
			throw new NotFoundException({
				code: "RELEASE_NOT_FOUND",
				message: `release ${version} 不存在`,
			});
		}
		const archive = info.archives[platform];
		if (!archive) {
			throw new NotFoundException({
				code: "RELEASE_ARCHIVE_MISSING",
				message: `release ${version} 缺少 ${platform} 构件`,
			});
		}
		if (archive.availability === "deleting") {
			throw new ConflictException({
				code: "RELEASE_ARCHIVE_CLEANING",
				message: "更新包正在清理，请稍后重试",
			});
		}
		if (archive.availability === "cleaned") {
			throw new HttpException(
				{
					code: "RELEASE_ARCHIVE_CLEANED",
					message: "更新包归档已清理",
				},
				410,
			);
		}
		// 上面已排除缺失、deleting 和 cleaned，剩余状态均为可用 archive。
		const delta = deltaFromVersion
			? archive.deltas?.find((d) => d.fromVersion === deltaFromVersion)
			: undefined;
		if (deltaFromVersion && !delta) {
			throw new NotFoundException({
				code: "RELEASE_ARCHIVE_MISSING",
				message: `release ${version} 缺少 ${platform} 的 ${deltaFromVersion} 增量构件`,
			});
		}
		const zipPath = releaseZipPath(version, platform, delta?.fromVersion);
		const directKey = delta ? delta.providerKey : archive.storage?.key;
		// 本次改动前上传的存量 Release 没有 delta key，明确报错而非静默回落到 full 包
		// （后者会用 delta 的 sha256 校验 full 字节，必然失败）。
		if (delta && archive?.storage?.mode === "direct" && !directKey) {
			res.status(502).json({
				code: "RELEASE_DIRECT_URL_UNAVAILABLE",
				message: "增量构件缺少存储定位信息，请重新上传该版本",
			});
			return;
		}
		// ADR-0019：外部存储后端 302 到临时直链，目标机直连下载不占 Server 带宽
		if (archive?.storage?.mode === "direct" && directKey) {
			const directUrl = await this.resolveDirectUrl(
				version,
				platform,
				directKey,
			);
			if (directUrl) {
				res.redirect(302, directUrl);
				return;
			}
			// 降级：本地有构件时回到中转；否则明确失败
			if (!existsSync(zipPath)) {
				res.status(502).json({
					code: "RELEASE_DIRECT_URL_UNAVAILABLE",
					message: "直链换取失败且无本地构件可用",
				});
				return;
			}
		}
		res.sendFile(
			zipPath,
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
	 * 新 Launcher 更新计划（ADR-0062）：只返回 JSON 计划，绝不 302 给旧 Launcher 误执行。
	 * 门槛：launcher 必须是 x.y.z，且不低于 `MIN_UPDATE_PLAN_LAUNCHER_VERSION`（首个能解析
	 * v2 清单、验签并组装增量的 Launcher）；archive 内可选的 launcherMinVersion（打包侧写入）
	 * 再做更严格逐段比较。这里的门槛是 Launcher 三段版本，与控制协议号无关。
	 * 响应仅投影公开字段，绝不携带 Provider key、Token 或完整 archive。
	 */
	@Public()
	@Get(":version/update")
	async updatePlan(
		@Param("version") version: string,
		@Query("platform") platform?: string,
		@Query("launcher") launcher?: string,
	) {
		const requested = parseXyz(launcher);
		const floor = parseXyz(MIN_UPDATE_PLAN_LAUNCHER_VERSION);
		if (!requested || !floor || compareXyz(requested, floor) < 0) {
			throw toHttp(
				new ReleaseError(
					ReleaseArtifactErrorCode.LAUNCHER_UPGRADE_REQUIRED,
					"Launcher 版本过低，请升级后重试",
				),
			);
		}
		if (!isPlatform(platform)) {
			throw new BadRequestException(
				"platform 应为 win-x64、linux-x64 或 linux-x64-musl",
			);
		}
		const info = await this.service.findByVersionWithStorage(version);
		if (!info) {
			throw new NotFoundException({
				code: "RELEASE_NOT_FOUND",
				message: `release ${version} 不存在`,
			});
		}
		// musl 是可选变体：只有进入客户端更新阶段（或已完成）才允许下发，
		// 避免第三包刚上传、常规双平台编排尚未开始时就被单独拉走。
		if (
			platform === "linux-x64-musl" &&
			info.status !== ReleaseStatus.UPDATING_CLIENTS &&
			info.status !== ReleaseStatus.DONE
		) {
			throw toHttp(
				new ReleaseError(
					ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
					`release ${version} 尚未进入客户端更新阶段`,
				),
			);
		}
		const archive = info.archives[platform];
		if (!isReleaseArchiveAvailable(archive)) {
			throw toHttp(
				new ReleaseError(
					ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
					`release ${version} 的 ${platform} 构件尚不齐备`,
				),
			);
		}
		const declaredMin = (archive as { launcherMinVersion?: unknown })
			.launcherMinVersion;
		const min = parseXyz(
			typeof declaredMin === "string" ? declaredMin : undefined,
		);
		if (min && compareXyz(requested, min) < 0) {
			throw toHttp(
				new ReleaseError(
					ReleaseArtifactErrorCode.LAUNCHER_UPGRADE_REQUIRED,
					"Launcher 版本低于该发布包要求，请升级后重试",
				),
			);
		}
		const candidates: ReleaseDeltaCandidate[] = (archive.deltas ?? []).map(
			(delta) => ({
				fromVersion: delta.fromVersion,
				url: `/api/releases/${version}/file?platform=${platform}&fromVersion=${encodeURIComponent(delta.fromVersion)}`,
				sha256: delta.sha256,
				size: delta.size,
			}),
		);
		return {
			url: `/api/releases/${version}/file?platform=${platform}`,
			sha256: archive.sha256,
			size: archive.size,
			...(candidates.length > 0 ? { candidates } : {}),
		};
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
			throw new BadRequestException(
				"platform 应为 win-x64、linux-x64 或 linux-x64-musl",
			);
		}
		if (!sha256 || !SHA256_RE.test(sha256)) {
			throw new BadRequestException("sha256 应为 64 位十六进制");
		}
		const backend = await this.storage.getBackendConfig();
		if (backend.kind === "alibaba") {
			throw toHttp(
				new ReleaseError(
					"RELEASE_DIRECT_UPLOAD_REQUIRED",
					"Alibaba 存储必须使用 Release 直传会话",
				),
			);
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
			const fileName = `vcpdeck-${version}-${platform}.zip`;
			const size = (await stat(tempPath)).size;
				const existing = await this.service.findByVersionWithStorage(version);
			if (existing?.archives[platform]) {
				throw new ReleaseError(
					"RELEASE_ARCHIVE_EXISTS",
					`release ${version} 已存在 ${platform} 构件`,
				);
			}
			const finalPath = releaseZipPath(version, platform);
			await mkdir(releasesDir(), { recursive: true });
			try {
				await moveFileExclusive(tempPath, finalPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new ReleaseError(
						"RELEASE_ARCHIVE_EXISTS",
						`release ${version} 已存在 ${platform} 构件`,
					);
				}
				throw error;
			}
			moved = true;
			const archive = { sha256, fileName, size };
			const release = existing
				? await this.service.addArchive(version, platform, archive)
				: await this.service.create({
						version,
						archives: { [platform]: archive },
						createdByName: actor?.displayName,
						createdVia: actor?.source,
					});
			// 两个平台构件齐备才触发自更新（不阻塞上传响应；失败由编排器落库标记）
			if (hasAllReleaseArchives(release)) {
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

	/**
	 * 换取直链下载 URL（ADR-0019）：短时缓存，过期/失败时重新换取；
	 * 不支持的 provider 或换取失败返回 null，由调用方降级。
	 */
	private async resolveDirectUrl(
		version: string,
		platform: ReleasePlatform,
		key: string,
	): Promise<string | null> {
		const cacheKey = `${version}:${platform}:${key}`;
		const cached = this.directUrls.get(cacheKey);
		if (cached) return cached;
		for (let attempt = 0; attempt < DIRECT_URL_ATTEMPTS; attempt++) {
			try {
				const direct = await this.storage.getDirectDownloadUrl(key);
				const directUrl = direct?.url ? safeDirectUrl(direct.url) : null;
				const expiresAt = direct?.expiresAt;
				if (directUrl) {
					// 过期时间未知/非法时不缓存，避免短 TTL 直链被长期复用
					if (
						typeof expiresAt === "number" &&
						Number.isFinite(expiresAt) &&
						expiresAt > 0
					) {
						this.directUrls.set(cacheKey, directUrl, expiresAt);
					}
					return directUrl;
				}
				return null;
			} catch (e) {
				const retryable = isTransientProviderError(e);
				const status = providerErrorStatus(e);
				if (!retryable || attempt >= DIRECT_URL_ATTEMPTS - 1) {
					console.warn(
						`[release] 直链换取失败: attempt=${attempt + 1}/${DIRECT_URL_ATTEMPTS}, status=${status}`,
					);
					return null;
				}
				console.warn(
					`[release] 直链换取重试: attempt=${attempt + 1}/${DIRECT_URL_ATTEMPTS}, status=${status}`,
				);
				await sleep(DIRECT_URL_RETRY_DELAYS_MS[attempt] ?? 250);
			}
		}
		return null;
	}
}
