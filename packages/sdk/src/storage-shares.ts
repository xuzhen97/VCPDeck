import type {
	CreateStorageShareRequest,
	CreateStorageShareResult,
	PaginatedResult,
	StorageShareInfo,
	StorageShareStatus,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** Storage Share 认证管理 API。 */
export function createStorageSharesApi(client: Pick<VcpDeckClient, "request">) {
	return {
		create: (input: CreateStorageShareRequest, signal?: AbortSignal) =>
			client.request<CreateStorageShareResult>("POST", "/api/storage/shares", input, signal),
		list: (
			options: { fileId?: string; status?: StorageShareStatus; page?: number; pageSize?: number } = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options.fileId) params.set("fileId", options.fileId);
			if (options.status) params.set("status", options.status);
			if (options.page) params.set("page", String(options.page));
			if (options.pageSize) params.set("pageSize", String(options.pageSize));
			const query = params.toString();
			return client.request<PaginatedResult<StorageShareInfo>>(
				"GET",
				`/api/storage/shares${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
		get: (id: string, signal?: AbortSignal) =>
			client.request<StorageShareInfo>(
				"GET",
				`/api/storage/shares/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
		revoke: (id: string, signal?: AbortSignal) =>
			client.request<StorageShareInfo>(
				"DELETE",
				`/api/storage/shares/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
	};
}
