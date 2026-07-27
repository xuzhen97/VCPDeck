import type { VcpDeckClient } from "./client.js";

/** Storage 签名 URL。 */
export interface StorageToken {
	url: string;
	expiresAt: number;
}

/** Storage 上传 URL 请求。 */
export interface StorageUploadTokenRequest {
	jobId: string;
	clientId: string;
	filename: string;
	size: number;
	mimeType?: string;
	ttlSeconds?: number;
}

/** 创建 Storage API；有意不暴露原始配置读取。 */
export function createStorageApi(client: Pick<VcpDeckClient, "request">) {
	return {
		createUploadToken: (input: StorageUploadTokenRequest, signal?: AbortSignal) =>
			client.request<StorageToken>("POST", "/api/storage/upload-token", input, signal),
		createDownloadToken: (
			input: { key: string; ttlSeconds?: number },
			signal?: AbortSignal,
		) => client.request<StorageToken>("POST", "/api/storage/download-token", input, signal),
		delete: (key: string, signal?: AbortSignal) =>
			client.request<{ ok: true }>(
				"DELETE",
				`/api/storage/${encodeURIComponent(key)}`,
				undefined,
				signal,
			),
		setBackend: (input: { kind: "local" | "alibaba" }, signal?: AbortSignal) =>
			client.request<{ kind: string }>("PUT", "/api/storage/config", input, signal),
	};
}
