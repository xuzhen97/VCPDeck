import type { FileChangeResult, FileExportSession, FileListResult, FileReadTextResult, FileStatResult, FileTransferResult, FileUploadSession, FileUploadSessionCreate, JobCreateResult } from "@vcpdeck/shared";
import type { createJobsApi } from "./jobs.js";
import type { VcpDeckClient } from "./client.js";
type JobsApi = ReturnType<typeof createJobsApi>;
/** 创建远程文件 Job API。 */
export declare function createFilesApi(client: Pick<VcpDeckClient, "request">, jobs: Pick<JobsApi, "create" | "wait">): {
    createUploadSession: (input: FileUploadSessionCreate, signal?: AbortSignal) => Promise<FileUploadSession>;
    completeUpload: (jobId: string, body: {
        uploadedBytes: number;
    }, signal?: AbortSignal) => Promise<JobCreateResult>;
    /** 导出直传会话协商（Client stat 文件后调用） */
    createExportSession: (jobId: string, size: number, signal?: AbortSignal) => Promise<FileExportSession>;
    /** 完成导出直传，返回真实 storage key */
    completeExportUpload: (jobId: string, uploadedBytes: number, signal?: AbortSignal) => Promise<{
        key: string;
    }>;
    /** 续期直传会话指定分片的上传 URL */
    refreshUploadPartUrls: (jobId: string, partNumbers: number[], signal?: AbortSignal) => Promise<{
        partNumber: number;
        url: string;
    }[]>;
    /** 直传分片进度上报（节流由调用方控制） */
    updateUploadProgress: (jobId: string, loaded: number, signal?: AbortSignal) => Promise<void>;
    roots: (clientId: string, signal?: AbortSignal) => Promise<string[]>;
    list: (clientId: string, rootDir: string, path: string, signal?: AbortSignal) => Promise<FileListResult>;
    stat: (clientId: string, rootDir: string, path: string, signal?: AbortSignal) => Promise<FileStatResult>;
    readText: (clientId: string, rootDir: string, path: string, maxBytes?: number, signal?: AbortSignal) => Promise<FileReadTextResult>;
    writeText: (clientId: string, payload: {
        rootDir: string;
        path: string;
        content: string;
    }, signal?: AbortSignal) => Promise<FileChangeResult>;
    mkdir: (clientId: string, payload: {
        rootDir: string;
        path: string;
    }, signal?: AbortSignal) => Promise<FileChangeResult>;
    delete: (clientId: string, payload: {
        rootDir: string;
        path: string;
        recursive?: boolean;
    }, signal?: AbortSignal) => Promise<FileChangeResult>;
    move: (clientId: string, payload: {
        rootDir: string;
        source: string;
        destination: string;
        overwrite?: boolean;
    }, signal?: AbortSignal) => Promise<FileChangeResult>;
    export: (clientId: string, payload: {
        rootDir: string;
        path: string;
    }, signal?: AbortSignal) => Promise<FileTransferResult>;
    import: (clientId: string, payload: {
        rootDir: string;
        targetPath: string;
        fileId: string;
        overwrite?: boolean;
    }, signal?: AbortSignal) => Promise<{
        path: string;
        size: number;
        sha256: string;
    }>;
};
export {};
