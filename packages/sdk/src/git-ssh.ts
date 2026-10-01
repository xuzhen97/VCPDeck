import type { GitSshPublicInfo, GitSshStatus } from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

/**
 * Git SSH 共享密钥管理 API（ADR-0037 / ADR-0038）。
 *
 * 只暴露公钥、指纹与分发状态；服务端不提供任何读取私钥的入口。
 * `setTargets` 是**全量**选机替换：选机仅控制运维分发范围，
 * 不作为每机安全隔离的依据。
 */
export function createGitSshApi(client: Pick<VcpDeckClient, "request">) {
	return {
		/**
		 * 当前密钥投影；未生成时返回 null。
		 *
		 * Server 在无密钥时返回 200 空 body，SDK `request` 会解析成 `undefined`；
		 * 这里归一化为 `null`，使运行时值与声明类型一致。
		 */
		get: async (signal?: AbortSignal) =>
			(await client.request<GitSshPublicInfo | null | undefined>(
				"GET",
				"/api/git-ssh",
				undefined,
				signal,
			)) ?? null,
		/** 生成新一代密钥；公钥需人工登记到 Git 服务。 */
		generate: (signal?: AbortSignal) =>
			client.request<GitSshPublicInfo>("POST", "/api/git-ssh/generate", undefined, signal),
		/** 密钥与每机分发状态。 */
		status: (signal?: AbortSignal) =>
			client.request<GitSshStatus>("GET", "/api/git-ssh/status", undefined, signal),
		/** 全量替换选机集合。 */
		setTargets: (clientIds: string[], signal?: AbortSignal) =>
			client.request<GitSshStatus>("PUT", "/api/git-ssh/targets", { clientIds }, signal),
	};
}
