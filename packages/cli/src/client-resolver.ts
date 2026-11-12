import type { VcpDeckClient } from "@vcpdeck/sdk";

/**
 * 用调用方已按 `--env` 解析并鉴权的 SDK 客户端，把机器名称或 clientId 解析为权威 clientId。
 * 必须传入 client：自行创建客户端会丢掉 `--env`/`--environment` 解析结果，回落到默认环境。
 */
export async function resolveClientId(
	clientFilter: string,
	client: VcpDeckClient,
): Promise<string> {
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
