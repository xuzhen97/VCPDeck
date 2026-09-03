import type { VcpDeckClient } from "@vcpdeck/sdk";

/**
 * 解析用户输入的 client 标识（支持 clientId 或 clientName）为权威的 clientId
 */
export async function resolveClientId(
	client: VcpDeckClient,
	filter: string,
): Promise<string> {
	if (!filter) throw new Error("Missing client filter");
	const list = await client.clients.list();
	const match = list.find((c) => c.clientId === filter || c.name === filter);
	if (!match) {
		throw new Error(
			`未找到匹配的机器 "${filter}"，请先调用 ListClients 查看可用机器列表。`,
		);
	}
	return match.clientId;
}

/**
 * 自动解析目标机器的 rootDir（未提供时探测：单根自动选用，多根报错提示）
 */
export async function resolveRootDir(
	client: VcpDeckClient,
	clientId: string,
	specifiedRoot?: string,
): Promise<string> {
	if (specifiedRoot) return specifiedRoot;
	const roots = await client.files.roots(clientId);
	if (!roots || roots.length === 0) {
		throw new Error(`机器 ${clientId} 未配置任何授权文件根目录。`);
	}
	if (roots.length === 1) {
		return roots[0];
	}
	throw new Error(
		`机器 ${clientId} 拥有多个授权根目录 [${roots.join(", ")}]，请显式提供 rootDir 参数。`,
	);
}
