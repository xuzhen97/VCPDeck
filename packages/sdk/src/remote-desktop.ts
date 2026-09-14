import type {
	PaginatedResult,
	RemoteDesktopAuditInfo,
	RemoteDesktopSessionCreateRequest,
	RemoteDesktopSessionInfo,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 浏览器远程桌面 Session REST API；Socket.IO/WebRTC 生命周期由调用方管理。 */
export function createRemoteDesktopApi(client: Pick<VcpDeckClient, "request">) {
	const base = (clientId: string) =>
		`/api/clients/${encodeURIComponent(clientId)}/desktop-sessions`;
	const session = (clientId: string, sessionId: string) =>
		`${base(clientId)}/${encodeURIComponent(sessionId)}`;
	return {
		/** 分页列出 Client 的远程桌面 Session。 */
		list: (
			clientId: string,
			options?: { page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const query = params.toString();
			return client.request<PaginatedResult<RemoteDesktopSessionInfo>>(
				"GET",
				`${base(clientId)}${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
		/** 创建远程桌面 Session。 */
		create: (
			clientId: string,
			body: RemoteDesktopSessionCreateRequest = {},
			signal?: AbortSignal,
		) => client.request<RemoteDesktopSessionInfo>("POST", base(clientId), body, signal),
		/** 获取 Session 详情。 */
		get: (clientId: string, sessionId: string, signal?: AbortSignal) =>
			client.request<RemoteDesktopSessionInfo>("GET", session(clientId, sessionId), undefined, signal),
		/** 关闭 Session（服务端幂等）。 */
		remove: (clientId: string, sessionId: string, signal?: AbortSignal) =>
			client.request<RemoteDesktopSessionInfo>("DELETE", session(clientId, sessionId), undefined, signal),
		/** 获取 Session 生命周期审计。 */
		audit: (
			clientId: string,
			sessionId: string,
			options?: { page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const query = params.toString();
			return client.request<PaginatedResult<RemoteDesktopAuditInfo>>(
				"GET",
				`${session(clientId, sessionId)}/audit${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
	};
}
