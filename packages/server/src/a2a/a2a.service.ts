import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
	ACP_PERMISSION_EXTENSION_URI,
	A2A_LIMITS,
	A2aProtocolError,
	type A2aAgentCard,
	type A2aJsonRpcRequest,
	type A2aJsonRpcResponse,
	type A2aListTasksResult,
	type A2aMessage,
	type ActorContext,
	type A2aPermissionExtension,
	fromA2aTaskState,
	toA2aTask,
} from "@vcpdeck/shared";
import {
	AgentRegistryError,
	AgentRegistryService,
} from "../agent-registry/agent-registry.service.js";
import {
	TaskAuditService,
} from "../task/task-audit.service.js";
import {
	TaskDispatchError,
	TaskDispatchService,
} from "../task/task-dispatch.service.js";
import {
	TaskService,
	TaskServiceError,
} from "../task/task.service.js";

function ok(id: string | number, result: unknown): A2aJsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(
	id: string | number,
	code: number,
	message: string,
	data?: unknown,
): A2aJsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data !== undefined ? { data } : {}) },
	};
}

function errorResponse(
	id: string | number,
	error: unknown,
): A2aJsonRpcResponse {
	if (error instanceof A2aProtocolError) {
		return rpcError(id, error.rpcCode, error.message);
	}
	if (
		error instanceof TaskServiceError ||
		error instanceof AgentRegistryError ||
		error instanceof TaskDispatchError
	) {
		return rpcError(id, -32000, error.message, { code: error.code });
	}
	return rpcError(id, -32603, "Internal error");
}

/** A2A JSON-RPC facade；只把 Task 域投影为 A2A v1.0 wire，不暴露 ACP。 */
@Injectable()
export class A2aService {
	constructor(
		@Inject(TaskService) private readonly tasks: TaskService,
		@Inject(AgentRegistryService) private readonly agents: AgentRegistryService,
		@Optional()
		@Inject(TaskDispatchService)
		private readonly dispatch?: TaskDispatchService,
		@Optional()
		@Inject(TaskAuditService)
		private readonly audit?: TaskAuditService,
	) {}

	/** 测试构造：注入任务、代理、派发与审计替身。 */
	static withDeps(
		tasks: TaskService,
		agents: AgentRegistryService,
		dispatch?: TaskDispatchService,
		audit?: Pick<TaskAuditService, "record">,
	): A2aService {
		return new A2aService(
			tasks,
			agents,
			dispatch,
			audit as TaskAuditService | undefined,
		);
	}

	async rpc(
		request: A2aJsonRpcRequest,
		actor: ActorContext,
	): Promise<A2aJsonRpcResponse> {
		try {
			switch (request.method) {
				case "SendMessage":
					return ok(request.id, await this.sendMessage(request.params, actor));
				case "GetTask":
					return ok(
						request.id,
						toA2aTask(
							await this.tasks.getTask(
								request.params.id,
								request.params.historyLength,
							),
							await this.taskHistory(
								request.params.id,
								request.params.historyLength,
							),
						),
					);
				case "ListTasks": {
					const page = await this.listTasks(request.params);
					return ok(request.id, page);
				}
				case "CancelTask": {
					const before = await this.tasks.getTask(request.params.id);
					const canceled = await this.tasks.cancelTask(request.params.id, actor);
					const wasTerminal =
						before.state === "completed" ||
						before.state === "canceled" ||
						before.state === "rejected" ||
						before.state === "failed";
					if (!wasTerminal) {
						await this.dispatch?.cancel(request.params.id);
					}
					return ok(
					request.id,
					toA2aTask(canceled, await this.taskHistory(request.params.id)),
				);
				}
			}
		} catch (error) {
			return errorResponse(request.id, error);
		}
	}

	async agentCard(baseUrl: string): Promise<A2aAgentCard> {
		return this.agents.agentCard(baseUrl);
	}

	/**
	 * 把 TaskTurn 组装成 A2A history（inbound=user，outbound=agent）。
	 *
	 * agent 输出正文是 settle 时才落库的（见 TaskDispatchService），所以历史里
	 * 的 outbound 轮只在任务收尾后可见。读不到 turns 时返回 undefined：
	 * 旧 Task / 旧 TaskService 没有这份投影，不能因此报错。
	 */
	private async taskHistory(
		taskId: string,
		historyLength?: number,
	): Promise<A2aMessage[] | undefined> {
		try {
			const turns = await this.tasks.listTurns(taskId);
			const messages: A2aMessage[] = [];
			for (const turn of turns) {
				// outbound 有全文；inbound 只存摘要（安全决策），用 summary 回填
				// 让多轮上下文不缺 user 回合——不给 200 字而已，不给整段 prompt。
				const text = turn.content ?? turn.summary ?? "";
				if (text.length === 0) continue;
				messages.push({
					messageId: turn.messageId,
					role: turn.direction === "inbound" ? "user" : "agent",
					parts: [{ text }],
				});
			}
			const limit =
				historyLength && historyLength > 0
					? Math.min(historyLength, A2A_LIMITS.maxHistoryLength)
					: A2A_LIMITS.maxHistoryLength;
			return messages.slice(Math.max(0, messages.length - limit));
		} catch {
			return undefined;
		}
	}

	private async sendMessage(
		params: Extract<A2aJsonRpcRequest, { method: "SendMessage" }>["params"],
		actor: ActorContext,
	): Promise<ReturnType<typeof toA2aTask>> {
		const { message, metadata } = params;
		const text = message.parts.map((part) => part.text).join("");
		if (message.taskId) {
			const existing = await this.tasks.getTask(message.taskId);
			if (
				existing.state === "completed" ||
				existing.state === "canceled" ||
				existing.state === "rejected" ||
				existing.state === "failed"
			) {
				throw new TaskServiceError("TASK_TERMINAL", "Task 已到终态", 409);
			}
			const permission = metadata?.extensions?.[
				ACP_PERMISSION_EXTENSION_URI
			] as A2aPermissionExtension | undefined;
			if (permission) {
				if (!this.dispatch) {
					throw new A2aProtocolError(
						"ACP permission bridge 尚未接入",
						-32002,
					);
				}
				await this.dispatch.resolvePermission(
					message.taskId,
					permission.requestId,
					{ outcome: "selected", optionId: permission.optionId },
				);
				return toA2aTask(await this.tasks.getTask(message.taskId));
			}
			if (existing.state === "input-required") {
				throw new A2aProtocolError(
					"Task 正在等待 permission 回答，不能直接追加 prompt",
					-32000,
				);
			}
			await this.tasks.appendUserTurn(message.taskId, message, actor);
			await this.audit?.record({
				taskId: message.taskId,
				source: "a2a",
				event: "turn.started",
				fidelity: "summary",
			});
			if (this.dispatch) {
				await this.dispatch.prompt(message.taskId, text);
				return toA2aTask(await this.tasks.getTask(message.taskId));
			}
			const next =
				existing.state === "submitted" ? "working" : existing.state;
			return toA2aTask(
				next === existing.state
					? existing
					: await this.tasks.transition(message.taskId, next),
			);
		}
		const agentId = metadata?.agentId;
		const intent = metadata?.intent;
		if (!agentId || !intent) {
			throw new A2aProtocolError(
				"新任务必须提供 metadata.agentId 与 intent",
				-32602,
			);
		}
		const task = await this.tasks.createTask(
			{
				agentId,
				intent,
				acceptanceCriteria: metadata?.acceptanceCriteria ?? [],
				constraints: metadata?.constraints ?? {},
				...(message.contextId ? { contextId: message.contextId } : {}),
			},
			actor,
		);
		await this.audit?.record({
			taskId: task.id,
			source: "a2a",
			event: "task.created",
			fidelity: "summary",
			data: {
				agentId,
				intentChars: intent.length,
				intentHash: createHash("sha256").update(intent).digest("hex"),
				acceptanceCriteria: metadata?.acceptanceCriteria?.length ?? 0,
				constraints: Object.keys(metadata?.constraints ?? {}),
			},
		});
		await this.tasks.appendUserTurn(task.id, message, actor);
		await this.audit?.record({
			taskId: task.id,
			source: "a2a",
			event: "turn.started",
			fidelity: "summary",
		});
		if (this.dispatch) {
			await this.dispatch.start(task.id, text);
			return toA2aTask(await this.tasks.getTask(task.id));
		}
		return toA2aTask(task);
	}

	private async listTasks(
		params: Extract<A2aJsonRpcRequest, { method: "ListTasks" }>["params"],
	): Promise<A2aListTasksResult> {
		const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
		const token = Number(params.pageToken);
		const page = Number.isInteger(token) && token >= 1 ? token : 1;
		const result = await this.tasks.listTasks(
			{
				...(params.contextId ? { contextId: params.contextId } : {}),
				...(params.status
					? { state: fromA2aTaskState(params.status) }
					: {}),
			},
			page,
			pageSize,
		);
		return {
			// 列表不带 history：正文可能很大，按需用 GetTask 取。
			tasks: result.data.map((info) => toA2aTask(info)),
			nextPageToken:
				result.page < result.totalPages ? String(result.page + 1) : "",
			pageSize: result.pageSize,
			totalSize: result.total,
		};
	}
}
