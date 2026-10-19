import type { Socket } from "socket.io-client";
import {
	Events,
	parseRemoteDevClientCommand,
	type RemoteDevAcpSessionReport,
	type RemoteDevClientEvent,
	type RemoteDevCommandResult,
} from "@vcpdeck/shared";
import { createAcpHost } from "../acp/acp-host.js";
import {
	createRemoteDevRuntime,
	type RemoteDevRuntime,
} from "./remote-dev-runtime.js";
import type { RemoteDevTunnel } from "./remote-dev-tunnel.js";

export interface RemoteDevBridgeDeps {
	runtime?: RemoteDevRuntime;
	createHost?: typeof createAcpHost;
	/** 创建成功后懒建立 session 隧道；测试可省略。 */
	tunnelFactory?: (sessionId: string) => RemoteDevTunnel;
}

function errorResult(
	requestId: string,
	cause: unknown,
): RemoteDevCommandResult {
	const code =
		(cause as { code?: unknown }).code ??
		"RDS_COMMAND_FAILED";
	const message =
		(cause as { message?: unknown }).message ?? "RDS command failed";
	return {
		requestId,
		ok: false,
		error: {
			code: typeof code === "string" ? code : "RDS_COMMAND_FAILED",
			message: typeof message === "string" ? message.slice(0, 500) : "RDS command failed",
		},
	};
}

/** 把 `/client` 的 RDS_COMMAND 接到 Client runtime；结果走 RDS_COMMAND_RESULT。 */
export function attachRemoteDevBridge(
	socket: Socket,
	deps: RemoteDevBridgeDeps = {},
): void {
	const emit = (event: RemoteDevClientEvent) => {
		socket.emit(Events.RDS_EVENT, event);
	};
	const runtime =
		deps.runtime ??
		createRemoteDevRuntime({
			createHost: deps.createHost ?? createAcpHost,
			emit,
		});
	const tunnels = new Map<string, RemoteDevTunnel>();

	socket.on(Events.RDS_COMMAND, (raw: unknown) => {
		void (async () => {
			let command;
			try {
				command = parseRemoteDevClientCommand(raw);
			} catch (cause) {
				const requestId =
					typeof (raw as { requestId?: unknown })?.requestId === "string"
						? ((raw as { requestId: string }).requestId)
						: "unknown";
				socket.emit(Events.RDS_COMMAND_RESULT, errorResult(requestId, cause));
				return;
			}
			try {
				if (command.action === "session.create") {
					const created = await runtime.create(command);
					if (deps.tunnelFactory) {
						try {
							tunnels.get(command.sessionId)?.close();
							tunnels.set(
								command.sessionId,
								deps.tunnelFactory(command.sessionId),
							);
						} catch (cause) {
							await runtime.close(command.sessionId, "tunnel_error").catch(() => undefined);
							throw cause;
						}
					}
					socket.emit(Events.RDS_ACP_SESSION, {
						sessionId: created.sessionId,
						generationId: created.generationId,
						acpSessionId: created.acpSessionId,
					} satisfies RemoteDevAcpSessionReport);
					socket.emit(Events.RDS_COMMAND_RESULT, {
						requestId: command.requestId,
						ok: true,
						sessionId: created.sessionId,
						generationId: created.generationId,
					} satisfies RemoteDevCommandResult);
					return;
				}
				if (command.action === "agent.prompt") {
					const result = await runtime.prompt(command.sessionId, command.text);
					socket.emit(Events.RDS_COMMAND_RESULT, {
						requestId: command.requestId,
						ok: true,
						sessionId: command.sessionId,
						stopReason: result.stopReason,
					} satisfies RemoteDevCommandResult);
					return;
				}
				if (command.action === "agent.cancel") {
					await runtime.cancel(command.sessionId);
					socket.emit(Events.RDS_COMMAND_RESULT, {
						requestId: command.requestId,
						ok: true,
						sessionId: command.sessionId,
					} satisfies RemoteDevCommandResult);
					return;
				}
				if (command.action === "agent.permission") {
					runtime.permission(
						command.sessionId,
						command.permissionRequestId,
						command.outcome,
					);
					socket.emit(Events.RDS_COMMAND_RESULT, {
						requestId: command.requestId,
						ok: true,
						sessionId: command.sessionId,
					} satisfies RemoteDevCommandResult);
					return;
				}
				await runtime.close(command.sessionId, command.reason);
				tunnels.get(command.sessionId)?.close();
				tunnels.delete(command.sessionId);
				socket.emit(Events.RDS_COMMAND_RESULT, {
					requestId: command.requestId,
					ok: true,
					sessionId: command.sessionId,
				} satisfies RemoteDevCommandResult);
			} catch (cause) {
				socket.emit(
					Events.RDS_COMMAND_RESULT,
					errorResult(command.requestId, cause),
				);
			}
		})();
	});
}
