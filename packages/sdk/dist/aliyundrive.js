/** 创建阿里云盘 OAuth API。 */
export function createAliyunDriveApi(client) {
    return {
        verify: (signal) => client.request("POST", "/api/aliyundrive/verify", undefined, signal),
        status: (signal) => client.request("GET", "/api/aliyundrive/status", undefined, signal),
        configure: (input, signal) => client.request("PUT", "/api/aliyundrive/config", input, signal),
        startOAuth: (signal) => client.request("POST", "/api/aliyundrive/oauth/start", undefined, signal),
        completeOAuth: (input, signal) => client.request("POST", "/api/aliyundrive/oauth/complete", input, signal),
        revoke: (signal) => client.request("POST", "/api/aliyundrive/oauth/revoke", undefined, signal),
    };
}
