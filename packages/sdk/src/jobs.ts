import type {
	JobCreate,
	JobCreateResult,
	JobInfo,
	PaginatedResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** Job 等待选项。 */
export interface WaitJobOptions {
	signal?: AbortSignal;
	delays?: readonly number[];
	onUpdate?: (job: JobInfo) => void;
}

const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

/** 创建 Job REST API。 */
export function createJobsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (
			options?: {
				clientId?: string;
				status?: string;
				page?: number;
				pageSize?: number;
			},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options?.clientId) params.set("clientId", options.clientId);
			if (options?.status) params.set("status", options.status);
			if (options?.page) params.set("page", String(options.page));
			if (options?.pageSize) params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return client.request<PaginatedResult<JobInfo>>(
				"GET",
				`/api/jobs${qs ? `?${qs}` : ""}`,
				undefined,
				signal,
			);
		},
		get: (jobId: string, signal?: AbortSignal) =>
			client.request<JobInfo>(
				"GET",
				`/api/jobs/${encodeURIComponent(jobId)}`,
				undefined,
				signal,
			),
		/** 获取 Job 输出 spool 全文；output 为 null 表示没有落盘输出。 */
		output: (jobId: string, signal?: AbortSignal) =>
			client.request<{ jobId: string; output: string | null }>(
				"GET",
				`/api/jobs/${encodeURIComponent(jobId)}/output`,
				undefined,
				signal,
			),
		create: (input: JobCreate, signal?: AbortSignal) =>
			client.request<JobCreateResult>("POST", "/api/jobs", input, signal),
		cancel: (jobId: string, signal?: AbortSignal) =>
			client.request<{ jobId: string; status: string }>(
				"POST",
				`/api/jobs/${encodeURIComponent(jobId)}/cancel`,
				undefined,
				signal,
			),
		async wait(jobId: string, options: WaitJobOptions = {}): Promise<JobInfo> {
			const delays = options.delays?.length ? options.delays : [1000, 2000, 5000];
			for (let attempt = 0; ; attempt++) {
				const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
				await sleep(delay, options.signal);
				const job = await client.request<JobInfo>(
					"GET",
					`/api/jobs/${encodeURIComponent(jobId)}`,
					undefined,
					options.signal,
				);
				options.onUpdate?.(job);
				if (TERMINAL_STATUSES.has(job.status)) return job;
			}
		},
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
