import type { ClientInstallerBootstrap, ClientInstallerClientStatus, ClientInstallerConfigInfo, ClientInstallerPlatform, ClientInstallerPreflight } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** 创建 Client 一键安装 REST API。 */
export declare function createClientInstallerApi(client: Pick<VcpDeckClient, "request" | "requestRaw">): {
    getConfig: (signal?: AbortSignal) => Promise<ClientInstallerConfigInfo>;
    updateConfig: (enabled: boolean, signal?: AbortSignal) => Promise<ClientInstallerConfigInfo>;
    preflight: (platform: ClientInstallerPlatform, signal?: AbortSignal) => Promise<ClientInstallerPreflight>;
    bootstrap: (platform: ClientInstallerPlatform, signal?: AbortSignal) => Promise<ClientInstallerBootstrap>;
    getClientStatus: (clientId: string, psk: string, signal?: AbortSignal) => Promise<ClientInstallerClientStatus>;
};
