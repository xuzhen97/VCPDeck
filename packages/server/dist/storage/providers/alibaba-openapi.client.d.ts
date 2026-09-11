/**
 * 阿里云盘 OpenAPI 客户端
 *
 * 封装阿里云盘 OpenAPI 的 HTTP 调用，包括：
 * - 用户信息 / drive 查询
 * - 文件列表 / 创建目录
 * - 文件上传（create → getUploadUrl → complete）
 * - 文件下载 / 删除
 *
 * 参考：https://www.yuque.com/aliyundrive/zpfszx
 */
export declare class AlibabaOpenApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export interface AlibabaOpenApiClientOptions {
    openapiBase: string;
    accessToken: string;
    fetchImpl?: typeof fetch;
}
export declare class AlibabaOpenApiClient {
    private readonly base;
    private readonly token;
    private readonly fetchImpl;
    constructor(options: AlibabaOpenApiClientOptions);
    post<T = unknown>(path: string, payload: unknown): Promise<T>;
    /** 获取默认 drive 信息 */
    getDriveInfo(): Promise<{
        driveId: string;
        raw: unknown;
    }>;
    /** 列目录 */
    listChildren(input: {
        driveId: string;
        parentFileId: string;
        type?: "file" | "folder";
    }): Promise<Record<string, unknown>[]>;
    /** 创建目录 */
    createFolder(input: {
        driveId: string;
        parentFileId: string;
        name: string;
    }): Promise<Record<string, unknown>>;
    /**
     * 确保目录路径存在，返回最终目录的 file_id
     * ponytail: 每次调用都逐级查询/创建，不做缓存
     */
    ensureFolderPath(input: {
        driveId: string;
        folderPath: string;
    }): Promise<string>;
    /** 创建文件上传任务 */
    createFileUpload(input: {
        driveId: string;
        parentFileId: string;
        name: string;
        size: number;
        partInfoList: Array<{
            part_number: number;
        }>;
    }): Promise<Record<string, unknown>>;
    /** 获取分片上传 URL */
    getUploadUrl(input: {
        driveId: string;
        fileId: string;
        uploadId: string;
        partNumbers: number[];
    }): Promise<Record<string, unknown>>;
    /** 完成上传（合并分片） */
    completeUpload(input: {
        driveId: string;
        fileId: string;
        uploadId: string;
    }): Promise<Record<string, unknown>>;
    /** 获取下载 URL */
    getDownloadUrl(input: {
        driveId: string;
        fileId: string;
    }): Promise<Record<string, unknown>>;
    /** 删除文件 */
    deleteFile(input: {
        driveId: string;
        fileId: string;
    }): Promise<Record<string, unknown>>;
}
