import { Injectable, type OnModuleInit, Logger } from "@nestjs/common";
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

	constructor(private readonly prisma: PrismaService) {}

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

		const ProviderClass = STORAGE_PROVIDERS[kind];
		if (!ProviderClass) {
			this.logger.warn(
				`Unknown storage kind "${kind}", falling back to local`,
			);
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
		if (!this.provider)
			throw new Error("Storage provider not initialized");
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

	/** 接收文件流并存储 */
	async receiveUpload(
		key: string,
		stream: Readable,
		expiresAt: number,
		sig: string,
	): Promise<FileEntry> {
		const p = this.getProvider();
		if (!p.verifyUploadSignature(key, expiresAt, sig)) {
			throw Object.assign(
				new Error("Invalid or expired upload signature"),
				{ statusCode: 403 },
			);
		}

		const pending = this.pendingUploads.get(key);
		if (!pending) {
			// 签名有效但内存缓存丢失（服务重启），从签名恢复最小元数据
			// ponytail: 丢失 jobId/clientId，后续 File 表解决
			return p.upload(stream, {
				jobId: "",
				clientId: "",
				filename: key.split("/").pop() || key,
				size: 0,
			});
		}

		this.pendingUploads.delete(key);
		return p.upload(stream, pending.meta);
	}

	/** 验证下载签名并返回文件流 + 元数据 */
	async downloadVerified(
		key: string,
		expiresAt: number,
		sig: string,
	): Promise<{ stream: Readable; meta: FileEntry }> {
		const p = this.getProvider();
		if (!p.verifyDownloadSignature(key, expiresAt, sig)) {
			throw Object.assign(
				new Error("Invalid or expired download signature"),
				{ statusCode: 403 },
			);
		}
		return p.download(key);
	}

	/** 删除文件 */
	async delete(key: string): Promise<void> {
		return this.getProvider().delete(key);
	}
}
