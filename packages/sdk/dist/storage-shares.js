/** Storage Share 认证管理 API。 */
export function createStorageSharesApi(client) {
    return {
        create: (input, signal) => client.request("POST", "/api/storage/shares", input, signal),
        list: (options = {}, signal) => {
            const params = new URLSearchParams();
            if (options.fileId)
                params.set("fileId", options.fileId);
            if (options.status)
                params.set("status", options.status);
            if (options.page)
                params.set("page", String(options.page));
            if (options.pageSize)
                params.set("pageSize", String(options.pageSize));
            const query = params.toString();
            return client.request("GET", `/api/storage/shares${query ? `?${query}` : ""}`, undefined, signal);
        },
        get: (id, signal) => client.request("GET", `/api/storage/shares/${encodeURIComponent(id)}`, undefined, signal),
        revoke: (id, signal) => client.request("DELETE", `/api/storage/shares/${encodeURIComponent(id)}`, undefined, signal),
    };
}
