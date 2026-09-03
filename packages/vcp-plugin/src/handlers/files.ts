import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
import { resolveClientId, resolveRootDir } from "../utils.js";

export async function handleListRoots(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	if (!clientFilter) {
		throw new Error("Missing required parameter: clientId (or client)");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const roots = await client.files.roots(clientId);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(roots, null, 2),
			},
		],
		messageForAI: `机器 ${clientId} 授权文件根目录获取成功: [${roots.join(", ")}]。`,
	};
}

export async function handleMakeDirectory(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	await client.files.mkdir(clientId, { rootDir, path: filePath });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: `Successfully created directory ${filePath}`,
			},
		],
		messageForAI: `目录 ${filePath} (根: ${rootDir}) 创建成功。`,
	};
}

export async function handleStatFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	const stat = await client.files.stat(clientId, rootDir, filePath);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(stat, null, 2),
			},
		],
		messageForAI: `文件/目录 ${filePath} 元数据获取成功。`,
	};
}

export async function handleListDirectory(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	if (!clientFilter) {
		throw new Error("Missing required parameter: clientId (or client)");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	const list = await client.files.list(clientId, rootDir, filePath);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(list, null, 2),
			},
		],
		messageForAI: `目录 ${filePath || rootDir} 浏览成功。`,
	};
}

export async function handleReadFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	const limit = params.limit ? Number(params.limit) : undefined;
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	const fileData = await client.files.readText(
		clientId,
		rootDir,
		filePath,
		limit,
	);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text:
					typeof fileData === "string"
						? fileData
						: JSON.stringify(fileData, null, 2),
			},
		],
		messageForAI: `文件 ${filePath} 读取成功。`,
	};
}

export async function handleWriteFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	const content = String(params.content ?? "");
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	await client.files.writeText(clientId, { rootDir, path: filePath, content });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: `Successfully wrote ${content.length} characters to ${filePath}`,
			},
		],
		messageForAI: `文件 ${filePath} 写入成功。`,
	};
}

export async function handleDeleteFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const filePath = String(params.path || "");
	if (!clientFilter || !filePath) {
		throw new Error("Missing required parameters: clientId (or client), path");
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	await client.files.delete(clientId, { rootDir, path: filePath });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: `Successfully deleted ${filePath}`,
			},
		],
		messageForAI: `文件 ${filePath} 删除成功。`,
	};
}

export async function handleMoveFile(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const source = String(params.source || "");
	const target = String(params.target || "");
	if (!clientFilter || !source || !target) {
		throw new Error(
			"Missing required parameters: clientId (or client), source, target",
		);
	}

	const clientId = await resolveClientId(client, clientFilter);
	const rootDir = await resolveRootDir(
		client,
		clientId,
		params.rootDir ? String(params.rootDir) : undefined,
	);

	await client.files.move(clientId, {
		rootDir,
		source,
		destination: target,
	});
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: `Successfully moved from ${source} to ${target}`,
			},
		],
		messageForAI: `文件已成功从 ${source} 移动到 ${target}。`,
	};
}
