/** 创建认证与个人凭证 API。 */
export function createAuthApi(client) {
    return {
        login: (input, signal) => client.request("POST", "/api/auth/login", input, signal),
        /** 登录并提取 Cookie；仅供不会自动维护 Cookie 的 Node.js 调用方。 */
        loginSession: async (input, signal) => {
            const { data, response } = await client.requestRaw("POST", "/api/auth/login", {
                body: JSON.stringify(input),
                headers: { "Content-Type": "application/json" },
                signal,
            });
            const setCookie = response.headers.get("set-cookie");
            const session = setCookie?.match(/vcpdeck_session=([^;]+)/)?.[1];
            if (!session) {
                throw new Error("Login response did not include a session cookie");
            }
            return { login: data, cookie: `vcpdeck_session=${session}` };
        },
        logout: (signal) => client.request("POST", "/api/auth/logout", undefined, signal),
        me: (signal) => client.request("GET", "/api/auth/me", undefined, signal),
        updateMe: (input, signal) => client.request("PUT", "/api/auth/me", input, signal),
        tokens: {
            list: (signal) => client.request("GET", "/api/auth/tokens", undefined, signal),
            create: (input, signal) => client.request("POST", "/api/auth/tokens", input, signal),
            revoke: (id, signal) => client.request("DELETE", `/api/auth/tokens/${encodeURIComponent(id)}`, undefined, signal),
        },
    };
}
/** 创建管理员身份 API。 */
export function createIdentitiesApi(client) {
    return {
        list: (signal) => client.request("GET", "/api/identities", undefined, signal),
        create: (input, signal) => client.request("POST", "/api/identities", input, signal),
        disable: (id, signal) => client.request("POST", `/api/identities/${encodeURIComponent(id)}/disable`, undefined, signal),
        enable: (id, signal) => client.request("POST", `/api/identities/${encodeURIComponent(id)}/enable`, undefined, signal),
    };
}
