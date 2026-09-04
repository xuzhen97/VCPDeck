import type { Readable } from "node:stream";

/** Provider 明确确认对象不存在时使用的错误。 */
export class StorageObjectNotFoundError extends Error {
	constructor() {
		super("Storage object not found");
		this.name = "StorageObjectNotFoundError";
	}
}

/** 文件元数据（上传时提供） */
export interface FileMeta {
	/** 关联 Job；Pi 临时附件在 Job 创建前上传，可为空 */
	jobId?: string;
	clientId: string;
	filename: string;
	mimeType?: string;
	size: number;
}

/** 存储后的文件条目 */
export interface FileEntry extends FileMeta {
	key: string;
	storageKind: string;
	createdAt: Date;
}

/** 可扩展的存储后端接口 */
export interface StorageProvider {
	/** 服务端主动上传（如下发脚本前暂存） */
	upload(stream: Readable, meta: FileMeta): Promise<FileEntry>;

	/** 上传到指定 key（预签名 URL 回调用） */
	uploadToKey(stream: Readable, meta: FileMeta, key: string): Promise<FileEntry>;

	/** 服务端主动下载 */
	download(key: string): Promise<{ stream: Readable; meta: FileEntry }>;

	/** 删除文件 */
	delete(key: string): Promise<void>;

	/** 签发下载预签名 URL（返回 query string 部分，不含 base） */
	signDownloadUrl(key: string, expiresInSeconds: number): string;

	/** 签发上传预签名 URL（返回 query string 部分，不含 base） */
	signUploadUrl(key: string, expiresInSeconds: number): string;

	/** 验证下载签名 */
	verifyDownloadSignature(key: string, expiresAt: number, sig: string): boolean;

	/** 验证上传签名 */
	verifyUploadSignature(key: string, expiresAt: number, sig: string): boolean;

	/** 换取目标机直连下载 URL（临时有效，字节不经过 Server）；不支持返回 null（ADR-0016） */
	getDirectDownloadUrl?(
		key: string,
	): Promise<{ url: string; expiresAt: number } | null>;
}
