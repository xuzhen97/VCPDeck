import {
	parseTailnetKeyInfo,
	parseTailnetKeyInput,
	parseTailnetStatus,
	type JobCreateResult,
	type PaginatedResult,
	type TailnetJobPayload,
	type TailnetKeyInfo,
	type TailnetKeyInput,
	type TailnetStatus,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireCount(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`Tailnet 分页响应字段 ${field} 不合法`);
	}
	return value;
}

/** 严格解析密钥分页响应，逐项拒绝畸形投影。 */
function parseKeysPage(raw: unknown): PaginatedResult<TailnetKeyInfo> {
	if (!isRecord(raw) || !Array.isArray(raw.data)) {
		throw new Error("Tailnet 分页响应不合法");
	}
	return {
		data: raw.data.map((item) => parseTailnetKeyInfo(item)),
		total: requireCount(raw.total, "total"),
		page: requireCount(raw.page, "page"),
		pageSize: requireCount(raw.pageSize, "pageSize"),
		totalPages: requireCount(raw.totalPages, "totalPages"),
	};
}

/**
 * Tailnet 凭据与机器管理 API（ADR-0062）。
 *
 * 导入正文只在本方法调用内出现；不记录、不回显、不放进 URL。
 * 删除只清理本地密文记录，Provider 侧密钥需运维自行撤销。
 */
export function createTailnetApi(client: Pick<VcpDeckClient, "request">) {
	return {
		/** 导入一枚凭据并保存密文；返回不含正文的投影。 */
		importKey: async (input: TailnetKeyInput, signal?: AbortSignal) => {
			const parsed = parseTailnetKeyInput(input);
			return parseTailnetKeyInfo(
				await client.request<unknown>(
					"POST",
					"/api/tailnet/keys",
					{
						name: parsed.name,
						authKey: parsed.authKey,
						declaredReuse: parsed.declaredReuse,
						declaredExpiresAt: parsed.declaredExpiresAt,
					},
					signal,
				),
			);
		},
		/** 分页列出凭据投影，顺序为最近导入优先。 */
		listKeys: async (
			options: { page?: number; pageSize?: number } = {},
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams();
			if (options.page !== undefined) params.set("page", String(options.page));
			if (options.pageSize !== undefined)
				params.set("pageSize", String(options.pageSize));
			const qs = params.toString();
			return parseKeysPage(
				await client.request<unknown>(
					"GET",
					`/api/tailnet/keys${qs ? `?${qs}` : ""}`,
					undefined,
					signal,
				),
			);
		},
		/** 删除本地密文记录；reserved 中的凭据由 Server 拒绝。 */
		deleteKey: async (id: string, signal?: AbortSignal) => {
			const raw = await client.request<unknown>(
				"DELETE",
				`/api/tailnet/keys/${encodeURIComponent(id)}`,
				undefined,
				signal,
			);
			if (!isRecord(raw) || raw.deleted !== true) {
				throw new Error("Tailnet 删除响应不合法");
			}
			return { deleted: true as const };
		},
		/** 机器 Tailnet 观测与能力状态；离线机器返回历史快照。 */
		status: async (clientId: string, signal?: AbortSignal) =>
			parseTailnetStatus(
				await client.request<unknown>(
					"GET",
					`/api/tailnet/clients/${encodeURIComponent(clientId)}`,
					undefined,
					signal,
				),
			),
		/** 发起管理 Job；正文由 SDK 显式构造，绝不透传调用方多余字段。 */
		manage: async (
			clientId: string,
			payload: TailnetJobPayload,
			signal?: AbortSignal,
		): Promise<JobCreateResult> => {
			let body: Record<string, unknown>;
			if (payload.action === "inspect") {
				body = { action: "inspect" };
			} else if (payload.action === "ensure") {
				body = {
					action: "ensure",
					credentialId: payload.credentialId,
					installIfMissing: payload.installIfMissing,
					// 只有显式确认时才带上：缺省请求体与 0.23.16 及更早逐字相同
					...(payload.allowUncertainReuse === true
						? { allowUncertainReuse: true }
						: {}),
				};
			} else {
				throw new Error("Tailnet 任务 action 不合法");
			}
			return client.request<JobCreateResult>(
				"POST",
				`/api/tailnet/clients/${encodeURIComponent(clientId)}/jobs`,
				body,
				signal,
			);
		},
	};
}
