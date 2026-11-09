import type { JobInfo, StorageShareStatus } from "@vcpdeck/shared";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpContentItem, VcpResponse } from "../types.js";
import { resolveClientId, resolveRootDir } from "../utils.js";

/**
 * VCPToolBox 的 communication.timeout 为 300000ms；预留建分享与进程开销，
 * 导出软等待控制在 240 秒，超时后返回可续作的 jobId，而不是让整次调用被杀掉。
 */
const EXPORT_WAIT_MS = 240_000;

const SHARE_STATUSES: StorageShareStatus[] = ["active", "revoked", "invalid"];

function textParam(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
	const text = textParam(value).trim();
	return text || undefined;
}

function numberParam(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 校验并规范化公开分享基地址。
 * 必须在创建任何导出 Job 或分享之前调用，避免非法地址留下无法使用的分享记录。
 */
function normalizeBaseUrl(candidate: string): string {
	const trimmed = candidate.trim();
	if (!trimmed) {
		throw new Error(
			"PUBLIC_SHARE_BASE_URL is required (or pass baseUrl for this call)",
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("baseUrl (or PUBLIC_SHARE_BASE_URL) must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("baseUrl (or PUBLIC_SHARE_BASE_URL) must be a valid HTTP(S) URL");
	}
	return trimmed.replace(/\/+$/, "");
}

/** 用公开基地址拼接分享路径；基地址已在前置校验中规范化。 */
function publicUrl(base: string, sharePath: string): string {
	return new URL(sharePath, `${base}/`).toString();
}

/** 导出 Job 尚未结束时返回可续作的错误，避免调用方重复导出。 */
function exportPendingError(jobId: string, waitedMs?: number): Error {
	const waited =
		waitedMs === undefined
			? "尚未完成"
			: `在 ${Math.round(waitedMs / 1000)} 秒内未完成`;
	return new Error(
		`导出 Job ${jobId} ${waited}，远端导出仍在继续。请勿重复导出；稍后调用 ShareFile 并传入 jobId="${jobId}" 补建分享链接。`,
	);
}

/**
 * 从 file.export Job 提取 fileId；运行中返回可续作错误，失败则抛出 Job 错误。
 */
function fileIdFromExportJob(job: JobInfo): string {
	if (job.type !== "file.export") {
		throw new Error(
			`Job ${job.jobId} 的类型是 ${job.type}，不是 file.export，无法用于创建分享链接。`,
		);
	}
	if (job.status !== "done") {
		if (job.status === "error" || job.status === "cancelled") {
			const detail = job.errorMessage || job.errorCode || "未知原因";
			throw new Error(
				`导出 Job ${job.jobId} 未成功（状态: ${job.status}）：${detail}`,
			);
		}
		throw exportPendingError(job.jobId);
	}
	const fileId = job.result?.fileId;
	if (typeof fileId !== "string" || fileId.length === 0) {
		throw new Error(`导出 Job ${job.jobId} 未返回 fileId，无法创建分享链接。`);
	}
	return fileId;
}

/** 等待导出 Job 终态；到达软等待上限时中止轮询并返回可续作错误。 */
async function waitForExport(
	client: VcpDeckClient,
	jobId: string,
	waitMs: number,
): Promise<JobInfo> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), waitMs);
	try {
		return await client.jobs.wait(jobId, { signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) throw exportPendingError(jobId, waitMs);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 创建公开分享：支持直接复用 fileId、续作已有 file.export Job，或现场导出 Client 文件。
 * 链接等于对外暴露文件内容，调用方须先取得用户确认。
 */
export async function handleShareFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
	defaultBaseUrl: string,
): Promise<VcpResponse> {
	// 先校验基地址，避免非法地址在导出/建分享之后才失败而留下孤儿记录
	const baseUrl = normalizeBaseUrl(optionalText(params.baseUrl) ?? defaultBaseUrl);
	const explicitFileId = optionalText(params.fileId);
	const explicitJobId = optionalText(params.jobId);
	const clientFilter =
		optionalText(params.clientId) ??
		optionalText(params.clientName) ??
		optionalText(params.client);
	const filePath = textParam(params.path);

	if (explicitFileId && explicitJobId) {
		throw new Error("fileId and jobId cannot be used together");
	}
	if (explicitFileId && (clientFilter || filePath)) {
		throw new Error("fileId cannot be combined with clientId/client or path");
	}
	if (explicitJobId && (clientFilter || filePath)) {
		throw new Error("jobId cannot be combined with clientId/client or path");
	}
	if (!explicitFileId && !explicitJobId && (!clientFilter || !filePath)) {
		throw new Error(
			"Missing required parameters: fileId, jobId, or clientId (or client) + path",
		);
	}

	let fileId = explicitFileId;
	let jobId = explicitJobId;
	if (!fileId && jobId) {
		fileId = fileIdFromExportJob(await client.jobs.get(jobId));
	} else if (!fileId) {
		if (!clientFilter || !filePath) {
			throw new Error(
				"Missing required parameters: fileId, jobId, or clientId (or client) + path",
			);
		}
		const clientId = await resolveClientId(client, clientFilter);
		const rootDir = await resolveRootDir(
			client,
			clientId,
			optionalText(params.rootDir),
		);
		const created = await client.jobs.create({
			clientId,
			type: "file.export",
			payload: { rootDir, path: filePath },
		});
		jobId = created.jobId;
		const job = await waitForExport(client, created.jobId, EXPORT_WAIT_MS);
		fileId = fileIdFromExportJob(job);
	}
	if (!fileId) {
		throw new Error("Unable to resolve fileId for share");
	}

	const share = await client.storageShares.create({ fileId });
	const url = publicUrl(baseUrl, share.sharePath);
	const content: VcpContentItem[] = [
		{
			type: "text",
			text: `[下载 ${share.filename}](<${url}>)\n分享 ID: ${share.id}`,
		},
	];
	const jobHint = jobId ? `，导出 Job: ${jobId}` : "";
	return {
		status: "success",
		content,
		messageForAI: `文件 ${share.filename} 已创建公开下载链接（分享 ID: ${share.id}，fileId: ${fileId}${jobHint}）。链接无需认证、除撤销外长期有效；撤销请调用 RevokeShare。`,
	};
}

/** 兼容旧命令名 DownloadFile：行为与 ShareFile 一致。 */
export async function handleDownloadFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
	baseUrl: string,
): Promise<VcpResponse> {
	return handleShareFile(client, params, baseUrl);
}

/** 查询公开分享记录，支持按 fileId 与状态过滤。 */
export async function handleListShares(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const rawStatus = optionalText(params.status);
	let status: StorageShareStatus | undefined;
	if (rawStatus) {
		if (!SHARE_STATUSES.includes(rawStatus as StorageShareStatus)) {
			throw new Error(
				`Invalid status "${rawStatus}"; expected one of: ${SHARE_STATUSES.join(", ")}`,
			);
		}
		status = rawStatus as StorageShareStatus;
	}

	const shares = await client.storageShares.list({
		fileId: optionalText(params.fileId),
		status,
		page: numberParam(params.page),
		pageSize: numberParam(params.pageSize),
	});

	return {
		status: "success",
		content: [{ type: "text", text: JSON.stringify(shares, null, 2) }],
		messageForAI: `查询到 ${shares.total} 条公开分享记录（第 ${shares.page}/${shares.totalPages} 页）。`,
	};
}

/** 撤销公开分享；链接随即失效。 */
export async function handleRevokeShare(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const shareId = optionalText(params.shareId) ?? optionalText(params.id);
	if (!shareId) {
		throw new Error("Missing required parameter: shareId");
	}

	const share = await client.storageShares.revoke(shareId);
	return {
		status: "success",
		content: [{ type: "text", text: JSON.stringify(share, null, 2) }],
		messageForAI: `已撤销分享 ${shareId}（状态: ${share.status}）。该链接已不可用。`,
	};
}
