import type { Socket } from "socket.io-client";
import {
	Events,
	type AcpPermissionOutcome,
	type TaskClientCommand,
	type TaskCommandResult,
	parseTaskClientCommand,
} from "@vcpdeck/shared";
import type { AcpHost, AcpHostOptions } from "./acp-host.js";

export interface AcpTaskBridgeDeps {
	clientId: string;
	createHost: (options: AcpHostOptions) => AcpHost;
	now?: () => number;
}

interface PendingPermission {
	resolve: (outcome: AcpPermissionOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface TaskRuntime {
	host: AcpHost;
	attemptId: string;
	seq: number;
	pending: Map<string, PendingPermission>;
}

function bridgeError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function safeMessage(error: unknown): string {
	const message = (error as { message?: unknown })?.message;
	return typeof message === "string" && message.length > 0
		? message.slice(0, 200)
		: "Task command failed";
}

/** 把 ACP Host 接到 `/client` 的 task:command / task:event 事件。 */
export function attachAcpTaskBridge(
	socket: Socket,
	deps: AcpTaskBridgeDeps,
): void {
	const runtimes = new Map<string, TaskRuntime>();

	const sendResult = (result: TaskCommandResult): void => {
		if (socket.connected) socket.emit(Events.TASK_COMMAND_RESULT, result);
	};

	const sendEvent = (
		taskId: string,
		runtime: TaskRuntime,
		event: Parameters<AcpHostOptions["onEvent"]>[0],
	): void => {
		if (!socket.connected) return;
		runtime.seq += 1;
		socket.emit(Events.TASK_EVENT, {
			taskId,
			attemptId: runtime.attemptId,
			seq: runtime.seq,
			event,
		});
	};

	const closeRuntime = async (taskId: string, runtime: TaskRuntime): Promise<void> => {
		for (const pending of runtime.pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve({ outcome: "cancelled" });
		}
		runtime.pending.clear();
		await runtime.host.close().catch(() => undefined);
		runtimes.delete(taskId);
	};

	const handle = async (command: TaskClientCommand): Promise<TaskCommandResult> => {
		if (command.action === "start") {
			if (runtimes.has(command.taskId)) {
				throw bridgeError("TASK_ALREADY_STARTED", "Task already started");
			}
			let runtime: TaskRuntime | null = null;
			const host = deps.createHost({
				command: command.command,
				args: command.args,
				cwd: command.cwd,
				onEvent: (event) => {
					if (runtime) sendEvent(command.taskId, runtime, event);
				},
				onPermission: (request) => {
					const active = runtime;
					if (!active) {
						return Promise.resolve<AcpPermissionOutcome>({
							outcome: "cancelled",
						});
					}
					return new Promise<AcpPermissionOutcome>((resolve) => {
						const timer = setTimeout(() => {
							active.pending.delete(request.requestId);
							resolve({ outcome: "cancelled" });
						}, 5 * 60_000);
						active.pending.set(request.requestId, { resolve, timer });
						sendEvent(command.taskId, active, {
							type: "permission.requested",
							requestId: request.requestId,
							toolCallId: request.toolCallId,
							...(request.title ? { title: request.title } : {}),
							options: request.options,
						});
					});
				},
				onExit: () => undefined,
			});
			runtime = {
				host,
				attemptId: command.attemptId,
				seq: 0,
				pending: new Map(),
			};
			runtimes.set(command.taskId, runtime);
			const started = await host.start();
			if (command.prompt) {
				void host.prompt(command.prompt).catch(() => {
					sendEvent(command.taskId, runtime as TaskRuntime, {
						type: "session.ended",
						reason: "error",
					});
				});
			}
			return {
				requestId: command.requestId,
				ok: true,
				sessionId: started.sessionId,
			};
		}

		const runtime = runtimes.get(command.taskId);
		if (!runtime) {
			throw bridgeError("TASK_NOT_STARTED", "Task is not started");
		}
		switch (command.action) {
			case "prompt": {
				const result = await runtime.host.prompt(command.text);
				return {
					requestId: command.requestId,
					ok: true,
					stopReason: result.stopReason,
				};
			}
			case "cancel":
				await runtime.host.cancel();
				return { requestId: command.requestId, ok: true };
			case "permission": {
				const pending = runtime.pending.get(command.permissionRequestId);
				if (!pending) {
					throw bridgeError("PERMISSION_NOT_PENDING", "Permission is not pending");
				}
				clearTimeout(pending.timer);
				runtime.pending.delete(command.permissionRequestId);
				pending.resolve(command.outcome);
				sendEvent(command.taskId, runtime, {
					type: "permission.resolved",
					requestId: command.permissionRequestId,
					...(command.outcome.outcome === "selected"
						? { optionId: command.outcome.optionId }
						: {}),
					outcome: command.outcome.outcome,
				});
				return { requestId: command.requestId, ok: true };
			}
			case "close":
				await closeRuntime(command.taskId, runtime);
				return { requestId: command.requestId, ok: true };
		}
	};

	socket.on(Events.TASK_COMMAND, (raw: unknown) => {
		let command: TaskClientCommand;
		try {
			command = parseTaskClientCommand(raw);
		} catch (error) {
			const requestId =
				typeof raw === "object" && raw !== null && "requestId" in raw
					? String((raw as { requestId: unknown }).requestId)
					: "";
			sendResult({
				requestId,
				ok: false,
				error: {
					code: "TASK_CLIENT_PROTOCOL_INVALID",
					message: safeMessage(error),
				},
			});
			return;
		}
		void handle(command)
			.then((result) => sendResult(result))
			.catch((error: unknown) =>
				sendResult({
					requestId: command.requestId,
					ok: false,
					error: {
						code: (error as { code?: string }).code ?? "TASK_COMMAND_FAILED",
						message: safeMessage(error),
					},
				}),
			);
	});

	socket.on("disconnect", () => {
		for (const [taskId, runtime] of runtimes) {
			void closeRuntime(taskId, runtime);
		}
	});
}
