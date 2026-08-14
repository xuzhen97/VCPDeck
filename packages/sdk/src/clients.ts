import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建在线 Client API。 */
export function createClientsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (signal?: AbortSignal) =>
			client.request<ClientInfo[]>("GET", "/api/clients", undefined, signal),
		/** 修改客户端别名（全局唯一；重名返回 409）。 */
		rename: (clientId: string, name: string, signal?: AbortSignal) =>
			client.request<ClientInfo>(
				"PATCH",
				`/api/clients/${encodeURIComponent(clientId)}/name`,
				{ name },
				signal,
			),
	};
}
