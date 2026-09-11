/** 创建 Client 一键安装 REST API。 */
export function createClientInstallerApi(client) {
    return {
        getConfig: (signal) => client.request("GET", "/api/client-installer/config", undefined, signal),
        updateConfig: (enabled, signal) => client.request("PUT", "/api/client-installer/config", { enabled }, signal),
        preflight: (platform, signal) => {
            const params = new URLSearchParams({ platform });
            return client.request("GET", `/api/client-installer/preflight?${params.toString()}`, undefined, signal);
        },
        bootstrap: (platform, signal) => client.request("POST", "/api/client-installer/bootstrap", { platform }, signal),
        getClientStatus: async (clientId, psk, signal) => {
            const result = await client.requestRaw("GET", `/api/client-installer/clients/${encodeURIComponent(clientId)}/status`, { headers: { "x-vcpdeck-psk": psk }, signal });
            return result.data;
        },
    };
}
