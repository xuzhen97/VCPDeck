import { Injectable } from "@nestjs/common";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type {
	StorageProvider,
	FileMeta,
	FileEntry,
} from "./storage-provider.interface.js";

const SIGN_UPLOAD_PREFIX = "upload";
const SIGN_DOWNLOAD_PREFIX = "download";

@Injectable()
export class LocalStorageProvider implements StorageProvider {
	private readonly baseDir: string;
	private readonly signSecret: string;

	constructor(config: Record<string, unknown> = {}) {
		this.baseDir = resolve((config.baseDir as string) || "./data/storage");
		this.signSecret = (config.signSecret as string) || randomUUID();
	}

	async upload(stream: Readable, meta: FileMeta): Promise<FileEntry> {
		return this.uploadToKey(stream, meta, this.makeKey(meta));
	}

	async uploadToKey(
		stream: Readable,
		meta: FileMeta,
		key: string,
	): Promise<FileEntry> {
		const filePath = resolve(this.baseDir, key);
		await mkdir(dirname(filePath), { recursive: true });
		await pipeline(stream, createWriteStream(filePath));
		return {
			...meta,
			key,
			storageKind: "local",
			createdAt: new Date(),
		};
	}

	async download(key: string): Promise<{ stream: Readable; meta: FileEntry }> {
		const filePath = resolve(this.baseDir, key);
		const st = await stat(filePath);
		const filename = key.split("/").pop() || key;
		return {
			stream: createReadStream(filePath),
			meta: {
				jobId: "",
				clientId: "",
				filename,
				size: st.size,
				key,
				storageKind: "local",
				// ponytail: birthtime 近似 createdAt，后续 File 表更准确
				createdAt: st.birthtime,
			},
		};
	}

	async delete(key: string): Promise<void> {
		try {
			await unlink(resolve(this.baseDir, key));
		} catch {
			// 文件已不存在，忽略
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
	private makeKey(meta: FileMeta): string {
		const safeFilename = meta.filename.replace(/[\\/:*?"<>|]/g, "_");
		return `${randomUUID()}/${safeFilename}`;
	}

	private sign(payload: string): string {
		return createHmac("sha256", this.signSecret).update(payload).digest("hex");
	}
}
