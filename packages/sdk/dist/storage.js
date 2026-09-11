/** 创建 Storage API；有意不暴露原始配置读取。 */
export function createStorageApi(client) {
    return {
        getBackendConfig: (signal) => client.request("GET", "/api/storage/config", undefined, signal),
        createUploadToken: (input, signal) => client.request("POST", "/api/storage/upload-token", input, signal),
        /** 构造受鉴权的稳定下载地址；不提前签发临时 URL。 */
        downloadUrl: (key) => `/api/storage/download-redirect/${encodeURIComponent(key)}`,
        createDownloadToken: (input, signal) => client.request("POST", "/api/storage/download-token", input, signal),
        delete: (key, signal) => client.request("DELETE", `/api/storage/raw/${encodeURIComponent(key)}`, undefined, signal),
        setBackend: (input, signal) => client.request("PUT", "/api/storage/config", input, signal),
    };
}
