import { createAuthenticatedClient } from "./authenticated-client.js";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";

/** 按 CLI 环境解析配置，把机器名称或 clientId 解析为权威 clientId。 */
export async function resolveClientId(
	clientFilter: string,
	paths?: ConfigPaths,
	processEnv?: NodeJS.ProcessEnv,
): Promise<string> {
	const environment = await resolveEnvironment({ paths, processEnv });
	const client = await createAuthenticatedClient(environment);
	const clients = await client.clients.list();
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

/** 探测目标机可用授权根（file.roots）。 */
export async function fetchClientRoots(
	client: VcpDeckClient,
	clientId: string,
): Promise<string[]> {
	const roots = await client.files.roots(clientId);
	return Array.isArray(roots) ? roots : [];
}
