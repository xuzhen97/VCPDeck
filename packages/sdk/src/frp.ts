import type {
	FrpMappingCreateRequest,
	FrpMappingInfo,
	FrpsInstanceCreateRequest,
	FrpsInstanceUpdateRequest,
	FrpsInstanceInfo,
	PaginatedResult,
	ProbeResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建 FRP REST API。 */
export function createFrpApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (
			options?: { clientId?: string; page?: number; pageSize?: number },
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.clientId) params.set("clientId", options.clientId);
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<FrpMappingInfo>>(
				"GET",
				`/api/frp/mappings${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
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
		instances: {
			list: (
				options?: { page?: number; pageSize?: number },
				signal?: AbortSignal,
			) => {
				const params = new URLSearchParams();
				if (options?.page)
					params.set("page", String(options.page));
				if (options?.pageSize)
					params.set("pageSize", String(options.pageSize));
				const qs = params.toString();
				return client.request<PaginatedResult<FrpsInstanceInfo>>(
					"GET",
					`/api/frp/instances${qs ? `?${qs}` : ""}`,
					undefined,
					signal,
				);
			},
			get: (id: string, signal?: AbortSignal) =>
				client.request<FrpsInstanceInfo>(
					"GET",
					`/api/frp/instances/${encodeURIComponent(id)}`,
					undefined,
					signal,
				),
			create: (
				input: FrpsInstanceCreateRequest,
				signal?: AbortSignal,
			) =>
				client.request<FrpsInstanceInfo>(
					"POST",
					"/api/frp/instances",
					input,
					signal,
				),
			update: (
				id: string,
				input: FrpsInstanceUpdateRequest,
				signal?: AbortSignal,
			) =>
				client.request<FrpsInstanceInfo>(
					"PUT",
					`/api/frp/instances/${encodeURIComponent(id)}`,
					input,
					signal,
				),
			delete: (id: string, signal?: AbortSignal) =>
				client.request<{ id: string; deleted: true }>(
					"DELETE",
					`/api/frp/instances/${encodeURIComponent(id)}`,
					undefined,
					signal,
				),
			probe: (id: string, signal?: AbortSignal) =>
				client.request<ProbeResult>(
					"POST",
					`/api/frp/instances/${encodeURIComponent(id)}/probe`,
					undefined,
					signal,
				),
			setDefault: (id: string, signal?: AbortSignal) =>
				client.request<FrpsInstanceInfo>(
					"POST",
					`/api/frp/instances/${encodeURIComponent(id)}/set-default`,
					undefined,
					signal,
				),
		},
	};
}
