import type { VcpDeckClient } from "./client.js";

/** Storage 可用后端。 */
export type StorageBackendKind = "local" | "alibaba";

/** 当前激活 Storage 后端的安全摘要。 */
export interface StorageBackendStatus {
	kind: StorageBackendKind;
	updatedAt: string | null;
}

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
		getBackendConfig: (signal?: AbortSignal) =>
			client.request<StorageBackendStatus>(
				"GET",
				"/api/storage/config",
				undefined,
				signal,
			),
		createUploadToken: (
			input: StorageUploadTokenRequest,
			signal?: AbortSignal,
		) =>
			client.request<StorageToken>(
				"POST",
				"/api/storage/upload-token",
				input,
				signal,
			),
		createDownloadToken: (
			input: { key: string; ttlSeconds?: number },
			signal?: AbortSignal,
		) =>
			client.request<StorageToken>(
				"POST",
				"/api/storage/download-token",
				input,
				signal,
			),
		delete: (key: string, signal?: AbortSignal) =>
			client.request<{ ok: true }>(
				"DELETE",
				`/api/storage/${encodeURIComponent(key)}`,
				undefined,
				signal,
			),
		setBackend: (input: { kind: StorageBackendKind }, signal?: AbortSignal) =>
			client.request<StorageBackendStatus>(
				"PUT",
				"/api/storage/config",
				input,
				signal,
			),
	};
}
