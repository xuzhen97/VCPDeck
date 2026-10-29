import type { ClientAnnotationsInput, ClientInfo } from "@vcpdeck/shared";
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
		/** 全量替换操作者注解（ADR-0055）；空输入清除。 */
		updateAnnotations: (
			clientId: string,
			annotations: ClientAnnotationsInput,
			signal?: AbortSignal,
		) =>
			client.request<ClientInfo>(
				"PUT",
				`/api/clients/${encodeURIComponent(clientId)}/annotations`,
				{ annotations },
				signal,
			),
	};
}
