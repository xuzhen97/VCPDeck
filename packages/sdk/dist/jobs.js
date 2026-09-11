const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);
/** 创建 Job REST API。 */
export function createJobsApi(client) {
    return {
        list: (options, signal) => {
            const params = new URLSearchParams();
            if (options?.clientId)
                params.set("clientId", options.clientId);
            if (options?.status)
                params.set("status", options.status);
            if (options?.page)
                params.set("page", String(options.page));
            if (options?.pageSize)
                params.set("pageSize", String(options.pageSize));
            const qs = params.toString();
            return client.request("GET", `/api/jobs${qs ? `?${qs}` : ""}`, undefined, signal);
        },
        get: (jobId, signal) => client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}`, undefined, signal),
        /** 获取 Job 输出 spool 全文；output 为 null 表示没有落盘输出。 */
        output: (jobId, signal) => client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`, undefined, signal),
        create: (input, signal) => client.request("POST", "/api/jobs", input, signal),
        cancel: (jobId, signal) => client.request("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, signal),
        async wait(jobId, options = {}) {
            const delays = options.delays?.length ? options.delays : [1000, 2000, 5000];
            for (let attempt = 0;; attempt++) {
                const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
                await sleep(delay, options.signal);
                const job = await client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}`, undefined, options.signal);
                options.onUpdate?.(job);
                if (TERMINAL_STATUSES.has(job.status))
                    return job;
            }
        },
    };
}
function sleep(ms, signal) {
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
