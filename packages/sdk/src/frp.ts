import {
	JobStatus,
	type FrpMappingCreateRequest,
	type FrpMappingInfo,
	FrpsInstanceCreateRequest,
	FrpsInstanceUpdateRequest,
	FrpsInstanceInfo,
	PaginatedResult,
	ProbeResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
import type { WaitJobOptions, createJobsApi } from "./jobs.js";

export interface WaitFrpOptions extends WaitJobOptions {
	timeoutSeconds?: number;
}

/** FRP 完整操作失败。 */
export class FrpOperationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FrpOperationError";
	}
}

/** 创建 FRP REST API。 */
export function createFrpApi(
	client: Pick<VcpDeckClient, "request">,
	jobs?: ReturnType<typeof createJobsApi>,
) {
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
		async createAndWait(
			input: FrpMappingCreateRequest,
			options: WaitFrpOptions = {},
		): Promise<FrpMappingInfo> {
			if (!jobs) throw new Error("FRP wait requires Jobs API");
			const mapping = await client.request<FrpMappingInfo>(
				"POST",
				"/api/frp/mappings",
				input,
				options.signal,
			);
			if (!mapping.operationJobId) throw new Error("Server 未返回 FRP operationJobId");
			const job = await jobs.wait(mapping.operationJobId, options);
			if (job.status !== JobStatus.DONE) {
				throw new FrpOperationError(
					job.errorCode ?? "FRP_OPERATION_FAILED",
					job.errorMessage ?? "FRP 映射创建失败",
				);
			}
			return client.request<FrpMappingInfo>(
				"GET",
				`/api/frp/mappings/${encodeURIComponent(mapping.id)}`,
				undefined,
				options.signal,
			);
		},
		delete: (
			id: string,
			optionsOrSignal: WaitFrpOptions | AbortSignal = {},
		) => {
			const options =
				optionsOrSignal instanceof AbortSignal
					? { signal: optionsOrSignal }
					: optionsOrSignal;
			const params = new URLSearchParams();
			if (options.timeoutSeconds) {
				params.set("timeoutSeconds", String(options.timeoutSeconds));
			}
			const query = params.toString();
			return client.request<FrpMappingInfo>(
				"DELETE",
				`/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`,
				undefined,
				options.signal,
			);
		},
		async deleteAndWait(
			id: string,
			options: WaitFrpOptions = {},
		): Promise<{ id: string; deleted: true }> {
			if (!jobs) throw new Error("FRP wait requires Jobs API");
			const params = new URLSearchParams();
			if (options.timeoutSeconds) {
				params.set("timeoutSeconds", String(options.timeoutSeconds));
			}
			const query = params.toString();
			const mapping = await client.request<FrpMappingInfo>(
				"DELETE",
				`/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`,
				undefined,
				options.signal,
			);
			if (!mapping.operationJobId) throw new Error("Server 未返回 FRP operationJobId");
			const job = await jobs.wait(mapping.operationJobId, options);
			if (job.status !== JobStatus.DONE) {
				throw new FrpOperationError(
					job.errorCode ?? "FRP_OPERATION_FAILED",
					job.errorMessage ?? "FRP 映射删除失败",
				);
			}
			return { id, deleted: true };
		},
		instances: {
			list: (
				options?: { page?: number; pageSize?: number },
				signal?: AbortSignal,
			) => {
				const params = new URLSearchParams();
				if (options?.page) params.set("page", String(options.page));
				if (options?.pageSize) params.set("pageSize", String(options.pageSize));
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
			create: (input: FrpsInstanceCreateRequest, signal?: AbortSignal) =>
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
