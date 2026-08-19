import type {
	PaginatedResult,
	ReleaseInfo,
	ReleasePlatform,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 服务端状态信息（GET /api/status） */
export interface ServerStatus {
	serverVersion: string;
	activeRelease: ReleaseInfo | null;
}

/** Release archive 上传参数；调用方负责计算 SHA-256。 */
export interface ReleaseUploadInput {
	version: string;
	platform: ReleasePlatform;
	sha256: string;
	archive: BodyInit;
	contentType?: string;
	/** Node.js Readable 等流式 body 需要设置为 half。 */
	duplex?: "half";
}

/** 创建发版 REST API。 */
export function createReleasesApi(
	client: Pick<VcpDeckClient, "request" | "requestRaw">,
) {
	return {
		list: (
			options?: { page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<ReleaseInfo>>(
				"GET",
				`/api/releases${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
		upload: async (input: ReleaseUploadInput, signal?: AbortSignal) => {
			const params = new URLSearchParams({
				version: input.version,
				platform: input.platform,
				sha256: input.sha256,
			});
			const result = await client.requestRaw<{ release: ReleaseInfo }>(
				"POST",
				`/api/releases/upload?${params.toString()}`,
				{
					body: input.archive,
					headers: {
						"Content-Type": input.contentType ?? "application/zip",
					},
					signal,
					duplex: input.duplex,
				},
			);
			return result.data;
		},
		status: (signal?: AbortSignal) =>
			client.request<ServerStatus>("GET", "/api/status", undefined, signal),
	};
}
