import type {
	A2aAgentCard,
	A2aListTasksParams,
	A2aListTasksResult,
	A2aSendMessageParams,
	A2aTask,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
import { VcpDeckApiError } from "./client.js";
import { randomUUID } from "./uuid.js";

export interface TaskAuditEvent {
	id: number;
	taskId: string;
	at: string;
	source: string;
	event: string;
	fidelity: string;
	data?: unknown;
}

/** A2A 任务 SDK；只是 JSON-RPC 薄映射，不隐藏 Task 状态。 */
export function createTasksApi(
	client: Pick<VcpDeckClient, "request">,
	nextId: () => string = randomUUID,
) {
	async function rpc<T>(
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await client.request<
			| { jsonrpc: "2.0"; id: string; result: T }
			| {
					jsonrpc: "2.0";
					id: string | null;
					error: { code: number; message: string; data?: unknown };
			  }
		>(
			"POST",
			"/api/a2a",
			{ jsonrpc: "2.0", id: nextId(), method, params },
			signal,
		);
		if ("error" in response) {
			const data = response.error.data as { code?: unknown } | undefined;
			throw new VcpDeckApiError(
				response.error.message,
				response.error.code,
				typeof data?.code === "string" ? data.code : undefined,
				response.error.data,
			);
		}
		return response.result;
	}

	return {
		sendMessage: (params: A2aSendMessageParams, signal?: AbortSignal) =>
			rpc<A2aTask>("SendMessage", params, signal),
		get: (id: string, historyLength?: number, signal?: AbortSignal) =>
			rpc<A2aTask>("GetTask", { id, historyLength }, signal),
		list: (params: A2aListTasksParams = {}, signal?: AbortSignal) =>
			rpc<A2aListTasksResult>("ListTasks", params, signal),
		cancel: (id: string, signal?: AbortSignal) =>
			rpc<A2aTask>("CancelTask", { id }, signal),
		agentCard: (signal?: AbortSignal) =>
			client.request<A2aAgentCard>(
				"GET",
				"/api/a2a/agent-card",
				undefined,
				signal,
			),
		events: (
			id: string,
			options: { since?: number; limit?: number } = {},
			signal?: AbortSignal,
		) => {
			const search = new URLSearchParams();
			if (options.since !== undefined) search.set("since", String(options.since));
			if (options.limit !== undefined) search.set("limit", String(options.limit));
			const query = search.toString();
			return client.request<{ data: TaskAuditEvent[]; nextSeq: number }>(
				"GET",
				`/api/tasks/${encodeURIComponent(id)}/events${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
		deviation: (id: string, signal?: AbortSignal) =>
			client.request<{ verdict: "aligned" | "drifted" | "failed"; reasons: string[] }>(
				"GET",
				`/api/tasks/${encodeURIComponent(id)}/deviation`,
				undefined,
				signal,
			),
	};
}

export type TasksApi = ReturnType<typeof createTasksApi>;
