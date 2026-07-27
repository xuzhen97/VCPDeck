import type { FrpMappingCreateRequest, FrpMappingInfo } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建 FRP REST API。 */
export function createFrpApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (clientId?: string, signal?: AbortSignal) =>
			client.request<FrpMappingInfo[]>(
				"GET",
				`/api/frp/mappings${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`,
				undefined,
				signal,
			),
		get: (id: string, signal?: AbortSignal) =>
			client.request<FrpMappingInfo>(
				"GET",
				`/api/frp/mappings/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
		create: (input: FrpMappingCreateRequest, signal?: AbortSignal) =>
			client.request<FrpMappingInfo>(
				"POST",
				"/api/frp/mappings",
				input,
				signal,
			),
		delete: (id: string, signal?: AbortSignal) =>
			client.request<{ id: string; deleted: true }>(
				"DELETE",
				`/api/frp/mappings/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
	};
}
