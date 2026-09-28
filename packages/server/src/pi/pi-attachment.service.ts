import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { FileService } from "../file/file.service.js";
import { StorageService } from "../storage/storage.service.js";
import type { PiAttachmentDescriptor, PiAttachmentRef } from "@vcpdeck/shared";
import { MAX_PI_IMAGE_BYTES, MAX_PI_IMAGES_PER_PROMPT, MAX_PI_IMAGES_TOTAL_BYTES } from "@vcpdeck/shared";

/** prompt 附件 TTL（15 分钟） */
const PROMPT_TTL_MS = 15 * 60 * 1000;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** prompt 图片引用允许的字段；多余字段一律拒绝，避免调用方夹带未校验语义。 */
const REF_KEYS = new Set([
	"fileId",
	"sha256",
	"size",
	"mimeType",
	"url",
	"expiresAt",
]);

export interface PiUploadImageInput {
	filename: string;
	size: number;
	mimeType: string;
}

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/**
 * Pi 临时附件：Browser 上传到 Storage → FileRef → Client 校验 → prompt。
 * File row 用 purpose=pi_prompt/pi_history、jobId=null、15 分钟 TTL；
 * 不使用临时对象时由 TTL 清理（cleanup scheduler 复用）。
 */
@Injectable()
export class PiAttachmentService {
	constructor(
		@Inject(FileService) private readonly files: FileService,
		@Inject(StorageService) private readonly storage: StorageService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	/** 校验图片清单（数量/单图/总量/MIME） */
	private validateImages(images: PiUploadImageInput[]): void {
		if (images.length === 0 || images.length > MAX_PI_IMAGES_PER_PROMPT) {
			throw piError("PI_IMAGE_INVALID", `Images count must be 1..${MAX_PI_IMAGES_PER_PROMPT}`);
		}
		let total = 0;
		for (const img of images) {
			if (!ALLOWED_MIME.has(img.mimeType)) {
				throw piError("PI_IMAGE_INVALID", `Unsupported image type: ${img.mimeType}`);
			}
			if (!Number.isFinite(img.size) || img.size <= 0) {
				throw piError("PI_IMAGE_INVALID", "Image size must be positive");
			}
			if (img.size > MAX_PI_IMAGE_BYTES) {
				throw piError("PI_IMAGE_TOO_LARGE", `Image exceeds ${MAX_PI_IMAGE_BYTES} bytes`);
			}
			total += img.size;
		}
		if (total > MAX_PI_IMAGES_TOTAL_BYTES) {
			throw piError("PI_IMAGE_TOO_LARGE", `Images total exceeds ${MAX_PI_IMAGES_TOTAL_BYTES} bytes`);
		}
	}

	/** 创建 prompt 附件上传会话（返回 PUT 令牌，未 complete 由 TTL 清理） */
	async createPromptUploads(
		clientId: string,
		images: PiUploadImageInput[],
	): Promise<Array<{ fileId: string; uploadUrl: string; expiresAt: number }>> {
		this.validateImages(images);
		const out: Array<{ fileId: string; uploadUrl: string; expiresAt: number }> = [];
		for (const img of images) {
			const pending = await this.files.createPending(
				undefined,
				clientId,
				{
					clientId,
					filename: img.filename,
					mimeType: img.mimeType,
					size: img.size,
				},
				{ expiresAt: new Date(Date.now() + PROMPT_TTL_MS), purpose: "pi_prompt" },
			);
			out.push({
				fileId: pending.fileId,
				uploadUrl: pending.uploadUrl,
				expiresAt: pending.expiresAt,
			});
		}
		return out;
	}

	/**
	 * 校验 prompt 携带的图片引用，并换成服务端当前签发的下载凭证。
	 *
	 * 权威是 File 行而不是请求体：只在同一 client、`purpose=pi_prompt`、已完成且未过期时接受，
	 * 并要求调用方提供的 sha256/size/mimeType 与 DB 完全一致；调用方的 `url` 一律丢弃。
	 * 形状与容量校验先于任何数据库访问，避免无效请求触碰存储层。
	 */
	async validatePromptRefs(
		clientId: string,
		refs: unknown,
	): Promise<PiAttachmentDescriptor[]> {
		if (
			!Array.isArray(refs) ||
			refs.length === 0 ||
			refs.length > MAX_PI_IMAGES_PER_PROMPT
		) {
			throw piError(
				"PI_IMAGE_INVALID",
				`Images count must be 1..${MAX_PI_IMAGES_PER_PROMPT}`,
			);
		}
		interface ExpectedRef {
			fileId: string;
			sha256: string;
			size: number;
			mimeType: string;
		}
		const seen = new Set<string>();
		let total = 0;
		const expectedRefs: ExpectedRef[] = [];
		for (const item of refs) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) {
				throw piError("PI_IMAGE_INVALID", "Attachment must be an object");
			}
			const record = item as Record<string, unknown>;
			for (const key of Object.keys(record)) {
				if (!REF_KEYS.has(key)) {
					throw piError("PI_IMAGE_INVALID", `Unexpected attachment field: ${key}`);
				}
			}
			const { fileId, sha256, size, mimeType } = record;
			if (
				typeof fileId !== "string" ||
				fileId.length === 0 ||
				typeof sha256 !== "string" ||
				sha256.length === 0 ||
				typeof mimeType !== "string" ||
				!ALLOWED_MIME.has(mimeType) ||
				typeof size !== "number" ||
				!Number.isFinite(size) ||
				size <= 0
			) {
				throw piError("PI_IMAGE_INVALID", "Attachment metadata is invalid");
			}
			if (size > MAX_PI_IMAGE_BYTES) {
				throw piError(
					"PI_IMAGE_TOO_LARGE",
					`Image exceeds ${MAX_PI_IMAGE_BYTES} bytes`,
				);
			}
			total += size;
			if (total > MAX_PI_IMAGES_TOTAL_BYTES) {
				throw piError(
					"PI_IMAGE_TOO_LARGE",
					`Images total exceeds ${MAX_PI_IMAGES_TOTAL_BYTES} bytes`,
				);
			}
			if (seen.has(fileId)) {
				throw piError("PI_IMAGE_INVALID", "Duplicate attachment");
			}
			seen.add(fileId);
			expectedRefs.push({ fileId, sha256, size, mimeType });
		}

		const now = Date.now();
		const out: PiAttachmentDescriptor[] = [];
		for (const expected of expectedRefs) {
			const file = await this.prisma.file.findUnique({
				where: { id: expected.fileId },
			});
			if (
				!file ||
				file.purpose !== "pi_prompt" ||
				file.clientId !== clientId ||
				file.status !== "completed"
			) {
				throw piError("PI_IMAGE_INVALID", "Attachment not found");
			}
			if (file.expiresAt !== null && file.expiresAt.getTime() <= now) {
				throw piError("PI_IMAGE_INVALID", "Attachment upload expired");
			}
			if (
				file.sha256 !== expected.sha256 ||
				file.size !== expected.size ||
				(file.mimeType ?? "") !== expected.mimeType
			) {
				throw piError("PI_IMAGE_INVALID", "Attachment metadata mismatch");
			}
			const download = await this.storage.createDownloadToken(file.key);
			out.push({
				fileId: file.id,
				sha256: file.sha256,
				size: file.size,
				mimeType: expected.mimeType,
				url: download.url,
			});
		}
		return out;
	}

	/** complete 后返回给 Client 的 transient 描述符（Client 下载并校验 hash/mime/magic） */
	async completePromptUpload(
		attachmentId: string,
		clientId: string,
	): Promise<PiAttachmentRef> {
		const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
		if (!file || file.purpose !== "pi_prompt" || file.clientId !== clientId) {
			throw piError("PI_IMAGE_INVALID", "Attachment not found");
		}
		if (file.status !== "completed") {
			throw piError("PI_IMAGE_INVALID", "Attachment upload not completed");
		}
		const dl = await this.storage.createDownloadToken(file.key);
		return {
			fileId: file.id,
			sha256: file.sha256,
			size: file.size,
			mimeType: file.mimeType ?? "application/octet-stream",
			url: dl.url,
			expiresAt: dl.expiresAt,
		};
	}

	/** 清理临时附件（prompt 拒绝/失败/取消时） */
	async deleteAttachment(attachmentId: string, clientId: string): Promise<void> {
		const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
		if (!file || file.clientId !== clientId) return;
		await this.files.delete(file.id);
	}

	/** 历史媒体三阶段第一步：Client 验证后创建 pi_history 上传会话 */
	async prepareHistoryUpload(
		clientId: string,
		meta: PiUploadImageInput,
	): Promise<{ fileId: string; uploadUrl: string; expiresAt: number }> {
		this.validateImages([meta]);
		const pending = await this.files.createPending(
			undefined,
			clientId,
			{
				clientId,
				filename: meta.filename,
				mimeType: meta.mimeType,
				size: meta.size,
			},
			{ expiresAt: new Date(Date.now() + PROMPT_TTL_MS), purpose: "pi_history" },
		);
		return {
			fileId: pending.fileId,
			uploadUrl: pending.uploadUrl,
			expiresAt: pending.expiresAt,
		};
	}

	/** 历史媒体第三步：Client 上传完成，返回浏览器短期 GET ref */
	async completeHistoryUpload(
		attachmentId: string,
		clientId: string,
	): Promise<{ url: string; expiresAt: number }> {
		const file = await this.prisma.file.findUnique({ where: { id: attachmentId } });
		if (!file || file.purpose !== "pi_history" || file.clientId !== clientId) {
			throw piError("PI_IMAGE_INVALID", "History attachment not found");
		}
		if (file.status !== "completed") {
			throw piError("PI_IMAGE_INVALID", "History attachment upload not completed");
		}
		const dl = await this.storage.createDownloadToken(file.key);
		return { url: dl.url, expiresAt: dl.expiresAt };
	}
}
