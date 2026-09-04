import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpContentItem, VcpResponse } from "../types.js";
import { resolveClientId, resolveRootDir } from "../utils.js";

function publicUrl(base: string, sharePath: string): string {
	let parsed: URL;
	try {
		parsed = new URL(base);
	} catch {
		throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
	}
	return new URL(sharePath, `${parsed.toString().replace(/\/$/, "")}/`).toString();
}

/** 导出远程文件并返回公开分享链接；图片额外返回 VCP 图片内容。 */
export async function handleDownloadFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
	baseUrl: string,
): Promise<VcpResponse> {
	const clientFilter = String(params.clientId || params.clientName || params.client || "");
	const filePath = String(params.path || "");
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}
	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : undefined);
	const exported = await client.files.export(clientId, { rootDir, path: filePath });
	const share = await client.storageShares.create({ fileId: exported.fileId });
	const url = publicUrl(baseUrl, share.sharePath);
	const content: VcpContentItem[] = [
		{ type: "text", text: `[下载 ${share.filename}](<${url}>)` },
	];
	if (share.previewable) content.push({ type: "image_url", image_url: { url } });
	return {
		status: "success",
		content,
		messageForAI: `文件 ${share.filename} 已导出并创建公开下载链接。`,
	};
}
