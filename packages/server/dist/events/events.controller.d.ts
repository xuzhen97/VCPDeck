import { JobService } from "../job/job.service.js";
import { ClientService } from "../client/client.service.js";
import { ClientGateway } from "./client.gateway.js";
import { StorageService } from "../storage/storage.service.js";
import type { JobCreate, ActorContext, FileUploadSessionCreate } from "@vcpdeck/shared";
export declare class EventsController {
    private readonly jobService;
    private readonly clientService;
    private readonly gateway;
    private readonly storageService;
    private assertClientPsk;
    constructor(jobService: JobService, clientService: ClientService, gateway: ClientGateway, storageService: StorageService);
    health(): {
        ok: boolean;
    };
    /** 创建 Client 专用导出直传会话。 */
    createClientExportSession(psk: string | undefined, body: {
        jobId?: string;
        size?: number;
    }): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 完成 Client 专用导出直传。 */
    completeClientExportSession(jobId: string, psk: string | undefined, body: {
        uploadedBytes?: number;
    }): Promise<{
        key: string;
    }>;
    /** 续期 Client 专用导出会话的指定分片 URL。 */
    refreshClientExportPartUrls(jobId: string, psk: string | undefined, body: {
        partNumbers?: number[];
    }): Promise<{
        partNumber: number;
        url: string;
    }[]>;
    createJob(body: JobCreate, actor: ActorContext): Promise<{
        jobId: string;
        status: string;
        type: string;
    }>;
    /** 创建浏览器直传 Storage 的文件上传会话。 */
    createUploadSession(body: FileUploadSessionCreate, actor: ActorContext): Promise<import("@vcpdeck/shared").FileUploadSession>;
    /** 完成 Storage 上传并激活远程文件导入 Job。 */
    completeUploadSession(jobId: string, body: {
        uploadedBytes?: number;
    }): Promise<import("@vcpdeck/shared").JobCreateResult>;
    /** 创建导出直传会话（Client stat 文件后协商分片 URL）。 */
    createExportSession(body: {
        jobId?: string;
        size?: number;
    }): Promise<{
        fileId: string;
        uploadId: string;
        partSize: number;
        parts: Array<{
            partNumber: number;
            url: string;
        }>;
    }>;
    /** 完成导出直传并返回真实 storage key。 */
    completeExportSession(jobId: string, body: {
        uploadedBytes?: number;
    }): Promise<{
        key: string;
    }>;
    /** 续期上传会话指定分片的直传 URL。 */
    refreshPartUrls(jobId: string, body: {
        partNumbers?: number[];
    }): Promise<{
        partNumber: number;
        url: string;
    }[]>;
    /** 直传分片进度上报（节流由前端控制）。 */
    updateProgress(jobId: string, body: {
        loaded?: number;
    }): Promise<void>;
    cancelJob(jobId: string, actor: ActorContext): Promise<{
        jobId: string;
        status: string;
    }>;
    listClients(): Promise<import("@vcpdeck/shared").ClientInfo[]>;
    /** 修改客户端别名（全局唯一，改名后机器重连不会覆盖） */
    renameClient(clientId: string, name: unknown): Promise<import("@vcpdeck/shared").ClientInfo>;
    listJobs(clientId?: string, status?: string, page?: string, pageSize?: string): Promise<import("@vcpdeck/shared").PaginatedResult<import("@vcpdeck/shared").JobInfo>>;
    getJob(jobId: string): Promise<import("@vcpdeck/shared").JobInfo>;
    /** Job 输出 spool 全文；仅详情诊断时调用，不进入列表路径。 */
    getJobOutput(jobId: string): Promise<{
        jobId: string;
        output: string | null;
    }>;
}
