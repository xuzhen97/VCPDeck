/**
 * 功能目录 SDK（ADR-0056）。
 *
 * 只是 REST 薄映射；`active` 不提供写入入口，只能通过验证上报产生。
 */
import type {
	FeatureCreateInput,
	FeatureInfo,
	FeatureUpdateInput,
	FeatureVerification,
	PaginatedResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 功能条目查询参数。 */
export interface FeatureListParams {
	clientId?: string;
	scope?: string;
	status?: string;
	page?: number;
	pageSize?: number;
}

/** 创建功能目录 API。 */
export function createFeaturesApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (params: FeatureListParams = {}, signal?: AbortSignal) => {
			const search = new URLSearchParams();
			if (params.clientId) search.set("clientId", params.clientId);
			if (params.scope) search.set("scope", params.scope);
			if (params.status) search.set("status", params.status);
			if (params.page !== undefined) search.set("page", String(params.page));
			if (params.pageSize !== undefined)
				search.set("pageSize", String(params.pageSize));
			const query = search.toString();
			return client.request<PaginatedResult<FeatureInfo>>(
				"GET",
				query ? `/api/features?${query}` : "/api/features",
				undefined,
				signal,
			);
		},
		get: (id: string, signal?: AbortSignal) =>
			client.request<FeatureInfo>(
				"GET",
				`/api/features/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
		listByClient: (clientId: string, signal?: AbortSignal) =>
			client.request<PaginatedResult<FeatureInfo>>(
				"GET",
				`/api/clients/${encodeURIComponent(clientId)}/features`,
				undefined,
				signal,
			),
		create: (input: FeatureCreateInput, signal?: AbortSignal) =>
			client.request<FeatureInfo>("POST", "/api/features", input, signal),
		update: (id: string, patch: FeatureUpdateInput, signal?: AbortSignal) =>
			client.request<FeatureInfo>(
				"PATCH",
				`/api/features/${encodeURIComponent(id)}`,
				patch,
				signal,
			),
		reportVerification: (
			id: string,
			report: FeatureVerification,
			signal?: AbortSignal,
		) =>
			client.request<FeatureInfo>(
				"POST",
				`/api/features/${encodeURIComponent(id)}/verifications`,
				report,
				signal,
			),
	};
}
