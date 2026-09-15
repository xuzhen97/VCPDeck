import type {
	TunnelConfigInfo,
	TunnelConfigUpdate,
	TunnelSessionCreateRequest,
	TunnelSessionCreated,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** P2P 隧道 REST 域：ICE/coturn 配置 + 临时 Session 生命周期。 */
export function createTunnelsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		config: {
			/** 读取脱敏后的 ICE/coturn 配置摘要（不含 shared secret）。 */
			get: (signal?: AbortSignal) =>
				client.request<TunnelConfigInfo>("GET", "/api/tunnels/config", undefined, signal),
			/** 保存非秘密配置字段；secret 不接受 REST 写入。 */
			update: (body: TunnelConfigUpdate, signal?: AbortSignal) =>
				client.request<TunnelConfigInfo>("PUT", "/api/tunnels/config", body, signal),
		},
		/** 创建临时隧道 Session（短期凭据，禁止缓存）。 */
		create: (body: TunnelSessionCreateRequest, signal?: AbortSignal) =>
			client.request<TunnelSessionCreated>("POST", "/api/tunnels", body, signal),
		/** 显式关闭 Session（幂等）。 */
		remove: (sessionId: string, signal?: AbortSignal) =>
			client.request<{ closed: true }>(
				"DELETE",
				`/api/tunnels/${encodeURIComponent(sessionId)}`,
				undefined,
				signal,
			),
	};
}
