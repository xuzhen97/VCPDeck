import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";

export async function handleListReleases(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const page = params.page ? Number(params.page) : undefined;
	const pageSize = params.pageSize ? Number(params.pageSize) : undefined;

	const releases = await client.releases.list({ page, pageSize });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(releases, null, 2),
			},
		],
		messageForAI: `成功获取 Release 版本列表，共 ${releases.total} 条记录。`,
	};
}
