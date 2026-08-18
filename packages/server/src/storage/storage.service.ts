import { Injectable, type OnModuleInit, Logger, Inject } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { STORAGE_PROVIDERS } from "./providers/providers.registry.js";
import { AlibabaStorageProvider } from "./providers/alibaba-storage.provider.js";
import type {
	StorageProvider,
	FileMeta,
	FileEntry,
} from "./providers/storage-provider.interface.js";
// biome-ignore lint/style/useImportType: NestJS DI needs runtime class reference
import { PrismaService } from "../prisma/prisma.service.js";

/** 待确认上传的元数据缓存（ponytail: 内存 Map，服务重启丢失，后续加 File 表持久化） */
interface PendingUpload {
	meta: FileMeta;
	createdAt: number;
}

/** 直传上传会话（ponytail: 内存 Map；上传中断需用户重试，重启后会话失效） */
interface DirectUploadSession {
	fileId: string; // 阿里云 fileId
	uploadId: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
	private readonly logger = new Logger(StorageService.name);
	private provider: StorageProvider | null = null;
	private pendingUploads = new Map<string, PendingUpload>();
	/** key = File 行主键（dbFileId） */
	private directUploadSessions = new Map<string, DirectUploadSession>();

	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	async onModuleInit() {
		await this.loadProvider();
	}

	/** 读取 DB 配置，初始化 provider */
	async loadProvider(): Promise<void> {
		const row = await this.prisma.storageBackendConfig.findFirst();
		const kind = row?.kind || "local";
		let config: Record<string, unknown> = {};
		try {
			config = JSON.parse(row?.config || "{}");
		} catch {
			this.logger.warn("Invalid storage config JSON, using defaults");
		}

		// 签名密钥持久化：缺失时生成并写回 DB，保证 server 重启后已签发链接仍有效
		if (!config.signSecret) {
			config.signSecret = randomUUID();
			await this.prisma.storageBackendConfig.upsert({
				where: { id: 1 },
				create: { id: 1, kind, config: JSON.stringify(config) },
				update: { config: JSON.stringify(config) },
			});
		}

		const ProviderClass = STORAGE_PROVIDERS[kind];
		if (!ProviderClass) {
			this.logger.warn(`Unknown storage kind "${kind}", falling back to local`);
			const Fallback = STORAGE_PROVIDERS["local"];
			this.provider = new Fallback(config);
			return;
		}

		this.provider = new ProviderClass(config);
		// 阿里云 token 刷新后写回 DB，避免服务重启后使用过期凭证
		if (this.provider instanceof AlibabaStorageProvider) {
			this.provider.setTokenPersistence(async (tokens) => {
				const row = await this.prisma.storageBackendConfig.findFirst();
				if (!row) return;
				let current: Record<string, unknown> = {};
				try {
					current = JSON.parse(row.config || "{}");
				} catch {
					current = {};
				}
				const merged = { ...current, ...tokens };
				await this.prisma.storageBackendConfig.upsert({
					where: { id: 1 },
					create: { id: 1, kind, config: JSON.stringify(merged) },
					update: { config: JSON.stringify(merged) },
				});
			});
		}
		this.logger.log(`Storage provider: ${kind}`);
	}

	/** 运行时切换后端（管理面板调用） */
	async reload(): Promise<void> {
		await this.loadProvider();
	}

	getProvider(): StorageProvider {
		if (!this.provider) throw new Error("Storage provider not initialized");
		return this.provider;
	}

	/** 获取支持直传的阿里云 provider（功能检测，便于测试 mock） */
	private requireDirectProvider(): AlibabaStorageProvider {
		const p = this.getProvider();
		if (typeof (p as AlibabaStorageProvider).createDirectUpload !== "function") {
			throw Object.assign(new Error("当前存储后端不支持直传"), {
				statusCode: 400,
			});
		}
		return p as AlibabaStorageProvider;
	}

	/** 是否支持目标机直连下载（ADR-0016：字节不经过 Server） */
	supportsDirectDownload(): boolean {
		const p = this.getProvider();
		return typeof p.getDirectDownloadUrl === "function";
	}

	/** 换取直连下载 URL（临时有效）；不支持直连返回 null */
	async getDirectDownloadUrl(
		key: string,
	): Promise<{ url: string; expiresAt: number } | null> {
		const p = this.getProvider();
		if (typeof p.getDirectDownloadUrl !== "function") return null;
		const result = await p.getDirectDownloadUrl(key);
		return result && typeof result.url === "string" && result.url
			? result
			: null;
	}

	/** 服务端直传存储（ADR-0016：发布构件转存外部后端） */
	async uploadStream(stream: Readable, meta: FileMeta): Promise<FileEntry> {
		return this.getProvider().upload(stream, meta);
	}

	/** 签发上传令牌，返回 FileRef */
	async createUploadToken(
		meta: FileMeta,
		ttlSeconds = 3600,
	): Promise<{ url: string; expiresAt: number }> {
		const p = this.getProvider();
		const key = `${randomUUID()}/${meta.filename.replace(/[\\/:*?"<>|]/g, "_")}`;
		const queryString = p.signUploadUrl(key, ttlSeconds);
		const expiresAt = parseInt(
			new URLSearchParams(queryString).get("expires") || "0",
			10,
		);

		this.pendingUploads.set(key, { meta, createdAt: Date.now() });

		return {
			url: `/api/storage/upload/${key}?${queryString}`,
			expiresAt,
		};
	}

	/** 签发下载令牌（内部/管理面板调用）；alibaba 后端返回阿里云临时外部 URL */
	async createDownloadToken(
		key: string,
		ttlSeconds = 3600,
	): Promise<{ url: string; expiresAt: number }> {
		const p = this.getProvider();
		if (typeof (p as AlibabaStorageProvider).getExternalDownloadUrl === "function") {
			// 直连后端：阿里云下载 URL 临时有效，每次实时生成，不签名
			return (p as AlibabaStorageProvider).getExternalDownloadUrl(key);
		}
		const queryString = p.signDownloadUrl(key, ttlSeconds);
		const expiresAt = parseInt(
			new URLSearchParams(queryString).get("expires") || "0",
			10,
		);
		return {
			url: `/api/storage/download/${key}?${queryString}`,
			expiresAt,
		};
	}

	/** 创建直传上传会话（上传方向：浏览器→远程），并把 File 行 key 更新为阿里云 fileId */
	async createDirectUploadSession(
		size: number,
		name: string,
		dbFileId: string,
	): Promise<{
		fileId: string;
		uploadId: string;
		partSize: number;
		parts: Array<{ partNumber: number; url: string }>;
	}> {
		const p = this.requireDirectProvider();
		const session = await p.createDirectUpload(size, name);
		this.directUploadSessions.set(dbFileId, {
			fileId: session.fileId,
			uploadId: session.uploadId,
		});
		await this.prisma.file.update({
			where: { id: dbFileId },
			data: { key: session.fileId },
		});
		return {
			fileId: session.fileId,
			uploadId: session.uploadId,
			partSize: session.partSize,
			parts: session.parts,
		};
	}

	/** 完成上传方向直传：校验字节数、合并分片、File 置 completed */
	async completeDirectUploadSession(
		dbFileId: string,
		uploadedBytes: number,
	): Promise<void> {
		const p = this.requireDirectProvider();
		const session = this.directUploadSessions.get(dbFileId);
		if (!session) {
			throw Object.assign(new Error("直传会话不存在或已过期"), {
				code: "UPLOAD_SESSION_NOT_FOUND",
			});
		}
		const file = await this.prisma.file.findUniqueOrThrow({
			where: { id: dbFileId },
		});
		if (file.size !== uploadedBytes) {
			throw Object.assign(
				new Error(
					`上传字节数不匹配：期望 ${file.size}，实际 ${uploadedBytes}`,
				),
				{ code: "SIZE_MISMATCH", statusCode: 400 },
			);
		}
		await p.completeDirectUpload(session.fileId, session.uploadId);
		await this.prisma.file.update({
			where: { id: dbFileId },
			data: { status: "completed", storageKind: "alibaba", sha256: "" },
		});
		this.directUploadSessions.delete(dbFileId);
	}

	/** 创建导出直传会话（导出方向：远程→浏览器，Client stat 后协商） */
	async createExportSession(
		jobId: string,
		size: number,
	): Promise<{
		fileId: string;
		uploadId: string;
		partSize: number;
		parts: Array<{ partNumber: number; url: string }>;
	}> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== "file.export") {
			throw Object.assign(new Error(`导出任务 ${jobId} 不存在`), {
				code: "UPLOAD_SESSION_NOT_FOUND",
			});
		}
		let parsed: { path?: string } = {};
		try {
			parsed = JSON.parse(job.payload || "{}") as { path?: string };
		} catch {
			parsed = {};
		}
		const filename = String(parsed.path ?? "file")
			.split(/[\\\\/]/)
			.pop() || "file";
		const file = await this.prisma.file.findFirst({ where: { jobId } });
		if (!file) {
			throw Object.assign(new Error("导出任务缺少 File 记录"), {
				code: "FILE_NOT_READY",
			});
		}
		const p = this.requireDirectProvider();
		const session = await p.createDirectUpload(size, filename);
		this.directUploadSessions.set(file.id, {
			fileId: session.fileId,
			uploadId: session.uploadId,
		});
		await this.prisma.file.update({
			where: { id: file.id },
			data: { size, key: session.fileId },
		});
		return {
			fileId: session.fileId,
			uploadId: session.uploadId,
			partSize: session.partSize,
			parts: session.parts,
		};
	}

	/** 完成导出直传：校验字节数、合并分片、File 置 completed，返回真实 key */
	async completeExportUpload(
		jobId: string,
		uploadedBytes: number,
	): Promise<{ key: string }> {
		const file = await this.prisma.file.findFirst({ where: { jobId } });
		if (!file) {
			throw Object.assign(new Error("导出任务缺少 File 记录"), {
				code: "FILE_NOT_READY",
			});
		}
		const session = this.directUploadSessions.get(file.id);
		if (!session) {
			throw Object.assign(new Error("直传会话不存在或已过期"), {
				code: "UPLOAD_SESSION_NOT_FOUND",
			});
		}
		if (file.size !== uploadedBytes) {
			throw Object.assign(
				new Error(
					`上传字节数不匹配：期望 ${file.size}，实际 ${uploadedBytes}`,
				),
				{ code: "SIZE_MISMATCH", statusCode: 400 },
			);
		}
		const p = this.requireDirectProvider();
		await p.completeDirectUpload(session.fileId, session.uploadId);
		await this.prisma.file.update({
			where: { id: file.id },
			data: { status: "completed", storageKind: "alibaba", sha256: "" },
		});
		this.directUploadSessions.delete(file.id);
		return { key: session.fileId };
	}

	/** 续期直传会话指定分片的上传 URL */
	async refreshDirectPartUrls(
		jobId: string,
		partNumbers: number[],
	): Promise<Array<{ partNumber: number; url: string }>> {
		const file = await this.prisma.file.findFirst({ where: { jobId } });
		const dbFileId = file?.id ?? jobId;
		const session =
			this.directUploadSessions.get(dbFileId) ??
			this.directUploadSessions.get(jobId);
		if (!session) {
			throw Object.assign(new Error("直传会话不存在或已过期"), {
				code: "UPLOAD_SESSION_NOT_FOUND",
			});
		}
		const p = this.requireDirectProvider();
		return p.refreshPartUrls(session.fileId, session.uploadId, partNumbers);
	}

	/** 直传进度上报：写入 job.progress（total 取 File.size） */
	async updateUploadProgress(jobId: string, loaded: number): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) return;
		let payload: { fileId?: string } = {};
		try {
			payload = JSON.parse(job.payload || "{}") as { fileId?: string };
		} catch {
			payload = {};
		}
		const file = payload.fileId
			? await this.prisma.file.findUnique({
					where: { id: payload.fileId },
					select: { size: true },
				})
			: null;
		await this.updateJobProgress(jobId, loaded, file?.size ?? loaded);
	}

	/** 接收文件流并存储 */
	async receiveUpload(
		key: string,
		stream: Readable,
		expiresAt: number,
		sig: string,
	): Promise<FileEntry> {
		const p = this.getProvider();
		if (!p.verifyUploadSignature(key, expiresAt, sig)) {
			throw Object.assign(new Error("Invalid or expired upload signature"), {
				statusCode: 403,
			});
		}

		const uploadAndPersist = async (meta: FileMeta) => {
			const jobId = meta.jobId;
			const job = jobId
				? await this.prisma.job.findUnique({
						where: { id: jobId },
						select: { type: true },
					})
				: null;
			// Pi 临时附件无 jobId：不上报进度
			const reportProgress = jobId !== undefined && job?.type === "file.import";
			const hash = createHash("sha256");
			let loaded = 0;
			let lastEmitAt = 0;
			let lastEmitBytes = 0;
			let progressWrite = Promise.resolve();
			const tracker = new Transform({
				transform: (chunk, _encoding, callback) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					hash.update(buffer);
					loaded += buffer.length;
					if (reportProgress) {
						const now = Date.now();
						if (
							now - lastEmitAt >= 500 ||
							loaded - lastEmitBytes >= 1024 * 1024
						) {
							lastEmitAt = now;
							lastEmitBytes = loaded;
							progressWrite = progressWrite
								.then(() =>
									this.updateJobProgress(jobId!, loaded, meta.size),
								)
								.catch(() => {});
						}
					}
					callback(null, buffer);
				},
				flush: (callback) => {
					if (reportProgress && loaded !== lastEmitBytes) {
						lastEmitBytes = loaded;
						progressWrite = progressWrite
							.then(() =>
								this.updateJobProgress(jobId!, loaded, meta.size),
							)
							.catch(() => {});
					}
					callback();
				},
			});

			try {
				const entry = await p.uploadToKey(stream.pipe(tracker), meta, key);
				await progressWrite;
				await this.prisma.file.updateMany({
					where: { key },
					data: {
						key: entry.key,
						status: "completed",
						size: loaded,
						sha256: hash.digest("hex"),
					},
				});
				return entry;
			} catch (error) {
				if (reportProgress) await this.markUploadJobError(jobId!);
				throw error;
			}
		};

		const pending = this.pendingUploads.get(key);
		if (!pending) {
			const file = await this.prisma.file.findUnique({ where: { key } });
			if (file) {
				return uploadAndPersist({
					jobId: file.jobId ?? undefined,
					clientId: file.clientId,
					filename: file.filename,
					mimeType: file.mimeType ?? undefined,
					size: file.size,
				});
			}

			// 签名有效但内存缓存和 File 记录都丢失时，使用最小元数据兜底。
			this.logger.warn(`receiveUpload fallback (pending 丢失): key=${key.slice(0, 40)}`);
			return uploadAndPersist({
				jobId: "",
				clientId: "",
				filename: key.split("/").pop() || key,
				size: 0,
			});
		}

		this.pendingUploads.delete(key);
		return uploadAndPersist(pending.meta);
	}

	private async updateJobProgress(
		jobId: string,
		loaded: number,
		total: number,
	): Promise<void> {
		try {
			await this.prisma.job.update({
				where: { id: jobId },
				data: { progress: JSON.stringify({ loaded, total }) },
			});
		} catch (error) {
			this.logger.warn(`Unable to persist upload progress for job ${jobId}`);
		}
	}

	private async markUploadJobError(jobId: string): Promise<void> {
		try {
			await this.prisma.job.update({
				where: { id: jobId },
				data: {
					status: "error",
					errorCode: "IO_ERROR",
					errorMessage: "Storage upload failed",
					finishedAt: new Date(),
				},
			});
		} catch (error) {
			this.logger.warn(`Unable to persist upload failure for job ${jobId}`);
		}
	}

	/** 验证下载签名并返回文件流 + 元数据 */
	async downloadVerified(
		key: string,
		expiresAt: number,
		sig: string,
	): Promise<{ stream: Readable; meta: FileEntry }> {
		const p = this.getProvider();
		if (!p.verifyDownloadSignature(key, expiresAt, sig)) {
			throw Object.assign(new Error("Invalid or expired download signature"), {
				statusCode: 403,
			});
		}
		return p.download(key);
	}

	/** 从 DB File 记录解析真实文件名（阿里云盘后端 key 为 fileId，无文件名语义） */
	async resolveFilename(key: string): Promise<string | null> {
		const file = await this.prisma.file.findFirst({
			where: { key },
			select: { filename: true },
		});
		return file?.filename ?? null;
	}

	/** 删除文件 */
	async delete(key: string): Promise<void> {
		return this.getProvider().delete(key);
	}

	/** 获取当前激活后端的安全摘要，不返回 provider 原始配置。 */
	async getBackendConfig(): Promise<{
		kind: "local" | "alibaba";
		updatedAt: string | null;
	}> {
		const row = await this.prisma.storageBackendConfig.findFirst();
		return {
			kind: row?.kind === "alibaba" ? "alibaba" : "local",
			updatedAt: row?.updatedAt?.toISOString() || null,
		};
	}

	/** 更新存储后端配置并热切换 */
	async updateBackendConfig(body: {
		kind?: string;
		config?: Record<string, unknown>;
	}) {
		if (body.kind) {
			await this.prisma.storageBackendConfig.upsert({
				where: { id: 1 },
				create: {
					id: 1,
					kind: body.kind,
					config: JSON.stringify(body.config ?? {}),
				},
				update: { kind: body.kind },
			});
		}
		if (body.config) {
			await this.prisma.storageBackendConfig.upsert({
				where: { id: 1 },
				create: { id: 1, kind: "local", config: JSON.stringify(body.config) },
				update: { config: JSON.stringify(body.config) },
			});
		}
		// 热切换 provider
		await this.reload();
	}
}
