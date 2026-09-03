import type { VcpDeckClient } from "@vcpdeck/sdk";
import type { VcpResponse } from "../types.js";
import { resolveClientId } from "../utils.js";

export async function handleListFrpInstances(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const page = params.page ? Number(params.page) : undefined;
	const pageSize = params.pageSize ? Number(params.pageSize) : undefined;
	const instances = await client.frp.instances.list({ page, pageSize });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(instances, null, 2),
			},
		],
		messageForAI: `FRP 实例列表获取成功，共 ${instances.total} 个实例。`,
	};
}

export async function handleGetFrpMapping(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const mappingId = String(params.mappingId || "");
	if (!mappingId) {
		throw new Error("Missing required parameter: mappingId");
	}

	const mapping = await client.frp.get(mappingId);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(mapping, null, 2),
			},
		],
		messageForAI: `FRP 映射 ${mappingId} 详情获取成功。`,
	};
}

export async function handleListFrpMappings(
	client: VcpDeckClient,
	params: Record<string, unknown> = {},
): Promise<VcpResponse> {
	const clientFilter = params.clientId || params.clientName || params.client;
	const clientId = clientFilter
		? await resolveClientId(client, String(clientFilter))
		: undefined;
	const page = params.page ? Number(params.page) : undefined;
	const pageSize = params.pageSize ? Number(params.pageSize) : undefined;

	const mappings = await client.frp.list({ clientId, page, pageSize });
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(mappings, null, 2),
			},
		],
		messageForAI: `FRP 映射列表获取成功，共 ${mappings.total} 条。`,
	};
}

export async function handleCreateFrpMapping(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const clientFilter = String(
		params.clientId || params.clientName || params.client || "",
	);
	const localPort = Number(params.localPort);
	const remotePort = Number(params.remotePort);
	const proxyType = (params.proxyType || params.type || "tcp") as
		| "tcp"
		| "http"
		| "https";

	if (!clientFilter || !localPort) {
		throw new Error("Missing required parameters: clientId (or client), localPort");
	}

	const clientId = await resolveClientId(client, clientFilter);

	const mapping = await client.frp.create({
		clientId,
		localPort,
		remotePort: remotePort || undefined,
		proxyType,
	});

	return {
		status: "success",
		content: [
			{
				type: "text",
				text: JSON.stringify(mapping, null, 2),
			},
		],
		messageForAI: `FRP 端口映射创建成功 (${localPort} -> ${remotePort || "auto"})。`,
	};
}

export async function handleDeleteFrpMapping(
	client: VcpDeckClient,
	params: Record<string, unknown>,
): Promise<VcpResponse> {
	const mappingId = String(params.mappingId || "");
	if (!mappingId) {
		throw new Error("Missing required parameter: mappingId");
	}

	await client.frp.delete(mappingId);
	return {
		status: "success",
		content: [
			{
				type: "text",
				text: `Successfully deleted FRP mapping ${mappingId}`,
			},
		],
		messageForAI: `FRP 端口映射 ${mappingId} 已删除。`,
	};
}
