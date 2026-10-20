import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
	type AcpPermissionOutcome,
	type TaskClientCommand,
	type TaskClientEvent,
	type TaskCommandResult,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { AgentRegistryService } from "../agent-registry/agent-registry.service.js";
import { TaskAuditService } from "./task-audit.service.js";
import { TaskService } from "./task.service.js";

export type TaskDispatchErrorCode =
	| "TASK_CLIENT_OFFLINE"
	| "TASK_RUNTIME_NOT_FOUND"
	| "TASK_COMMAND_TIMEOUT"
	| "TASK_COMMAND_FAILED"
	| "TASK_ADAPTER_UNSUPPORTED";

export class TaskDispatchError extends Error {
	constructor(
		readonly code: TaskDispatchErrorCode,
		message: string,
	) {
		super(message);
		this.name = "TaskDispatchError";
	}
}

export interface TaskDispatchDeps {
	prisma: PrismaService;
	tasks: TaskService;
	registry: Pick<AgentRegistryService, "resolveById">;
	send: (socketId: string, command: TaskClientCommand) => void;
	audit?: Pick<TaskAuditService, "record">;
}

interface Runtime {
	taskId: string;
	attemptId: string;
	clientId: string;
	socketId: string;
	failed?: boolean;
	pending: Map<
		string,
		{
			resolve: (result: TaskCommandResult) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>;
	/** agent 流式输出按 messageId 累积；settle 时落库供 A2A 回传。 */
	agentMessages: Map<string, string>;
}

function dispatchError(code: TaskDispatchErrorCode, message: string): Error {
	return new TaskDispatchError(code, message);
}

/** 任务派发：Task → placement → Client socket；只传受控命令，不传任意 shell。 */
@Injectable()
export class TaskDispatchService {
	private deps: TaskDispatchDeps | null = null;
	private readonly runtimes = new Map<string, Runtime>();
	private send: ((socketId: string, command: TaskClientCommand) => void) | null = null;

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(TaskService) tasks: TaskService,
		@Inject(AgentRegistryService) registry: AgentRegistryService,
		@Optional() @Inject(TaskAuditService) audit?: TaskAuditService,
	) {
		this.deps =
			prisma && tasks && registry
				? {
						prisma,
						tasks,
						registry,
						send: () => undefined,
						...(audit ? { audit } : {}),
					}
				: null;
	}

	static withDeps(deps: TaskDispatchDeps): TaskDispatchService {
		const service = new TaskDispatchService(
			null as unknown as PrismaService,
			null as unknown as TaskService,
			null as unknown as AgentRegistryService,
		);
		service.deps = deps;
		service.send = deps.send;
		return service;
	}

	bindEmitter(fn: (socketId: string, command: TaskClientCommand) => void): void {
		this.send = fn;
	}

	private requireDeps(): TaskDispatchDeps {
		if (!this.deps) {
			throw dispatchError("TASK_COMMAND_FAILED", "Task dispatch is not configured");
		}
		return this.deps;
	}

	private command(
		runtime: Pick<Runtime, "taskId" | "attemptId">,
		action: TaskClientCommand["action"],
		extra: Partial<TaskClientCommand> = {},
	): TaskClientCommand {
		return {
			requestId: `tc_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
			taskId: runtime.taskId,
			attemptId: runtime.attemptId,
			action,
			...extra,
		} as TaskClientCommand;
	}

	private request(
		runtime: Runtime,
		command: TaskClientCommand,
		timeoutMs: number,
	): Promise<TaskCommandResult> {
		const send = this.send;
		if (!send) {
			return Promise.reject(
				dispatchError("TASK_CLIENT_OFFLINE", "Client task channel is not connected"),
			);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				runtime.pending.delete(command.requestId);
				reject(
					dispatchError("TASK_COMMAND_TIMEOUT", "Client task command timed out"),
				);
			}, timeoutMs);
			runtime.pending.set(command.requestId, { resolve, reject, timer });
			send(runtime.socketId, command);
		});
	}

	/** 启动一次 ACP attempt；首个 prompt 在后台推进。 */
	async start(taskId: string, prompt: string): Promise<void> {
		const deps = this.requireDeps();
		const task = await deps.tasks.getTask(taskId);
		if (!task.agentPlacementId) {
			throw dispatchError("TASK_COMMAND_FAILED", "Task has no agent placement");
		}
		const placement = await deps.registry.resolveById(task.agentPlacementId);
		if (placement.adapter !== "acp") {
			await deps.tasks
				.transition(taskId, "failed", {
					errorCode: "TASK_ADAPTER_UNSUPPORTED",
					errorMessage: "Only ACP adapter is currently executable",
				})
				.catch(() => undefined);
			throw dispatchError(
				"TASK_ADAPTER_UNSUPPORTED",
				"Only ACP adapter is currently executable",
			);
		}
		const client = await deps.prisma.client.findUnique({
			where: { id: placement.clientId },
			select: { socketId: true, online: true },
		});
		if (!client?.online || !client.socketId) {
			await deps.tasks
				.transition(taskId, "failed", {
					errorCode: "TASK_CLIENT_OFFLINE",
					errorMessage: "Target Client is offline",
				})
				.catch(() => undefined);
			throw dispatchError("TASK_CLIENT_OFFLINE", "Target Client is offline");
		}
		const attempt = await deps.tasks.createAttempt(taskId, "acp");
		const runtime: Runtime = {
			taskId,
			attemptId: attempt.attemptId,
			clientId: placement.clientId,
			socketId: client.socketId,
			pending: new Map(),
			agentMessages: new Map(),
		};
		this.runtimes.set(taskId, runtime);
		await deps.tasks.transition(taskId, "working");
		await this.record(taskId, "task.routed", "summary", {
			attemptId: attempt.attemptId,
			agentId: placement.agentId,
		});
		const startCommand = this.command(runtime, "start", {
			command: placement.command,
			args: placement.args,
			cwd: placement.cwd,
		});
		let result: TaskCommandResult;
		try {
			result = await this.request(runtime, startCommand, 30_000);
		} catch (error) {
			this.runtimes.delete(taskId);
			const code = (error as { code?: string }).code ?? "TASK_START_FAILED";
			const message =
				(error as { message?: string }).message ?? "Task start failed";
			await deps.tasks
				.finishAttempt(attempt.attemptId, "failed", code)
				.catch(() => undefined);
			await deps.tasks
				.transition(taskId, "failed", {
					errorCode: code,
					errorMessage: message,
				})
				.catch(() => undefined);
			await this.record(taskId, "task.failed", "summary", { code });
			throw error;
		}
		if (!result.ok) {
			this.runtimes.delete(taskId);
			await deps.tasks.finishAttempt(attempt.attemptId, "failed", result.error?.code);
			await deps.tasks.transition(taskId, "failed", {
				errorCode: result.error?.code ?? "TASK_START_FAILED",
				errorMessage: result.error?.message ?? "Task start failed",
			});
			await this.record(taskId, "task.failed", "summary", {
				code: result.error?.code ?? "TASK_START_FAILED",
			});
			throw dispatchError("TASK_COMMAND_FAILED", "Client failed to start task");
		}
		void this.promptAndSettle(taskId, prompt);
	}

	/** 追加一轮 prompt 并等待本轮结算。 */
	async prompt(taskId: string, text: string): Promise<void> {
		const runtime = this.runtimes.get(taskId);
		if (!runtime) {
			throw dispatchError("TASK_RUNTIME_NOT_FOUND", "Task runtime not found");
		}
		const command = this.command(runtime, "prompt", { text });
		let result: TaskCommandResult;
		try {
			result = await this.request(runtime, command, 10 * 60_000);
		} catch (error) {
			const code = (error as { code?: string }).code ?? "TASK_COMMAND_FAILED";
			await this.failTask(
				taskId,
				runtime,
				code,
				(error as { message?: string }).message ?? "Client prompt failed",
			);
			throw error;
		}
		if (!result.ok) {
			const code = result.error?.code ?? "TASK_COMMAND_FAILED";
			const message = result.error?.message ?? "Client prompt failed";
			await this.failTask(taskId, runtime, code, message);
			throw dispatchError("TASK_COMMAND_FAILED", message);
		}
		await this.settle(taskId, result.stopReason);
	}

	/** 取消当前 attempt；不把取消信号当成终态。 */
	async cancel(taskId: string): Promise<void> {
		const runtime = this.runtimes.get(taskId);
		if (!runtime) return;
		const command = this.command(runtime, "cancel");
		await this.request(runtime, command, 15_000).catch(() => undefined);
	}

	/** 回答 ACP permission；由 TaskService 把状态从 input-required 推回 working。 */
	async resolvePermission(
		taskId: string,
		requestId: string,
		outcome: AcpPermissionOutcome,
	): Promise<void> {
		const runtime = this.runtimes.get(taskId);
		if (!runtime) {
			throw dispatchError("TASK_RUNTIME_NOT_FOUND", "Task runtime not found");
		}
		const command = this.command(runtime, "permission", {
			permissionRequestId: requestId,
			outcome,
		});
		const result = await this.request(runtime, command, 15_000);
		if (!result.ok) {
			throw dispatchError("TASK_COMMAND_FAILED", "Client permission failed");
		}
		await this.requireDeps().tasks.transition(taskId, "working");
	}

	/** Client 确认离线：结算该机器上所有未完成的 Task attempt。 */
	async failByClientId(clientId: string): Promise<void> {
		const deps = this.requireDeps();
		for (const [taskId, runtime] of [...this.runtimes]) {
			if (runtime.clientId !== clientId) continue;
			const current = await deps.tasks.getTask(taskId).catch(() => null);
			if (
				!current ||
				current.state === "completed" ||
				current.state === "canceled" ||
				current.state === "rejected" ||
				current.state === "failed"
			) {
				this.runtimes.delete(taskId);
				continue;
			}
			const pending = [...runtime.pending.values()];
			for (const item of pending) clearTimeout(item.timer);
			runtime.pending.clear();
			this.runtimes.delete(taskId);
			try {
				await deps.tasks.transition(taskId, "failed", {
					errorCode: "TASK_CLIENT_DISCONNECTED",
					errorMessage: "Target Client disconnected",
				});
				await this.record(taskId, "task.failed", "summary", {
					code: "TASK_CLIENT_DISCONNECTED",
				});
			} catch {
				// Task 已终态或并发收敛：不覆盖既有结果。
			}
			await deps.tasks
				.finishAttempt(runtime.attemptId, "failed", "TASK_CLIENT_DISCONNECTED")
				.catch(() => undefined);
			for (const item of pending) {
				item.reject(dispatchError("TASK_CLIENT_OFFLINE", "Client disconnected"));
			}
		}
	}

	/** Client 回报命令结果：按 requestId 关联，拒绝旧 socket。 */
	handleCommandResult(socketId: string, result: TaskCommandResult): void {
		for (const runtime of this.runtimes.values()) {
			if (runtime.socketId !== socketId) continue;
			const pending = runtime.pending.get(result.requestId);
			if (!pending) continue;
			clearTimeout(pending.timer);
			runtime.pending.delete(result.requestId);
			// 成功/失败都交给调用方判断；否则 start 的失败分支永远不可达。
			pending.resolve(result);
			return;
		}
	}

	/** Client 投影事件：权限请求进入 input-required；进程错误进入 failed。 */
	async handleEvent(socketId: string, event: TaskClientEvent): Promise<void> {
		const runtime = this.runtimes.get(event.taskId);
		if (!runtime) return;
		if (runtime.socketId !== socketId || runtime.attemptId !== event.attemptId) return;
		await this.recordAcpEvent(event);
		if (event.event.type === "permission.requested") {
			await this.requireDeps().tasks.transition(event.taskId, "input-required");
		}
		if (
			event.event.type === "session.ended" &&
			event.event.reason === "error"
		) {
			await this.failTask(
				event.taskId,
				runtime,
				"ACP_SESSION_ENDED",
				"ACP agent exited unexpectedly",
			);
		}
	}

	private async failTask(
		taskId: string,
		runtime: Runtime,
		code: string,
		message: string,
	): Promise<void> {
		const deps = this.requireDeps();
		runtime.failed = true;
		for (const pending of runtime.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(dispatchError("TASK_COMMAND_FAILED", message));
		}
		runtime.pending.clear();
		await deps.tasks
			.finishAttempt(runtime.attemptId, "failed", code)
			.catch(() => undefined);
		try {
			await deps.tasks.transition(taskId, "failed", {
				errorCode: code,
				errorMessage: message,
			});
			await this.record(taskId, "task.failed", "summary", { code });
		} catch {
			// 已终态或并发收敛：不覆盖既有结果。
		}
	}

	private async promptAndSettle(taskId: string, text: string): Promise<void> {
		try {
			await this.prompt(taskId, text);
		} catch (error) {
			const runtime = this.runtimes.get(taskId);
			if (runtime) {
				await this.failTask(
					taskId,
					runtime,
					(error as { code?: string }).code ?? "TASK_PROMPT_FAILED",
					(error as { message?: string }).message ?? "Prompt failed",
				);
			}
		}
	}

	private async settle(taskId: string, stopReason?: string): Promise<void> {
		const deps = this.requireDeps();
		const runtime = this.runtimes.get(taskId);
		if (runtime?.failed) {
			for (const pending of runtime.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(dispatchError("TASK_COMMAND_FAILED", "Task failed"));
			}
			runtime.pending.clear();
			this.runtimes.delete(taskId);
			return;
		}
		if (runtime) {
			for (const pending of runtime.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(dispatchError("TASK_COMMAND_FAILED", "Task closed"));
			}
			runtime.pending.clear();
			await deps.tasks
				.finishAttempt(
					runtime.attemptId,
					stopReason === "cancelled" ? "canceled" : "completed",
				)
				.catch(() => undefined);
		}
		// agent 输出正文在此落库：outbound 轮次（history）+ 最终回复 artifact。
		// 失败也尽力写——调用方至少能拿到部分输出，而不是只有 chars 统计。
		if (runtime && runtime.agentMessages.size > 0) {
			await this.flushAgentMessages(taskId, runtime);
		}
		if (runtime) this.runtimes.delete(taskId);
		if (stopReason === "cancelled") {
			await deps.tasks.transition(taskId, "canceled");
			await this.record(taskId, "task.canceled", "summary", {
				reason: "cancelled",
			});
		} else {
			await deps.tasks.transition(taskId, "completed");
			await this.record(taskId, "turn.completed", "summary", {
				stopReason: stopReason ?? "end_turn",
			});
			await this.record(taskId, "task.completed", "summary", {
				stopReason: stopReason ?? "end_turn",
			});
		}
	}

	/**
	 * 把累积的 agent 输出落成 outbound 轮次与 artifact。
	 *
	 * artifact 是 A2A 的标准结果位（`A2aTask.artifacts` 已映射）：调用方拿
	 * `text/plain` 的最终回复；多段输出时取最长的一段作为最终回复。
	 */
	private async flushAgentMessages(
		taskId: string,
		runtime: Runtime,
	): Promise<void> {
		const deps = this.requireDeps();
		const entries = [...runtime.agentMessages.entries()];
		runtime.agentMessages.clear();
		let longest = { id: "", text: "" };
		for (const [messageId, text] of entries) {
			if (text.length === 0) continue;
			await deps.tasks
				.appendAgentTurn(taskId, messageId, text)
				.catch(() => undefined);
			if (text.length > longest.text.length) longest = { id: messageId, text };
		}
		if (longest.id.length === 0) return;
		const content = longest.text.slice(0, TaskService.AGENT_TURN_MAX_CHARS);
		await deps.prisma.taskArtifact
			.create({
				data: {
					id: `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
					taskId,
					name: "agent-reply",
					mimeType: "text/plain",
					uri: `task://${taskId}/reply/${longest.id}`,
					sha256: createHash("sha256").update(content).digest("hex"),
					size: content.length,
				},
			})
			.catch(() => undefined);
	}

	private async record(
		taskId: string,
		event: string,
		fidelity: "structured" | "text" | "summary" | "hash-only",
		data?: unknown,
	): Promise<void> {
		await this.deps?.audit
			?.record({ taskId, source: "acp", event, fidelity, data })
			.catch(() => undefined);
	}

	private async recordAcpEvent(event: TaskClientEvent): Promise<void> {
		const value = event.event;
		const runtime = this.runtimes.get(event.taskId);
		switch (value.type) {
			case "agent.message.delta":
				// 正文按 messageId 累积在内存，settle 时落库：中途崩溃不写半截。
				if (runtime) {
					const prev = runtime.agentMessages.get(value.messageId) ?? "";
					runtime.agentMessages.set(value.messageId, prev + value.text);
				}
				await this.record(event.taskId, "message", "summary", {
					messageId: value.messageId,
					chars: value.text.length,
				});
				return;
			case "tool.started":
				await this.record(event.taskId, "tool_call", "structured", {
					toolCallId: value.toolCallId,
					title: value.title,
					...(value.kind ? { kind: value.kind } : {}),
					...(value.status ? { status: value.status } : {}),
					...(value.locations ? { locations: value.locations } : {}),
				});
				return;
			case "tool.updated":
				await this.record(event.taskId, "tool_call_update", "structured", {
					toolCallId: value.toolCallId,
					...(value.status ? { status: value.status } : {}),
				});
				return;
			case "plan.updated":
				await this.record(event.taskId, "plan", "summary", {
					entries: value.entries.length,
				});
				return;
			case "permission.requested":
				await this.record(event.taskId, "permission.requested", "structured", {
					requestId: value.requestId,
					toolCallId: value.toolCallId,
					options: value.options,
				});
				return;
			case "permission.resolved":
				await this.record(event.taskId, "permission.decided", "structured", {
					requestId: value.requestId,
					outcome: value.outcome,
					...(value.optionId ? { optionId: value.optionId } : {}),
				});
				return;
			case "usage.updated":
				await this.record(event.taskId, "usage", "structured", {
					used: value.used,
					size: value.size,
				});
				return;
			case "session.ended":
				await this.record(event.taskId, "state.changed", "summary", {
					reason: value.reason,
					...(value.code !== undefined ? { code: value.code } : {}),
				});
				return;
			default:
				return;
		}
	}
}
