import {
	Controller,
	Post,
	Get,
	Put,
	Delete,
	Body,
	Param,
	Query,
	Req,
	Res,
	Inject,
	HttpCode,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { StorageService } from "./storage.service.js";

const DEFAULT_TTL = 3600; // 1 小时

@Controller("api/storage")
export class StorageController {
	constructor(
		@Inject(StorageService)
		private readonly storageService: StorageService,
	) {}

	/** 签发上传令牌 */
	@Post("upload-token")
	async createUploadToken(
		@Body()
		body: {
			jobId: string;
			clientId: string;
			filename: string;
			size: number;
			mimeType?: string;
			ttlSeconds?: number;
		},
	) {
		const ref = await this.storageService.createUploadToken(
			{
				jobId: body.jobId,
				clientId: body.clientId,
				filename: body.filename,
				size: body.size,
				mimeType: body.mimeType,
			},
			body.ttlSeconds ?? DEFAULT_TTL,
		);
		return { url: ref.url, expiresAt: ref.expiresAt };
	}

	/** 签发下载令牌 */
	@Post("download-token")
	async createDownloadToken(
		@Body() body: { key: string; ttlSeconds?: number },
	) {
		const ref = await this.storageService.createDownloadToken(
			body.key,
			body.ttlSeconds ?? DEFAULT_TTL,
		);
		return { url: ref.url, expiresAt: ref.expiresAt };
	}

	/** 受鉴权的稳定下载入口；每次请求实时签发后端 URL */
	@Get("download-redirect/:key(*)")
	async redirectDownload(
		@Param("key") key: string,
		@Res() res: Response,
	): Promise<void> {
		const ref = await this.storageService.createDownloadToken(key);
		res.status(302);
		res.setHeader("Location", ref.url);
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Cache-Control", "private, no-store");
		res.end();
	}

	/** 接收文件上传（预签名 URL） */
	@Public()
	@Put("upload/:key(*)")
	@HttpCode(200)
	async receiveUpload(
		@Param("key") key: string,
		@Query("expires") expires: string,
		@Query("sig") sig: string,
		@Req() req: Request,
	) {
		const entry = await this.storageService.receiveUpload(
			key,
			req,
			parseInt(expires, 10),
			sig,
		);
		return { key: entry.key, size: entry.size };
	}

	/** 下载文件（预签名 URL） */
	@Public()
	@Get("download/:key(*)")
	async download(
		@Param("key") key: string,
		@Query("expires") expires: string,
		@Query("sig") sig: string,
		@Res() res: Response,
	) {
		const { stream, meta } = await this.storageService.downloadVerified(
			key,
			parseInt(expires, 10),
			sig,
		);
		// 优先用 DB File 记录的真实文件名（阿里云盘后端 meta.filename 为 fileId）
		const filename =
			(await this.storageService.resolveFilename(key)) ?? meta.filename;
		res.setHeader(
			"Content-Type",
			meta.mimeType || "application/octet-stream",
		);
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="${encodeURIComponent(filename)}"`,
		);
		res.setHeader("Content-Length", meta.size);
		// 上游流中断时销毁响应，避免浏览器挂起等待直到超时报错
		stream.on("error", () => {
			res.destroy();
		});
		stream.pipe(res);
	}

	/** 删除文件 */
	@Delete(":key(*)")
	async delete(@Param("key") key: string) {
		await this.storageService.delete(key);
		return { ok: true };
	}

	/** 查看当前存储后端配置 */
	@Get("config")
	async getConfig() {
		return this.storageService.getBackendConfig();
	}

	/** 切换存储后端 */
	@Put("config")
	async updateConfig(
		@Body() body: { kind?: string; config?: Record<string, unknown> },
	) {
		await this.storageService.updateBackendConfig(body);
		return this.storageService.getBackendConfig();
	}
}
