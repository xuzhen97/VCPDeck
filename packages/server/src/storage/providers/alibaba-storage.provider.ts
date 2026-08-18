/**
 * 阿里云盘存储后端 — 实现 StorageProvider 接口
 *
 * 将阿里云盘作为 VCPDeck 的文件存储后端。
 * 上传：接收流 → 临时文件 → 阿里云盘分片上传 → 返回 fileId 作为 key
 * 下载：通过 fileId → 阿里云盘获取下载 URL → 流式返回
 * 签名：沿用 HMAC 本地签名（用于 Server↔Client 间的预签名 URL）
 *
 * 配置示例（存入 StorageBackendConfig.config）：
 * {
 *   "clientId": "...",
 *   "clientSecret": "...",
 *   "refreshToken": "...",
 *   "transferFolder": "VCPDeckTransfers"
 * }
 *
 * ponytail: 令牌只在内存中刷新，服务重启后从 DB 重新读取
 */
import { Injectable, Logger } from "@nestjs/common";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { randomUUID, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { AlibabaOpenApiClient } from "./alibaba-openapi.client.js";
import {
	DEFAULT_OPENAPI_BASE,
	DEFAULT_TRANSFER_FOLDER,
	DEFAULT_PART_SIZE,
	MAX_PARTS,
} from "./alibaba-types.js";
import type { AlibabaStorageConfig } from "./alibaba-types.js";

/** 直传分片大小（与现有 uploadToKey 的分片逻辑一致） */
export const ALIBABA_PART_SIZE = DEFAULT_PART_SIZE;
import type {
	StorageProvider,
	FileMeta,
	FileEntry,
} from "./storage-provider.interface.js";

const SIGN_UPLOAD_PREFIX = "upload";
const SIGN_DOWNLOAD_PREFIX = "download";

/** 刷新后需要持久化的 token 字段 */
export interface TokenPersistence {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

/** 缓存可更新的运行时配置（ponytail: 内存可变副本，重启丢失刷新后的 token） */
interface RuntimeConfig {
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	driveId: string;
	transferFolder: string;
	openapiBase: string;
}

@Injectable()
export class AlibabaStorageProvider implements StorageProvider {
	private readonly logger = new Logger(AlibabaStorageProvider.name);
	private readonly signSecret: string;
	private runtime: RuntimeConfig | null = null;
	private persistTokens?: (tokens: TokenPersistence) => Promise<void>;
	constructor(config: Record<string, unknown> = {}) {
		const parsed = config as Partial<AlibabaStorageConfig>;
		this.signSecret = parsed.signSecret || randomUUID();

		// 仅在有完整配置时才初始化
		if (parsed.clientId && parsed.accessToken) {
			this.runtime = {
				clientId: parsed.clientId,
				clientSecret: parsed.clientSecret || "",
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken || "",
				expiresAt: parsed.expiresAt || 0,
				driveId: parsed.driveId || "",
				transferFolder: parsed.transferFolder || DEFAULT_TRANSFER_FOLDER,
				openapiBase: parsed.openapiBase || DEFAULT_OPENAPI_BASE,
			};
		}
	}

	/** 懒加载 driveId（首次调用时获取） */
	private async ensureReady(): Promise<RuntimeConfig> {
		if (!this.runtime) {
			throw new Error(
				"阿里云盘未配置或未授权。请在 StorageBackendConfig.config 中设置 clientId + accessToken/refreshToken",
			);
		}

		// 检查 token 是否过期，尝试刷新
		if (
			this.runtime.refreshToken &&
			this.runtime.expiresAt < Date.now() + 300_000
		) {
			await this.refreshAccessToken();
		}

		// 获取 driveId
		if (!this.runtime.driveId) {
			const client = this.makeClient();
			const { driveId } = await client.getDriveInfo();
			this.runtime.driveId = driveId;
		}

		return this.runtime;
	}

	/** 注册 token 刷新后的持久化回调（写回 DB，保证重启后不丢失） */
	setTokenPersistence(fn: (tokens: TokenPersistence) => Promise<void>): void {
		this.persistTokens = fn;
	}

	private makeClient(): AlibabaOpenApiClient {
		if (!this.runtime) throw new Error("未配置阿里云盘");
		return new AlibabaOpenApiClient({
			openapiBase: this.runtime.openapiBase,
			accessToken: this.runtime.accessToken,
		});
	}

	/** 刷新 access_token */
	private async refreshAccessToken(): Promise<void> {
		if (!this.runtime) return;
		const body: Record<string, string> = {
			client_id: this.runtime.clientId,
			grant_type: "refresh_token",
			refresh_token: this.runtime.refreshToken,
		};
		if (this.runtime.clientSecret) {
			body.client_secret = this.runtime.clientSecret;
		}
		const response = await fetch(
			`${this.runtime.openapiBase}/oauth/access_token`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) {
			throw new Error(
				`阿里云盘 token 刷新失败: HTTP ${response.status} ${await response.text()}`,
			);
		}
		const data = (await response.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
			token_type?: string;
		};
		this.runtime.accessToken = data.access_token;
		if (data.refresh_token) this.runtime.refreshToken = data.refresh_token;
		this.runtime.expiresAt = Date.now() + data.expires_in * 1000;

		// 刷新成功：把新凭证写回 DB，避免服务重启后使用过期 token
		if (this.persistTokens) {
			await this.persistTokens({
				accessToken: this.runtime.accessToken,
				refreshToken: this.runtime.refreshToken,
				expiresAt: this.runtime.expiresAt,
			});
		}
	}

	// ── 直传会话（浏览器 / Client 直连 OSS） ──

	/** 创建直传上传会话，返回各分片预签名 URL */
	async createDirectUpload(
		size: number,
		name: string,
	): Promise<{
		fileId: string;
		uploadId: string;
		partSize: number;
		parts: Array<{ partNumber: number; url: string }>;
	}> {
		const rt = await this.ensureReady();
		const client = this.makeClient();
		const folderId = await client.ensureFolderPath({
			driveId: rt.driveId,
			folderPath: rt.transferFolder,
		});
		const partSize = this.resolvePartSize(size);
		const partCount = Math.max(1, Math.ceil(size / partSize));
		const created = await client.createFileUpload({
			driveId: rt.driveId,
			parentFileId: folderId,
			name,
			size,
			partInfoList: Array.from({ length: partCount }, (_, i) => ({
				part_number: i + 1,
			})),
		});
		const fileId = String(created.file_id ?? created.fileId ?? "");
		const uploadId = String(created.upload_id ?? created.uploadId ?? "");
		if (!fileId || !uploadId) {
			throw new Error("阿里云盘创建上传任务未返回 file_id/upload_id");
		}

		const list = (created.part_info_list ??
			created.partInfoList ??
			[]) as Array<Record<string, unknown>>;
		const parts = list
			.map((p) => ({
				partNumber: Number(p.part_number ?? p.partNumber ?? 0),
				url: String(p.upload_url ?? p.uploadUrl ?? ""),
			}))
			.filter((p) => p.partNumber > 0 && p.url);

		// create 响应可能不带 upload_url：缺哪些分片就补哪些
		const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter(
			(n) => !parts.some((p) => p.partNumber === n),
		);
		if (missing.length > 0) {
			const refreshed = await this.refreshPartUrls(fileId, uploadId, missing);
			parts.push(...refreshed);
		}
		parts.sort((a, b) => a.partNumber - b.partNumber);
		if (parts.length !== partCount) {
			throw new Error("阿里云盘未返回全部分片上传 URL");
		}
		return { fileId, uploadId, partSize, parts };
	}

	/** 续期指定分片的上传 URL */
	async refreshPartUrls(
		fileId: string,
		uploadId: string,
		partNumbers: number[],
	): Promise<Array<{ partNumber: number; url: string }>> {
		const rt = await this.ensureReady();
		const client = this.makeClient();
		const result = await client.getUploadUrl({
			driveId: rt.driveId,
			fileId,
			uploadId,
			partNumbers,
		});
		const list = (result.part_info_list ?? result.partInfoList ?? []) as Array<
			Record<string, unknown>
		>;
		return list
			.map((p) => ({
				partNumber: Number(p.part_number ?? p.partNumber ?? 0),
				url: String(p.upload_url ?? p.uploadUrl ?? ""),
			}))
			.filter((p) => p.partNumber > 0 && p.url);
	}

	/** 完成直传（合并分片） */
	async completeDirectUpload(fileId: string, uploadId: string): Promise<void> {
		const rt = await this.ensureReady();
		const client = this.makeClient();
		await client.completeUpload({ driveId: rt.driveId, fileId, uploadId });
	}

	/** 获取外部下载 URL（临时，约 15 分钟） */
	async getExternalDownloadUrl(
		fileId: string,
	): Promise<{ url: string; expiresAt: number }> {
		const rt = await this.ensureReady();
		const client = this.makeClient();
		const result = await client.getDownloadUrl({ driveId: rt.driveId, fileId });
		const url = String(result.url ?? "");
		if (!url) throw new Error("阿里云盘未返回下载 URL");
		const raw = result.expire_time ?? result.expiresAt ?? 0;
		const expiresAt =
			typeof raw === "string" ? Date.parse(raw) : Number(raw);
		return { url, expiresAt };
	}

	/** StorageProvider 直连下载 URL（ADR-0016：目标机直连网盘下载） */
	async getDirectDownloadUrl(
		key: string,
	): Promise<{ url: string; expiresAt: number } | null> {
		return this.getExternalDownloadUrl(key);
	}

	// ── StorageProvider 实现 ──

	async upload(stream: Readable, meta: FileMeta): Promise<FileEntry> {
		return this.uploadToKey(stream, meta, "");
	}

	async uploadToKey(
		stream: Readable,
		meta: FileMeta,
		_key: string,
	): Promise<FileEntry> {
		const rt = await this.ensureReady();
		const client = this.makeClient();

		// 1. 确保中转文件夹存在
		const folderId = await client.ensureFolderPath({
			driveId: rt.driveId,
			folderPath: rt.transferFolder,
		});

		// 2. 将流写入临时文件
		const tmpDir = resolve(tmpdir(), "vcpdeck-aliyun");
		await mkdir(tmpDir, { recursive: true });
		const tmpPath = resolve(tmpDir, `${randomUUID()}-${meta.filename}`);
		await pipeline(stream, createWriteStream(tmpPath));

		let fileId = "";
		try {
			const { size: fileSize } = await stat(tmpPath);
			const actualSize = fileSize || meta.size;

			// 3. 计算分片
			const partSize = this.resolvePartSize(actualSize);
			const partCount = Math.max(1, Math.ceil(actualSize / partSize));
			const partInfoList = Array.from({ length: partCount }, (_, i) => ({
				part_number: i + 1,
			}));

			// 4. 创建文件上传任务
			const createResult = await client.createFileUpload({
				driveId: rt.driveId,
				parentFileId: folderId,
				name: meta.filename,
				size: actualSize,
				partInfoList,
			});
			fileId = String(createResult.file_id ?? createResult.fileId ?? "");
			const uploadId = String(
				createResult.upload_id ?? createResult.uploadId ?? "",
			);
			if (!fileId || !uploadId) {
				throw new Error("阿里云盘创建上传任务未返回 file_id/upload_id");
			}

			// 5. 逐分片上传
			for (const part of partInfoList) {
				const partNumber = part.part_number;
				const partStart = (partNumber - 1) * partSize;
				const partEnd = Math.min(partStart + partSize, actualSize);
				// 获取上传 URL
				const urlResult = await client.getUploadUrl({
					driveId: rt.driveId,
					fileId,
					uploadId,
					partNumbers: [partNumber],
				});
				const urlParts = (urlResult.part_info_list ??
					urlResult.partInfoList ??
					[]) as Array<Record<string, unknown>>;
				const urlPart = urlParts.find(
					(p) => Number(p.part_number ?? p.partNumber ?? 0) === partNumber,
				);
				const uploadUrl = String(
					urlPart?.upload_url ?? urlPart?.uploadUrl ?? "",
				);
				if (!uploadUrl) {
					throw new Error(`阿里云盘未返回分片 ${partNumber} 的上传 URL`);
				}

				// 读取分片数据并上传
				const partStream = createReadStream(tmpPath, {
					start: partStart,
					end: partEnd - 1,
				});
				const chunks: Buffer[] = [];
				for await (const chunk of partStream) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				}
				const buffer = Buffer.concat(chunks);

				// ponytail: 最多 3 次重试，后续加强为指数退避
				let lastError: Error | null = null;
				for (let attempt = 1; attempt <= 3; attempt++) {
					try {
						const putResp = await fetch(uploadUrl, {
							method: "PUT",
							headers: { "Content-Type": "" },
							body: buffer,
						});
						if (putResp.ok) {
							lastError = null;
							break;
						}
						// 401/403 刷新 URL
						if (
							(putResp.status === 401 || putResp.status === 403) &&
							attempt < 3
						) {
							const refreshed = await client.getUploadUrl({
								driveId: rt.driveId,
								fileId,
								uploadId,
								partNumbers: [partNumber],
							});
							const refreshedParts = (refreshed.part_info_list ??
								refreshed.partInfoList ??
								[]) as Array<Record<string, unknown>>;
							const refreshedPart = refreshedParts.find(
								(p) =>
									Number(p.part_number ?? p.partNumber ?? 0) === partNumber,
							);
							const newUrl = String(
								refreshedPart?.upload_url ?? refreshedPart?.uploadUrl ?? "",
							);
							if (newUrl) {
								// 更新 URL 供下一次重试
								(urlPart as Record<string, unknown>).upload_url = newUrl;
							}
						}
						lastError = new Error(
							`上传分片 ${partNumber} 失败: HTTP ${putResp.status}`,
						);
					} catch (err) {
						lastError = err instanceof Error ? err : new Error(String(err));
					}
					if (attempt < 3 && lastError) {
						await new Promise((r) => setTimeout(r, 500 * attempt));
					}
				}
				if (lastError) throw lastError;
			}

			// 6. 完成上传
			await client.completeUpload({
				driveId: rt.driveId,
				fileId,
				uploadId,
			});
		} finally {
			// 清理临时文件
			await unlink(tmpPath).catch(() => {});
		}

		return {
			...meta,
			key: fileId,
			storageKind: "alibaba",
			createdAt: new Date(),
		};
	}

	async download(key: string): Promise<{ stream: Readable; meta: FileEntry }> {
		const rt = await this.ensureReady();
		const client = this.makeClient();

		const result = await client.getDownloadUrl({
			driveId: rt.driveId,
			fileId: key,
		});
		const downloadUrl = String(
			result.url ?? result.download_url ?? result.downloadUrl ?? "",
		);
		if (!downloadUrl) {
			throw new Error("阿里云盘未返回下载 URL");
		}

		const response = await fetch(downloadUrl);
		if (!response.ok || !response.body) {
			throw new Error(`阿里云盘下载失败: HTTP ${response.status}`);
		}

		// ponytail: 将 Web ReadableStream 转为 Node.js Readable；
		// 上游中断时通过 error 事件向上传递（controller 销毁响应）
		const webStream = response.body;
		const nodeStream = Readable.fromWeb(webStream as any);
		nodeStream.on("error", (err) => {
			this.logger.warn(`阿里云盘下载流中断: ${(err as Error).message}`);
		});

		return {
			stream: nodeStream,
			meta: {
				jobId: "",
				clientId: "",
				filename: key,
				mimeType: response.headers.get("content-type") || undefined,
				size: parseInt(response.headers.get("content-length") || "0", 10),
				key,
				storageKind: "alibaba",
				createdAt: new Date(),
			},
		};
	}

	async delete(key: string): Promise<void> {
		const rt = await this.ensureReady();
		const client = this.makeClient();
		try {
			await client.deleteFile({ driveId: rt.driveId, fileId: key });
		} catch (err) {
			// 404 视为已删除
			const msg = err instanceof Error ? err.message : String(err);
			if (!/404|not found/i.test(msg)) throw err;
		}
	}

	signDownloadUrl(key: string, expiresInSeconds: number): string {
		// ttlSeconds <= 0 表示永久链接（expires=0），由清理任务兜底回收
		const expiresAt =
			expiresInSeconds <= 0 ? 0 : Date.now() + expiresInSeconds * 1000;
		const sig = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
		return `expires=${expiresAt}&sig=${sig}`;
	}

	signUploadUrl(key: string, expiresInSeconds: number): string {
		const expiresAt = Date.now() + expiresInSeconds * 1000;
		const sig = this.sign(`${SIGN_UPLOAD_PREFIX}:${key}:${expiresAt}`);
		return `expires=${expiresAt}&sig=${sig}`;
	}

	verifyDownloadSignature(
		key: string,
		expiresAt: number,
		sig: string,
	): boolean {
		// expires=0 为永久链接标记，不做时间校验
		if (expiresAt > 0 && Date.now() > expiresAt) return false;
		const expected = this.sign(`${SIGN_DOWNLOAD_PREFIX}:${key}:${expiresAt}`);
		return expected === sig;
	}

	verifyUploadSignature(key: string, expiresAt: number, sig: string): boolean {
		if (Date.now() > expiresAt) return false;
		const expected = this.sign(`${SIGN_UPLOAD_PREFIX}:${key}:${expiresAt}`);
		return expected === sig;
	}

	// ── internal ──

	private sign(payload: string): string {
		return createHmac("sha256", this.signSecret).update(payload).digest("hex");
	}

	private resolvePartSize(fileSize: number): number {
		const candidates = [
			DEFAULT_PART_SIZE,
			128 * 1024 * 1024,
			256 * 1024 * 1024,
			512 * 1024 * 1024,
		];
		for (const size of candidates) {
			if (Math.ceil(fileSize / size) <= MAX_PARTS) return size;
		}
		throw new Error("文件超过阿里云盘分片限制");
	}
}
