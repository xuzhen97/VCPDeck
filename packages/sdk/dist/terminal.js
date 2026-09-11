/** 终端 REST API（机器范围内）。 */
export function createTerminalsApi(client) {
    const base = (clientId) => `/api/clients/${encodeURIComponent(clientId)}/terminals`;
    const session = (clientId, sessionId) => `${base(clientId)}/${encodeURIComponent(sessionId)}`;
    return {
        /** 列出 Client 实际可用 Shell。 */
        shells: (clientId, signal) => client.request(`GET`, `${base(clientId)}/shells`, undefined, signal),
        /** 会话列表（分页）。 */
        list: (clientId, options, signal) => {
            const params = new URLSearchParams();
            if (options?.page)
                params.set("page", String(options.page));
            if (options?.pageSize)
                params.set("pageSize", String(options.pageSize));
            const qs = params.toString();
            return client.request("GET", `${base(clientId)}${qs ? `?${qs}` : ""}`, undefined, signal);
        },
        /** 创建终端会话（只允许 shellId/cols/rows）。 */
        create: (clientId, body, signal) => client.request("POST", base(clientId), body, signal),
        /** 会话详情。 */
        get: (clientId, sessionId, signal) => client.request("GET", session(clientId, sessionId), undefined, signal),
        /** 关闭会话（幂等）。 */
        remove: (clientId, sessionId, signal) => client.request("DELETE", session(clientId, sessionId), undefined, signal),
        /** 会话审计分页。 */
        audit: (clientId, sessionId, options, signal) => {
            const params = new URLSearchParams();
            if (options?.page)
                params.set("page", String(options.page));
            if (options?.pageSize)
                params.set("pageSize", String(options.pageSize));
            const qs = params.toString();
            return client.request("GET", `${session(clientId, sessionId)}/audit${qs ? `?${qs}` : ""}`, undefined, signal);
        },
    };
}
