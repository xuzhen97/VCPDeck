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

	/** 查询已过期且未被有效分享保护的文件。 */
	async getExpiredFiles(): Promise<{ id: string; key: string }[]> {
		return this.prisma.file.findMany({
			where: {
				expiresAt: { lte: new Date() },
				shares: { none: { revokedAt: null, invalidatedAt: null } },
			},
			select: { id: true, key: true },
		});
	}

	/** 删除 File 记录和 Storage 对象，先通过 deleting 状态认领。 */
	async delete(fileId: string): Promise<void> {
		const claimed = await this.prisma.$transaction(async (tx) => {
			const file = await tx.file.findUnique({ where: { id: fileId } });
			if (!file) return null;
			const activeShares = await tx.storageShare.count({
				where: { fileId, revokedAt: null, invalidatedAt: null },
			});
			if (activeShares > 0) {
				throw Object.assign(new Error("File has active storage shares"), {
					code: "FILE_HAS_ACTIVE_SHARES",
					statusCode: 409,
				});
			}
			const result = await tx.file.updateMany({
				where: { id: fileId, status: file.status },
				data: { status: "deleting" },
			});
			if (result.count !== undefined && result.count !== 1) {
				throw Object.assign(new Error("File deletion state changed"), {
					code: "FILE_DELETE_CONFLICT",
					statusCode: 409,
				});
			}
			return { id: file.id, key: file.key, status: file.status };
		});
		if (!claimed) return;

		try {
			await this.storage.delete(claimed.key);
			await this.prisma.file.delete({ where: { id: claimed.id } });
		} catch (error) {
			await this.prisma.file.updateMany({
				where: { id: claimed.id, status: "deleting" },
				data: { status: claimed.status },
			});
			throw error;
		}
	}

	/** 按 Storage key 查询已登记 File。 */
	async findByKey(key: string) {
		return this.prisma.file.findUnique({ where: { key } });
	}

	/** 按 ID 查询 */
	async findById(fileId: string) {
		return this.prisma.file.findUnique({ where: { id: fileId } });
	}
}
