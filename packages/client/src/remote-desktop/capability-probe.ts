import { randomUUID } from "node:crypto";
import {
	parseRemoteDesktopCapabilityStatus,
	type RemoteDesktopCapabilityStatus,
	type RemoteDesktopClientRequest,
} from "@vcpdeck/shared";
import {
	createDefaultDesktopHostIpcClient,
	DesktopHostIpcClient,
	type DesktopHostIpcTransport,
} from "./ipc-client.js";

export interface RemoteDesktopProbeDeps {
	connect?: () => DesktopHostIpcClient;
	transport?: () => DesktopHostIpcTransport;
	platform?: NodeJS.Platform;
	endpoint?: string;
	generationId?: string;
}

const unavailable = (diagnosticCode: RemoteDesktopCapabilityStatus["diagnosticCode"] = "REMOTE_DESKTOP_HOST_OFFLINE"): RemoteDesktopCapabilityStatus => ({
	protocolVersion: 1,
	hostVersion: "unavailable",
	available: false,
	backend: "unknown",
	capture: false,
	pointer: false,
	keyboard: false,
	clipboardText: false,
	loginScreen: false,
	lockScreen: false,
	secureAttention: false,
	physicalDisplay: false,
	virtualDisplay: false,
	headless: false,
	hardwareEncoders: [],
	supportedCodecs: [],
	diagnosticCode,
});

/** 探测本机特权 Desktop Host；失败仅上报安全不可用摘要。 */
export async function probeRemoteDesktopCapability(deps: RemoteDesktopProbeDeps = {}): Promise<RemoteDesktopCapabilityStatus> {
	if (deps.platform && deps.platform !== "win32" && deps.platform !== "linux") return unavailable("REMOTE_DESKTOP_UNSUPPORTED");
	let connect = deps.connect;
	if (!connect && deps.transport) {
		const transportFactory = deps.transport;
		connect = () => new DesktopHostIpcClient({
			transport: transportFactory(),
			generationId: deps.generationId ?? randomUUID(),
		});
	}
	if (!connect) {
		const endpoint = deps.endpoint;
		connect = () => createDefaultDesktopHostIpcClient({
			endpoint: endpoint ?? undefined,
			generationId: deps.generationId,
		});
	}
	const client = connect();
	const request: RemoteDesktopClientRequest = {
		requestId: randomUUID(),
		protocolVersion: 1,
		action: "session.state",
		sessionId: "capability-probe",
	};
	try {
		const response = await client.request(request);
		if (!response.ok || !response.result) return unavailable(response.error?.code ?? "REMOTE_DESKTOP_HOST_OFFLINE");
		return parseRemoteDesktopCapabilityStatus(response.result.capability);
	} catch {
		return unavailable();
	} finally {
		client.close();
	}
}
