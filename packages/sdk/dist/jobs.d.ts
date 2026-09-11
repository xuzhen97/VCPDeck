import type { JobCreate, JobCreateResult, JobInfo, PaginatedResult } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";
/** Job 等待选项。 */
export interface WaitJobOptions {
    signal?: AbortSignal;
    delays?: readonly number[];
    onUpdate?: (job: JobInfo) => void;
}
/** 创建 Job REST API。 */
export declare function createJobsApi(client: Pick<VcpDeckClient, "request">): {
    list: (options?: {
        clientId?: string;
        status?: string;
        page?: number;
        pageSize?: number;
    }, signal?: AbortSignal) => Promise<PaginatedResult<JobInfo>>;
    get: (jobId: string, signal?: AbortSignal) => Promise<JobInfo>;
    /** 获取 Job 输出 spool 全文；output 为 null 表示没有落盘输出。 */
    output: (jobId: string, signal?: AbortSignal) => Promise<{
        jobId: string;
        output: string | null;
    }>;
    create: (input: JobCreate, signal?: AbortSignal) => Promise<JobCreateResult>;
    cancel: (jobId: string, signal?: AbortSignal) => Promise<{
        jobId: string;
        status: string;
    }>;
    wait(jobId: string, options?: WaitJobOptions): Promise<JobInfo>;
};
