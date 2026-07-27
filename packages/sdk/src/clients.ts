import type { ClientInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建在线 Client API。 */
export function createClientsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (signal?: AbortSignal) =>
			client.request<ClientInfo[]>("GET", "/api/clients", undefined, signal),
	};
}
