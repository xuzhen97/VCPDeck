import { resolveClientId } from "../utils.js";
export async function handleListJobs(client, params) {
    const clientFilter = params.clientId || params.clientName || params.client;
    const clientId = clientFilter
        ? await resolveClientId(client, String(clientFilter))
        : undefined;
    const status = params.status ? String(params.status) : undefined;
    const page = params.page ? Number(params.page) : undefined;
    const pageSize = params.pageSize ? Number(params.pageSize) : undefined;
    const jobs = await client.jobs.list({
        clientId,
        status,
        page,
        pageSize,
    });
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(jobs, null, 2),
            },
        ],
        messageForAI: `查询到 ${jobs.total} 条 Job 记录 (当前第 ${jobs.page}/${jobs.totalPages} 页)。`,
    };
}
export async function handleGetJobOutput(client, params) {
    const jobId = String(params.jobId || "");
    if (!jobId) {
        throw new Error("Missing required parameter: jobId");
    }
    const res = await client.jobs.output(jobId);
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: res.output ?? "(该 Job 尚无输出落盘或日志为空)",
            },
        ],
        messageForAI: `成功获取 Job ${jobId} 的完整日志输出。`,
    };
}
export async function handleRunShellJob(client, params) {
    const clientFilter = String(params.clientId || params.clientName || params.client || "");
    const shellCommand = String(params.shellCommand || params.command || "");
    const timeout = params.timeout ? Number(params.timeout) : undefined;
    if (!clientFilter || !shellCommand) {
        throw new Error("Missing required parameters: clientId (or client), shellCommand");
    }
    const clientId = await resolveClientId(client, clientFilter);
    const job = await client.jobs.create({
        clientId,
        type: "exec",
        payload: {
            command: shellCommand,
            timeout,
        },
    });
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(job, null, 2),
            },
        ],
        messageForAI: `已成功在机器 ${clientId} 上派发 Shell Job，jobId: ${job.jobId}。可以使用 GetJob 或 GetJobOutput 查询后续执行结果。`,
    };
}
export async function handleGetJob(client, params) {
    const jobId = String(params.jobId || "");
    if (!jobId) {
        throw new Error("Missing required parameter: jobId");
    }
    const job = await client.jobs.get(jobId);
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(job, null, 2),
            },
        ],
        messageForAI: `已获取 Job ${jobId} 的状态详情 (当前状态: ${job.status})。`,
    };
}
export async function handleCancelJob(client, params) {
    const jobId = String(params.jobId || "");
    if (!jobId) {
        throw new Error("Missing required parameter: jobId");
    }
    const job = await client.jobs.cancel(jobId);
    return {
        status: "success",
        content: [
            {
                type: "text",
                text: JSON.stringify(job, null, 2),
            },
        ],
        messageForAI: `已取消 Job ${jobId}。`,
    };
}
