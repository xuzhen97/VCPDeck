import { createAuthenticatedClient } from "./authenticated-client.js";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";

/** 按 CLI 环境解析配置，把机器名称或 clientId 解析为权威 clientId。 */
export async function resolveClientId(
	clientFilter: string,
	paths?: ConfigPaths,
	processEnv?: NodeJS.ProcessEnv,
	client?: VcpDeckClient,
): Promise<string> {
	const resolvedClient =
		client ??
		(await createAuthenticatedClient(
			await resolveEnvironment({ paths, processEnv }),
		));
	const clients = await resolvedClient.clients.list();
	const matched = clients.find(
		(entry) => entry.clientId === clientFilter || entry.name === clientFilter,
	);
	if (!matched) {
		throw new Error(
			`未找到 Client "${clientFilter}"；先用 vcpdeck clients list 查看可用机器`,
		);
	}
	return matched.clientId;
}

/**
 * 通过在线 Client 列表定位目标 Client（SDK 无单个 get）；未找到返回 null。
 * 供执行前 root 等价风险提示读取 capabilityDetails（ADR-0023）。
 */
export async function findClientByClientId(
	client: VcpDeckClient,
	clientId: string,
): Promise<import("@vcpdeck/shared").ClientInfo | null> {
	try {
		const all = await client.clients.list();
		return all.find((entry) => entry.clientId === clientId) ?? null;
	} catch {
		return null;
	}
}

/** 探测目标机可用授权根（file.roots）。 */
export async function fetchClientRoots(
	client: VcpDeckClient,
	clientId: string,
): Promise<string[]> {
	const roots = await client.files.roots(clientId);
	return Array.isArray(roots) ? roots : [];
}
