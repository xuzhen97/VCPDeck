import type {
	ClientInstallerBootstrap,
	ClientInstallerClientStatus,
	ClientInstallerConfigInfo,
	ClientInstallerPlatform,
	ClientInstallerPreflight,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** 创建 Client 一键安装 REST API。 */
export function createClientInstallerApi(
	client: Pick<VcpDeckClient, "request" | "requestRaw">,
) {
	return {
		getConfig: (signal?: AbortSignal) =>
			client.request<ClientInstallerConfigInfo>(
				"GET",
				"/api/client-installer/config",
				undefined,
				signal,
			),
		updateConfig: (enabled: boolean, signal?: AbortSignal) =>
			client.request<ClientInstallerConfigInfo>(
				"PUT",
				"/api/client-installer/config",
				{ enabled },
				signal,
			),
		preflight: (platform: ClientInstallerPlatform, signal?: AbortSignal) => {
			const params = new URLSearchParams({ platform });
			return client.request<ClientInstallerPreflight>(
				"GET",
				`/api/client-installer/preflight?${params.toString()}`,
				undefined,
				signal,
			);
		},
		bootstrap: (platform: ClientInstallerPlatform, signal?: AbortSignal) =>
			client.request<ClientInstallerBootstrap>(
				"POST",
				"/api/client-installer/bootstrap",
				{ platform },
				signal,
			),
		getClientStatus: async (
			clientId: string,
			psk: string,
			signal?: AbortSignal,
		) => {
			const result = await client.requestRaw<ClientInstallerClientStatus>(
				"GET",
				`/api/client-installer/clients/${encodeURIComponent(clientId)}/status`,
				{ headers: { "x-vcpdeck-psk": psk }, signal },
			);
			return result.data;
		},
	};
}
