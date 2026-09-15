/** P2P 隧道 REST 域：ICE/coturn 配置 + 临时 Session 生命周期。 */
export function createTunnelsApi(client) {
    return {
        config: {
            /** 读取脱敏后的 ICE/coturn 配置摘要（不含 shared secret）。 */
            get: (signal) => client.request("GET", "/api/tunnels/config", undefined, signal),
            /** 保存非秘密配置字段；secret 不接受 REST 写入。 */
            update: (body, signal) => client.request("PUT", "/api/tunnels/config", body, signal),
        },
        /** 创建临时隧道 Session（短期凭据，禁止缓存）。 */
        create: (body, signal) => client.request("POST", "/api/tunnels", body, signal),
        /** 显式关闭 Session（幂等）。 */
        remove: (sessionId, signal) => client.request("DELETE", `/api/tunnels/${encodeURIComponent(sessionId)}`, undefined, signal),
    };
}
