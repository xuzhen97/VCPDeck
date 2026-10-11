import type { PaginatedResult, SessionHostInstanceRecord } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/**
 * 会话宿主 REST API。
 *
 * 只暴露 Server 已保存的控制面元数据；宿主令牌、工作目录与终端正文永不经过这里。
 */
export function createSessionHostApi(client: Pick<VcpDeckClient, "request">) {
	return {
		listInstances: (
			options?: { clientId?: string; page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.clientId) params.set("clientId", options.clientId);
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<SessionHostInstanceRecord>>(
				"GET",
				`/api/session-host/instances${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
	};
}
