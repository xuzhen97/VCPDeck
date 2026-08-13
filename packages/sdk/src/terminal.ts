import type {
	PaginatedResult,
	TerminalAuditInfo,
	TerminalSessionCreateRequest,
	TerminalSessionInfo,
	TerminalShellInfo,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 终端 REST API（机器范围内）。 */
export function createTerminalsApi(client: Pick<VcpDeckClient, "request">) {
	const base = (clientId: string) =>
		`/api/clients/${encodeURIComponent(clientId)}/terminals`;
	const session = (clientId: string, sessionId: string) =>
		`${base(clientId)}/${encodeURIComponent(sessionId)}`;
	return {
		/** 列出 Client 实际可用 Shell。 */
		shells: (clientId: string, signal?: AbortSignal) =>
			client.request<TerminalShellInfo[]>(`GET`, `${base(clientId)}/shells`, undefined, signal),
		/** 会话列表（分页）。 */
		list: (
			clientId: string,
			options?: { page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<TerminalSessionInfo>>(
				"GET",
				`${base(clientId)}${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
		/** 创建终端会话（只允许 shellId/cols/rows）。 */
		create: (clientId: string, body: TerminalSessionCreateRequest, signal?: AbortSignal) =>
			client.request<TerminalSessionInfo>("POST", base(clientId), body, signal),
		/** 会话详情。 */
		get: (clientId: string, sessionId: string, signal?: AbortSignal) =>
			client.request<TerminalSessionInfo>("GET", session(clientId, sessionId), undefined, signal),
		/** 关闭会话（幂等）。 */
		remove: (clientId: string, sessionId: string, signal?: AbortSignal) =>
			client.request<TerminalSessionInfo>("DELETE", session(clientId, sessionId), undefined, signal),
		/** 会话审计分页。 */
		audit: (
			clientId: string,
			sessionId: string,
			options?: { page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<TerminalAuditInfo>>(
				"GET",
				`${session(clientId, sessionId)}/audit${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
	};
}
