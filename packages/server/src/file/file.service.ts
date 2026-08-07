import { Injectable, Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { FileMeta } from "../storage/providers/storage-provider.interface.js";

export interface CreatePendingResult {
	fileId: string;
	key: string;
	uploadUrl: string;
	expiresAt: number;
}

export interface DownloadInfo {
	downloadUrl: string;
	size: number;
	sha256: string;
}

@Injectable()
export class FileService {
	// ponytail: logger reserved, add log lines when error handling expands

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(StorageService) private readonly storage: StorageService,
	) {}

	/** 创建 pending File 记录 + 签发上传令牌 */
	async createPending(
		jobId: string | undefined,
		clientId: string,
		meta: Omit<FileMeta, "key">,
		options: { expiresAt?: Date; purpose?: string } = {},
	): Promise<CreatePendingResult> {
		const fileId = randomUUID();
		const { url, expiresAt: tokenExpiresAt } = await this.storage.createUploadToken(meta);

		// 从 url 中提取 key: /api/storage/upload/:key?...
		const key =
			url.match(/\/api\/storage\/upload\/(.+?)\?(.+)/)?.[1] ??
			`${randomUUID()}/${meta.filename.replace(/[\\/:*?"<>|]/g, "_")}`;

		await this.prisma.file.create({
			data: {
				id: fileId,
				key,
				jobId: jobId ?? null,
				clientId,
				filename: meta.filename,
				mimeType: meta.mimeType ?? null,
				size: meta.size,
				sha256: "",
				status: "pending",
				storageKind: "local",
				...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
				...(options.purpose ? { purpose: options.purpose } : {}),
			},
		});

		return { fileId, key, uploadUrl: url, expiresAt: tokenExpiresAt };
	}

	/** 确认上传完成，保留上传阶段持久化的真实 key 并写入 sha256 */
	async confirmUpload(
		fileId: string,
		sha256: string,
	): Promise<{ key: string; size: number }> {
		const file = await this.prisma.file.update({
			where: { id: fileId },
			data: { sha256, status: "completed" },
		});
		return { key: file.key, size: file.size };
	}

	/** 为已完成的 File 签发下载令牌 */
	async createDownloadToken(fileId: string): Promise<DownloadInfo> {
		const file = await this.prisma.file.findUniqueOrThrow({
			where: { id: fileId },
		});
		if (file.status !== "completed") {
			throw Object.assign(new Error("File not ready for download"), {
				statusCode: 400,
			});
		}
		const { url } = await this.storage.createDownloadToken(file.key);
		return { downloadUrl: url, size: file.size, sha256: file.sha256 };
	}

	/** 查询已过期文件 */
	async getExpiredFiles(): Promise<{ id: string; key: string }[]> {
		const files = await this.prisma.file.findMany({
			where: { expiresAt: { lte: new Date() } },
			select: { id: true, key: true },
		});
		return files;
	}

	/** 删除 File 记录 + Storage 对象 */
	async delete(fileId: string): Promise<void> {
		const file = await this.prisma.file.findUnique({
			where: { id: fileId },
		});
		if (!file) return;
		await this.storage.delete(file.key);
		await this.prisma.file.delete({ where: { id: fileId } });
	}

	/** 按 ID 查询 */
	async findById(fileId: string) {
		return this.prisma.file.findUnique({ where: { id: fileId } });
	}
}
