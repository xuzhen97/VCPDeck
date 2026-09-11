/** 创建发版 REST API。 */
export function createReleasesApi(client) {
    return {
        list: (options, signal) => {
            const params = new URLSearchParams();
            if (options?.page)
                params.set("page", String(options.page));
            if (options?.pageSize)
                params.set("pageSize", String(options.pageSize));
            const qs = params.toString();
            return client.request("GET", `/api/releases${qs ? `?${qs}` : ""}`, undefined, signal);
        },
        createUploadSession: (input, signal) => client.request("POST", "/api/releases/uploads", input, signal),
        refreshUploadParts: (sessionId, partNumbers, signal) => client.request("POST", `/api/releases/uploads/${encodeURIComponent(sessionId)}/parts`, { partNumbers }, signal),
        completeUploadSession: (sessionId, uploadedBytes, signal) => client.request("POST", `/api/releases/uploads/${encodeURIComponent(sessionId)}/complete`, { uploadedBytes }, signal),
        /** Local 后端及旧 Server 引导使用的 legacy raw 上传。 */
        upload: async (input, signal) => {
            const params = new URLSearchParams({
                version: input.version,
                platform: input.platform,
                sha256: input.sha256,
            });
            const result = await client.requestRaw("POST", `/api/releases/upload?${params.toString()}`, {
                body: input.archive,
                headers: {
                    "Content-Type": input.contentType ?? "application/zip",
                },
                signal,
                duplex: input.duplex,
            });
            return result.data;
        },
        cleanupPreview: (signal) => client.request("GET", "/api/releases/cleanup/preview", undefined, signal),
        cleanupRun: (signal) => client.request("POST", "/api/releases/cleanup/run", undefined, signal),
        status: (signal) => client.request("GET", "/api/status", undefined, signal),
    };
}
