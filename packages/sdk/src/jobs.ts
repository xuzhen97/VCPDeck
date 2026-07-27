import {
	JobStatus,
	type JobCreate,
	type JobCreateResult,
	type JobInfo,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/** Job 等待选项。 */
export interface WaitJobOptions {
	signal?: AbortSignal;
	delays?: readonly number[];
}

const TERMINAL_STATUSES = new Set<JobStatus>([
	JobStatus.DONE,
	JobStatus.ERROR,
	JobStatus.CANCELLED,
]);

/** 创建 Job REST API。 */
export function createJobsApi(client: Pick<VcpDeckClient, "request">) {
	return {
		list: (signal?: AbortSignal) =>
			client.request<JobInfo[]>("GET", "/api/jobs", undefined, signal),
		get: (jobId: string, signal?: AbortSignal) =>
			client.request<JobInfo>(
				"GET",
				`/api/jobs/${encodeURIComponent(jobId)}`,
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
			const delays = options.delays?.length
				? options.delays
				: [1000, 2000, 5000];
			for (let attempt = 0; ; attempt++) {
				const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
				await sleep(delay, options.signal);
				const job = await client.request<JobInfo>(
					"GET",
					`/api/jobs/${encodeURIComponent(jobId)}`,
					undefined,
					options.signal,
				);
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
