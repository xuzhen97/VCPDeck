/** 创建在线 Client API。 */
export function createClientsApi(client) {
    return {
        list: (signal) => client.request("GET", "/api/clients", undefined, signal),
        /** 修改客户端别名（全局唯一；重名返回 409）。 */
        rename: (clientId, name, signal) => client.request("PATCH", `/api/clients/${encodeURIComponent(clientId)}/name`, { name }, signal),
    };
}
