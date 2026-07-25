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
		res.setHeader(
			"Content-Type",
			meta.mimeType || "application/octet-stream",
		);
		res.setHeader(
			"Content-Disposition",
			`attachment; filename="${encodeURIComponent(meta.filename)}"`,
		);
		res.setHeader("Content-Length", meta.size);
		stream.pipe(res);
	}

	/** 删除文件 */
	@Delete(":key(*)")
	async delete(@Param("key") key: string) {
		await this.storageService.delete(key);
		return { ok: true };
	}
}
