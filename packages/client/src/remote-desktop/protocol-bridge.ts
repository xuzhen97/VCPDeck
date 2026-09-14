import { Events, parseRemoteDesktopClientRequest, parseRemoteDesktopStateReport, type RemoteDesktopCapabilityStatus, type RemoteDesktopClientRequest } from "@vcpdeck/shared";
import type { Socket } from "socket.io-client";
import { createDefaultDesktopHostIpcClient, DesktopHostIpcClient } from "./ipc-client.js";
import { probeRemoteDesktopCapability } from "./capability-probe.js";

export interface RemoteDesktopBridgeDeps {
	clientId: string;
	getCapability: () => RemoteDesktopCapabilityStatus | undefined;
	probeCapability: () => Promise<RemoteDesktopCapabilityStatus>;
	createIpcClient?: () => DesktopHostIpcClient;
}

export interface RemoteDesktopBridge {
	probe(): Promise<RemoteDesktopCapabilityStatus>;
	close(): void;
	generation(): string | null;
}

/** Client 与 Desktop Host 的最小控制面桥；迁移验证模式不挂载业务请求处理器。 */
export function attachRemoteDesktopBridge(
	socket: Socket,
	deps: RemoteDesktopBridgeDeps,
	opts: { verifyOnly?: boolean } = {},
): RemoteDesktopBridge {
	let ipc: DesktopHostIpcClient | null = null;
	let generation = "";

	const requestHandler = (raw: unknown): void => {
		if (!ipc) return;
		let request: RemoteDesktopClientRequest;
		try {
			request = parseRemoteDesktopClientRequest(raw);
		} catch {
			return;
		}
		void ipc.request(request).then(
			(response) => {
				if (socket.connected) socket.emit(Events.REMOTE_DESKTOP_RESPONSE, response);
			},
			() => undefined,
		);
	};

	if (!opts.verifyOnly) socket.on(Events.REMOTE_DESKTOP_REQUEST, requestHandler);

	return {
		async probe() {
			const capability = deps.getCapability() ?? await deps.probeCapability();
			if (capability.available && !generation) generation = crypto.randomUUID();
			if (capability.available && !ipc) {
				ipc = deps.createIpcClient?.() ?? createDefaultDesktopHostIpcClient();
				ipc.onState((report) => {
					try {
						parseRemoteDesktopStateReport(report);
					} catch {
						return;
					}
					if (socket.connected) socket.emit(Events.REMOTE_DESKTOP_STATE, report);
				});
			}
			return capability;
		},
		generation() {
			return generation || null;
		},
		close() {
			ipc?.close();
			ipc = null;
		},
	};
}

export { DesktopHostIpcClient, probeRemoteDesktopCapability };
