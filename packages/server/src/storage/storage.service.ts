import { Injectable, type OnModuleInit, Logger, Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { STORAGE_PROVIDERS } from "./providers/providers.registry.js";
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

@Injectable()
export class StorageService implements OnModuleInit {
	private readonly logger = new Logger(StorageService.name);
	private provider: StorageProvider | null = null;
	private pendingUploads = new Map<string, PendingUpload>();

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

	/** 签发下载令牌（内部/管理面板调用） */
	createDownloadToken(
		key: string,
		ttlSeconds = 3600,
	): { url: string; expiresAt: number } {
		const p = this.getProvider();
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
			const entry = await p.uploadToKey(stream, meta, key);
			await this.prisma.file.updateMany({
				where: { key },
				data: { key: entry.key, status: "completed" },
			});
			return entry;
		};

		const pending = this.pendingUploads.get(key);
		if (!pending) {
			const file = await this.prisma.file.findUnique({ where: { key } });
			if (file) {
				return uploadAndPersist({
					jobId: file.jobId,
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
