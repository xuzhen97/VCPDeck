import type {
	AgentPlacementInfo,
	AgentPlacementInput,
	PaginatedResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** Agent placement SDK：列表供 RDS 选择，创建供操作者登记受控 placement。 */
export function createAgentsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (
			options: { page?: number; pageSize?: number } = {},
			signal?: AbortSignal,
		) => {
			const search = new URLSearchParams();
			if (options.page !== undefined) search.set("page", String(options.page));
			if (options.pageSize !== undefined)
				search.set("pageSize", String(options.pageSize));
			const query = search.toString();
			return client.request<PaginatedResult<AgentPlacementInfo>>(
				"GET",
				`/api/agents${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
		/** 登记一条受控 placement；Server 侧仍会做完整字段校验。 */
		create: (input: AgentPlacementInput, signal?: AbortSignal) =>
			client.request<AgentPlacementInfo>(
				"POST",
				"/api/agents",
				input,
				signal,
			),
	};
}

export type AgentsApi = ReturnType<typeof createAgentsApi>;
