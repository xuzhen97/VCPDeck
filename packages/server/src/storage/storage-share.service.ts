import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
	ActorContext,
	CreateStorageShareRequest,
	CreateStorageShareResult,
	PaginatedResult,
	StorageShareInfo,
	StorageShareStatus,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "./storage.service.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_SHARE_PATH = "/api/public/storage-shares/";
const PREVIEW_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

type StorageShareRow = {
	id: string;
	tokenHash: string;
	fileId: string | null;
	filename: string;
	mimeType: string | null;
	storageKind: string;
	createdByIdentityId: string | null;
	createdByName: string | null;
	createdVia: string | null;
	createdAt: Date;
	revokedAt: Date | null;
	revokedByIdentityId: string | null;
	invalidatedAt: Date | null;
	invalidReason: string | null;
	file?: {
		id: string;
		key: string;
		filename: string;
		mimeType: string | null;
		size: number;
		status: string;
		storageKind: string;
	} | null;
};

function shareError(code: string, message: string, statusCode: number): Error {
	return Object.assign(new Error(message), { code, statusCode });
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 根据文件名返回固定的图片 MIME；不信任上传 MIME。 */
export function previewMime(filename: string): string | null {
	const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
	return extension ? PREVIEW_MIME[extension] ?? null : null;
}

function statusOf(row: Pick<StorageShareRow, "revokedAt" | "invalidatedAt" | "fileId">): StorageShareStatus {
	if (row.revokedAt) return "revoked";
	if (row.invalidatedAt || !row.fileId) return "invalid";
	return "active";
}

@Injectable()
export class StorageShareService {
	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(StorageService) private readonly storage: StorageService,
	) {}

	/** 创建独立的长期公开分享；数据库只保存 Token 哈希。 */
	async create(
		request: CreateStorageShareRequest,
		actor: ActorContext,
	): Promise<CreateStorageShareResult> {
		const currentKind = this.storage.currentKind();
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = randomBytes(32).toString("base64url");
			try {
				const row = await this.prisma.$transaction(async (tx) => {
					const file = await tx.file.findUnique({ where: { id: request.fileId } });
					if (!file || file.status !== "completed") {
						throw shareError("FILE_NOT_SHAREABLE", "File cannot be shared", 409);
					}
					if (file.storageKind !== currentKind) {
						throw shareError("STORAGE_PROVIDER_MISMATCH", "Storage provider is temporarily unavailable", 503);
					}
					return tx.storageShare.create({
						data: {
							id: randomUUID(),
							tokenHash: sha256(token),
							fileId: file.id,
							filename: file.filename,
							mimeType: file.mimeType,
							storageKind: file.storageKind,
							createdByIdentityId: actor.identityId,
							createdByName: actor.displayName,
							createdVia: actor.source,
						},
					});
				});
				return { ...this.toInfo(row), sharePath: `${PUBLIC_SHARE_PATH}${token}` };
			} catch (error) {
				if (attempt === 1 || !this.isUniqueError(error)) throw error;
			}
		}
		throw new Error("Unable to create storage share");
	}

	/** 分页查询分享管理信息。 */
	async list(options: {
		fileId?: string;
		status?: StorageShareStatus;
		page?: number;
		pageSize?: number;
	} = {}): Promise<PaginatedResult<StorageShareInfo>> {
		const page = options.page ?? 1;
		const pageSize = options.pageSize ?? 20;
		let where: Record<string, unknown> = {};
		if (options.fileId) where.fileId = options.fileId;
		if (options.status === "active") {
			where.revokedAt = null;
			where.invalidatedAt = null;
		}
		if (options.status === "revoked") where.revokedAt = { not: null };
		if (options.status === "invalid") where = { ...where, revokedAt: null, OR: [{ invalidatedAt: { not: null } }, { fileId: null }] };
		const [rows, total] = await Promise.all([
			this.prisma.storageShare.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
			this.prisma.storageShare.count({ where }),
		]);
		return { data: rows.map((row: StorageShareRow) => this.toInfo(row)), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
	}

	/** 查询单条分享，不恢复公开路径。 */
	async get(id: string): Promise<StorageShareInfo> {
		const row = await this.prisma.storageShare.findUnique({ where: { id } });
		if (!row) throw shareError("STORAGE_SHARE_NOT_FOUND", "Storage share not found", 404);
		return this.toInfo(row);
	}

	/** 幂等软撤销分享。 */
	async revoke(id: string, actor: ActorContext): Promise<StorageShareInfo> {
		const row = await this.prisma.storageShare.findUnique({ where: { id } });
		if (!row) throw shareError("STORAGE_SHARE_NOT_FOUND", "Storage share not found", 404);
		if (row.revokedAt) return this.toInfo(row);
		const updated = await this.prisma.storageShare.update({
			where: { id },
			data: { revokedAt: new Date(), revokedByIdentityId: actor.identityId },
		});
		return this.toInfo(updated);
	}

	/** 查询 File 是否仍被有效分享保护。 */
	async hasActiveShares(fileId: string): Promise<boolean> {
		const count = await this.prisma.storageShare.count({
			where: { fileId, revokedAt: null, invalidatedAt: null },
		});
		return count > 0;
	}

	/** 按公开 Token 哈希查找内部分享记录。 */
	async resolvePublic(token: string): Promise<StorageShareRow> {
		if (!TOKEN_RE.test(token)) throw shareError("STORAGE_SHARE_NOT_FOUND", "Not found", 404);
		const row = await this.prisma.storageShare.findUnique({
			where: { tokenHash: sha256(token) },
			include: { file: true },
		});
		if (!row) throw shareError("STORAGE_SHARE_NOT_FOUND", "Not found", 404);
		return row;
	}

	/** 标记 Provider 已确认永久缺失的分享。 */
	async markInvalid(id: string, reason: string): Promise<void> {
		await this.prisma.storageShare.updateMany({
			where: { id, revokedAt: null, invalidatedAt: null },
			data: { invalidatedAt: new Date(), invalidReason: reason },
		});
	}

	/** 将数据库行映射为不含 Token 的管理 DTO。 */
	toInfo(row: StorageShareRow): StorageShareInfo {
		return {
			id: row.id,
			fileId: row.fileId,
			filename: row.filename,
			mimeType: row.mimeType,
			storageKind: row.storageKind,
			status: statusOf(row),
			previewable: previewMime(row.filename) !== null,
			createdByIdentityId: row.createdByIdentityId,
			createdByName: row.createdByName,
			createdVia: row.createdVia,
			createdAt: row.createdAt.toISOString(),
			revokedAt: row.revokedAt?.toISOString() ?? null,
			revokedByIdentityId: row.revokedByIdentityId,
			invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
			invalidReason: row.invalidReason,
		};
	}

	private isUniqueError(error: unknown): boolean {
		return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
	}
}
