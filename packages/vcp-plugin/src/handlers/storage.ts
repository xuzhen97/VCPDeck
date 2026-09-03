import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";

export async function handleGetStorageStatus(
	client: VcpDeckClient,
): Promise<VcpResponse> {
	const status = await client.storage.getBackendConfig();
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(status, null, 2),
			},
		],
		messageForAI: "存储后端状态查询成功。",
	};
}
