import type {
	ClientAnnotationsInput,
	ClientInfo,
	DshWebState,
} from "@vcpdeck/shared";

/** 远程 DSH 通道状态（ADR-0059 修订）。 */
export interface DshWebStatus {
	clientId: string;
	state: DshWebState;
	port: number | null;
	url: string | null;
}
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
		/** 登记/清除远程 DSH WebUI 地址（ADR-0059）；`null` 清除。 */
		setDshWebUrl: (clientId: string, url: string | null, signal?: AbortSignal) =>
			client.request<ClientInfo>(
				"PUT",
				`/api/clients/${encodeURIComponent(clientId)}/dsh-web`,
				{ url },
				signal,
			),
		/** 一键启动：代起 dsh web 并自动建 FRP 映射（ADR-0059 修订）。 */
		startDshWeb: (clientId: string, signal?: AbortSignal) =>
			client.request<DshWebStatus>(
				"POST",
				`/api/clients/${encodeURIComponent(clientId)}/dsh-web/start`,
				undefined,
				signal,
			),
		/** 一键停止：停进程、删映射、清地址。 */
		stopDshWeb: (clientId: string, signal?: AbortSignal) =>
			client.request<DshWebStatus>(
				"POST",
				`/api/clients/${encodeURIComponent(clientId)}/dsh-web/stop`,
				undefined,
				signal,
			),
	};
}
