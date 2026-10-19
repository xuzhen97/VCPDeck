import type {
	RemoteDevForwardToken,
	RemoteDevPortCreateRequest,
	RemoteDevPortInfo,
	RemoteDevSessionCreateRequest,
	RemoteDevSessionInfo,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

export function createRemoteDevApi(client: Pick<VcpDeckClient, "request">) {
	return {
		create: (input: RemoteDevSessionCreateRequest, signal?: AbortSignal) =>
			client.request<RemoteDevSessionInfo>(
				"POST",
				"/api/remote-dev/sessions",
				input,
				signal,
			),
		list: (
			options: { clientId?: string; state?: string; page?: number; pageSize?: number } = {},
			signal?: AbortSignal,
		) => {
			const search = new URLSearchParams();
			if (options.clientId) search.set("clientId", options.clientId);
			if (options.state) search.set("state", options.state);
			if (options.page !== undefined) search.set("page", String(options.page));
			if (options.pageSize !== undefined)
				search.set("pageSize", String(options.pageSize));
			const query = search.toString();
			return client.request<{
				data: RemoteDevSessionInfo[];
				total: number;
				page: number;
				pageSize: number;
				totalPages: number;
			}>(
				"GET",
				`/api/remote-dev/sessions${query ? `?${query}` : ""}`,
				undefined,
				signal,
			);
		},
		get: (id: string, signal?: AbortSignal) =>
			client.request<RemoteDevSessionInfo>(
				"GET",
				`/api/remote-dev/sessions/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
		close: (id: string, signal?: AbortSignal) =>
			client.request<RemoteDevSessionInfo>(
				"DELETE",
				`/api/remote-dev/sessions/${encodeURIComponent(id)}`,
				undefined,
				signal,
			),
		issueForwardToken: (sessionId: string, portId: string, signal?: AbortSignal) =>
			client.request<RemoteDevForwardToken>(
				"POST",
				`/api/remote-dev/sessions/${encodeURIComponent(sessionId)}/ports/${encodeURIComponent(portId)}/forward-token`,
				undefined,
				signal,
			),
		ports: {
			list: (sessionId: string, signal?: AbortSignal) =>
				client.request<RemoteDevPortInfo[]>(
					"GET",
					`/api/remote-dev/sessions/${encodeURIComponent(sessionId)}/ports`,
					undefined,
					signal,
				),
			open: (
				sessionId: string,
				input: RemoteDevPortCreateRequest,
				signal?: AbortSignal,
			) =>
				client.request<RemoteDevPortInfo>(
					"POST",
					`/api/remote-dev/sessions/${encodeURIComponent(sessionId)}/ports`,
					input,
					signal,
				),
			close: (sessionId: string, portId: string, signal?: AbortSignal) =>
				client.request<RemoteDevPortInfo>(
					"DELETE",
					`/api/remote-dev/sessions/${encodeURIComponent(sessionId)}/ports/${encodeURIComponent(portId)}`,
					undefined,
					signal,
				),
			issueForwardToken: (
				sessionId: string,
				portId: string,
				signal?: AbortSignal,
			) =>
				client.request<RemoteDevForwardToken>(
					"POST",
					`/api/remote-dev/sessions/${encodeURIComponent(sessionId)}/ports/${encodeURIComponent(portId)}/forward-token`,
					undefined,
					signal,
				),
		},
	};
}

export type RemoteDevApi = ReturnType<typeof createRemoteDevApi>;
