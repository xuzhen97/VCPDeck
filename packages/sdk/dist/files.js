/** 创建远程文件 Job API。 */
export function createFilesApi(client, jobs) {
    async function run(input, signal) {
        const created = await jobs.create(input, signal);
        const job = await jobs.wait(created.jobId, { signal });
        if (job.status !== "done")
            throw job;
        return job.result;
    }
    return {
        createUploadSession: (input, signal) => client.request("POST", "/api/files/upload-sessions", input, signal),
        completeUpload: (jobId, body, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/complete`, body, signal),
        /** 导出直传会话协商（Client stat 文件后调用） */
        createExportSession: (jobId, size, signal) => client.request("POST", "/api/files/export-sessions", { jobId, size }, signal),
        /** 完成导出直传，返回真实 storage key */
        completeExportUpload: (jobId, uploadedBytes, signal) => client.request("POST", `/api/files/export-sessions/${encodeURIComponent(jobId)}/complete`, { uploadedBytes }, signal),
        /** 续期直传会话指定分片的上传 URL */
        refreshUploadPartUrls: (jobId, partNumbers, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/part-urls`, { partNumbers }, signal),
        /** 直传分片进度上报（节流由调用方控制） */
        updateUploadProgress: (jobId, loaded, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/progress`, { loaded }, signal),
        roots: async (clientId, signal) => (await run({ clientId, type: "file.roots", payload: {} }, signal)).roots,
        list: (clientId, rootDir, path, signal) => run({ clientId, type: "file.list", payload: { rootDir, path } }, signal),
        stat: (clientId, rootDir, path, signal) => run({ clientId, type: "file.stat", payload: { rootDir, path } }, signal),
        readText: (clientId, rootDir, path, maxBytes = 262144, signal) => run({
            clientId,
            type: "file.readText",
            payload: { rootDir, path, maxBytes },
        }, signal),
        writeText: (clientId, payload, signal) => run({ clientId, type: "file.writeText", payload }, signal),
        mkdir: (clientId, payload, signal) => run({ clientId, type: "file.mkdir", payload }, signal),
        delete: (clientId, payload, signal) => run({ clientId, type: "file.delete", payload }, signal),
        move: (clientId, payload, signal) => run({ clientId, type: "file.move", payload }, signal),
        export: (clientId, payload, signal) => run({ clientId, type: "file.export", payload }, signal),
        import: (clientId, payload, signal) => run({ clientId, type: "file.import", payload }, signal),
    };
}
