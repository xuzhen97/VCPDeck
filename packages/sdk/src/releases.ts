import type { PaginatedResult, ReleaseInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 服务端状态信息（GET /api/status） */
export interface ServerStatus {
	serverVersion: string;
	activeRelease: ReleaseInfo | null;
}

/** 创建发版 REST API。 */
export function createReleasesApi(client: Pick<VcpDeckClient, "request">) {
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
		status: (signal?: AbortSignal) =>
			client.request<ServerStatus>("GET", "/api/status", undefined, signal),
	};
}
