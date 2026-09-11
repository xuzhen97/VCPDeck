import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobStatus } from "@vcpdeck/shared";
import type { JobCreateResult, DispatchPayload, StatusReport, JobInfo, ActorContext, PaginatedResult, FileUploadSession, FileUploadSessionCreate } from "@vcpdeck/shared";
import { FileService } from "../file/file.service.js";
import { StorageService } from "../storage/storage.service.js";
/** 解析 Job 输出 spool 根目录；绝对路径原样，相对路径锚定 appDir 或 cwd。 */
export declare function resolveJobOutputDir(appDir?: string | undefined): string;
export declare class JobService {
    private readonly prisma;
    private readonly scheduler;
    private readonly fileService;
    private readonly storage;
    private readonly outputDir;
    constructor(prisma: PrismaService, scheduler: JobScheduler, fileService: FileService, storage: StorageService, outputDir?: string);
    /** 创建等待浏览器上传的文件导入会话。 */
    createUploadSession(input: FileUploadSessionCreate, actor: ActorContext): Promise<FileUploadSession>;
    /** 确认 Storage 上传并激活文件导入 Job。 */
    completeUploadSession(jobId: string, body?: {
        uploadedBytes?: number;
    }): Promise<{
        result: JobCreateResult;
        dispatch: DispatchPayload | null;
    }>;
    create(params: {
        clientId: string;
        type: string;
        payload: Record<string, unknown>;
        timeout?: number;
    }, actor: ActorContext): Promise<{
        result: JobCreateResult;
        dispatch: DispatchPayload | null;
    }>;
    /** stdout/stderr 片段落盘（tee）；Job 不存在时静默忽略，不阻塞实时转发。 */
    appendOutputRaw(jobId: string, text: string): Promise<void>;
    /**
     * 读取 Job 输出 spool 全文；仅详情查询时调用。
     * 返回 null 表示 Job 不存在或没有输出文件。
     */
    readJobOutput(jobId: string): Promise<string | null>;
    /** 更新 job 传输段进度（file.export 上传时由 client 上报） */
    updateProgress(jobId: string, loaded: number, total: number): Promise<void>;
    markDone(jobId: string, type: string, result: Record<string, unknown>): Promise<DispatchPayload | null>;
    markCancelled(jobId: string): Promise<DispatchPayload | null>;
    markDisconnected(clientId: string): Promise<void>;
    reconcileOnReconnect(clientId: string, report: StatusReport): Promise<DispatchPayload[]>;
    cancel(jobId: string, _actor: ActorContext): Promise<{
        cancelled: boolean;
        needsDispatch: boolean;
        clientId?: string;
    }>;
    list(options?: {
        clientId?: string;
        status?: JobStatus | "active";
        page?: number;
        pageSize?: number;
    }): Promise<PaginatedResult<JobInfo>>;
    findById(jobId: string): Promise<JobInfo | null>;
}
