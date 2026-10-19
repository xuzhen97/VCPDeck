import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
	ActorContext,
	AcpAdapterEvent,
	PaginatedResult,
	RemoteDevAcpSessionReport,
	RemoteDevClientCommand,
	RemoteDevClientEvent,
	RemoteDevCommandResult,
	RemoteDevPortCreateRequest,
	RemoteDevPortInfo,
	RemoteDevSessionCreateRequest,
	RemoteDevSessionInfo,
	RemoteDevState,
	RemoteDevTranscriptEntry,
	RemoteDevTranscriptPayload,
} from "@vcpdeck/shared";
import {
	parseAcpAdapterEvent,
	RDS_LIMITS,
	RDS_TRANSCRIPT_MAX_ENTRIES,
	REMOTE_DEV_TERMINAL_STATES,
} from "@vcpdeck/shared";
import { AgentRegistryService } from "../agent-registry/agent-registry.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TerminalService } from "../terminal/terminal.service.js";
import { RemoteDevAuditService } from "./remote-dev-audit.service.js";
import {
	hasParentTraversal,
	isUnderRoot,
	normalizePath,
	parseJsonArray,
	portId,
	sessionId,
	toRemoteDevPortInfo,
	toRemoteDevSessionInfo,
	type RemoteDevPortRow,
	type RemoteDevSessionRow,
} from "./remote-dev-records.js";

export type RemoteDevErrorCode =
	| "RDS_CLIENT_OFFLINE"
	| "RDS_UNSUPPORTED_CLIENT"
	| "RDS_PLACEMENT_INVALID"
	| "RDS_WORKSPACE_INVALID"
	| "RDS_NOT_FOUND"
	| "RDS_INVALID_STATE"
	| "RDS_LIMIT_EXCEEDED"
	| "RDS_OPERATOR_REQUIRED"
	| "RDS_PORT_INVALID"
	| "RDS_RESUME_NOT_ALLOWED"
	| "RDS_RESUME_UNAVAILABLE"
	| "RDS_RESUME_MISMATCH"
	| "RDS_COMMAND_FAILED";

export class RemoteDevError extends Error {
	constructor(
		readonly code: RemoteDevErrorCode,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "RemoteDevError";
	}
}

function error(
	code: RemoteDevErrorCode,
	message: string,
	statusCode: number,
): RemoteDevError {
	return new RemoteDevError(code, message, statusCode);
}

export interface RemoteDevServiceDeps {
	prisma: PrismaService;
	agents: Pick<AgentRegistryService, "resolveById">;
	terminals: Pick<TerminalService, "closeByParent">;
	audit: Pick<RemoteDevAuditService, "record">;
	send?: (socketId: string, command: RemoteDevClientCommand) => void;
	now?: () => Date;
	createTimeoutMs?: number;
	closeTimeoutMs?: number;
}

const TERMINAL_STATES: readonly RemoteDevState[] = REMOTE_DEV_TERMINAL_STATES;

/**
 * 相邻 agent 事件能否合并成一条 transcript。
 *
 * 流式增量如果逐条落库，一次长回复会产生成百上千行；这里把连续的
 * message/thought 增量合并、把 tool 状态就地更新，行数约等于"对话块数"。
 * 返回 null 表示必须新起一条。
 */
function mergeAdjacentEvent(
	previous: AcpAdapterEvent,
	next: AcpAdapterEvent,
): AcpAdapterEvent | null {
	if (
		previous.type === "agent.message.delta" &&
		next.type === "agent.message.delta" &&
		previous.messageId === next.messageId
	) {
		return {
			type: "agent.message.delta",
			messageId: previous.messageId,
			text: previous.text + next.text,
		};
	}
	if (
		previous.type === "agent.thought.delta" &&
		next.type === "agent.thought.delta"
	) {
		return {
			type: "agent.thought.delta",
			text: previous.text + next.text,
		};
	}
	if (
		(previous.type === "tool.started" || previous.type === "tool.updated") &&
		next.type === "tool.updated" &&
		previous.toolCallId === next.toolCallId
	) {
		const title = next.title ?? previous.title;
		const status = next.status ?? previous.status;
		return {
			type: "tool.started",
			toolCallId: previous.toolCallId,
			title: title ?? "",
			...(status ? { status } : {}),
			...(next.content ? { content: next.content } : {}),
		};
	}
	if (
		previous.type === "usage.updated" &&
		next.type === "usage.updated"
	) {
		return next;
	}
	if (previous.type === "plan.updated" && next.type === "plan.updated") {
		return next;
	}
	return null;
}

/** 反序列化一条 transcript payload；损坏的行跳过而不是让整个回放失败。 */
function readPersistedEvent(payload: string): AcpAdapterEvent | null {
	try {
		return parseAcpAdapterEvent(JSON.parse(payload));
	} catch {
		return null;
	}
}

/** 读取落库的 prompt 正文；损坏或空文本返回 null。 */
function readPersistedPrompt(payload: string): string | null {
	try {
		const parsed = JSON.parse(payload) as { text?: unknown };
		return typeof parsed.text === "string" && parsed.text.length > 0
			? parsed.text
			: null;
	} catch {
		return null;
	}
}

@Injectable()
export class RemoteDevService {
	private deps: RemoteDevServiceDeps;
	private browserEmitter:
		| ((sessionId: string, event: RemoteDevClientEvent) => void)
		| null = null;
	private readonly pending = new Map<
		string,
		{
			socketId: string;
			resolve: (result: RemoteDevCommandResult) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(AgentRegistryService) agents: AgentRegistryService,
		@Inject(TerminalService) terminals: TerminalService,
		@Inject(RemoteDevAuditService) audit: RemoteDevAuditService,
	) {
		this.deps = { prisma, agents, terminals, audit };
	}

	static withDeps(deps: RemoteDevServiceDeps): RemoteDevService {
		const service = new RemoteDevService(
			null as unknown as PrismaService,
			null as unknown as AgentRegistryService,
			null as unknown as TerminalService,
			null as unknown as RemoteDevAuditService,
		);
		service.deps = deps;
		return service;
	}

	bindEmitter(
		fn: (socketId: string, command: RemoteDevClientCommand) => void,
	): void {
		this.deps.send = fn;
	}

	bindBrowserEmitter(
		fn: (sessionId: string, event: RemoteDevClientEvent) => void,
	): void {
		this.browserEmitter = fn;
	}

	private get now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	/** 创建 RDS：先校验在线 Client、placement、workspace，再等待 Client ack。 */
	async create(
		input: RemoteDevSessionCreateRequest,
		actor: ActorContext,
	): Promise<RemoteDevSessionInfo> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: input.clientId },
			select: { socketId: true, online: true, capabilities: true },
		});
		if (!client?.online || !client.socketId) {
			throw error("RDS_CLIENT_OFFLINE", "目标 Client 不在线", 409);
		}
		if (!parseJsonArray(client.capabilities).includes("remote-dev")) {
			throw error(
				"RDS_UNSUPPORTED_CLIENT",
				"目标 Client 未声明 remote-dev capability",
				409,
			);
		}
		let placement;
		try {
			placement = await this.deps.agents.resolveById(input.agentPlacementId);
		} catch {
			throw error("RDS_PLACEMENT_INVALID", "Agent placement 不存在或不可用", 409);
		}
		if (placement.clientId !== input.clientId) {
			throw error("RDS_PLACEMENT_INVALID", "Agent placement 不属于该 Client", 409);
		}
		if (placement.adapter !== "acp") {
			throw error("RDS_PLACEMENT_INVALID", "RDS 只支持 ACP placement", 409);
		}
		const workspaceRoot = input.workspaceRoot.trim();
		if (
			workspaceRoot.length === 0 ||
			hasParentTraversal(workspaceRoot) ||
			placement.workspaceRoots.length === 0
		) {
			throw error("RDS_WORKSPACE_INVALID", "workspace 不在允许范围内", 400);
		}
		if (isAbsolutePath(workspaceRoot) && !isUnderRoot(workspaceRoot, placement.workspaceRoots)) {
			throw error("RDS_WORKSPACE_INVALID", "workspace 不在允许范围内", 400);
		}

		// 续接：只能接同一 Client、同一 placement、同一 workspace 的已终态会话，
		// 且该会话必须已经上报过 ACP 会话标识。
		let resumeAcpSessionId: string | undefined;
		if (input.resumeFromSessionId) {
			const source = (await this.deps.prisma.remoteDevSession.findUnique({
				where: { id: input.resumeFromSessionId },
			})) as unknown as RemoteDevSessionRow | null;
			if (!source) {
				throw error("RDS_RESUME_UNAVAILABLE", "续接来源会话不存在", 409);
			}
			// 只有会话所有者可以接回它的 ACP 上下文，与 prompt/close/端口一致
			if (source.ownerIdentityId && source.ownerIdentityId !== actor.identityId) {
				throw error("RDS_OPERATOR_REQUIRED", "只有会话所有者可以续接", 403);
			}
			if (
				source.clientId !== input.clientId ||
				source.agentPlacementId !== input.agentPlacementId ||
				normalizePath(source.workspaceRoot) !== normalizePath(workspaceRoot)
			) {
				throw error(
					"RDS_RESUME_MISMATCH",
					"续接要求同 Client、同 placement、同 workspace",
					409,
				);
			}
			if (!TERMINAL_STATES.includes(source.state as RemoteDevState)) {
				throw error("RDS_RESUME_NOT_ALLOWED", "只能续接已结束的会话", 409);
			}
			if (!source.acpSessionId) {
				throw error(
					"RDS_RESUME_UNAVAILABLE",
					"该会话没有可续接的 ACP 上下文",
					409,
				);
			}
			resumeAcpSessionId = source.acpSessionId;
		}

		const id = sessionId();
		const row = (await this.deps.prisma.remoteDevSession.create({
			data: {
				id,
				ownerIdentityId: actor.identityId,
				clientId: input.clientId,
				agentPlacementId: input.agentPlacementId,
				workspaceRoot,
				...(input.label ? { label: input.label } : {}),
				...(resumeAcpSessionId ? { acpSessionId: resumeAcpSessionId } : {}),
				state: "starting",
				agentStatus: "starting",
			},
			include: { ports: true },
		})) as unknown as RemoteDevSessionRow;
		await this.audit(row.id, "created", actor, {
			agentPlacementId: input.agentPlacementId,
			clientId: input.clientId,
			...(resumeAcpSessionId
				? { resumedFrom: input.resumeFromSessionId as string }
				: {}),
		});

		const command: RemoteDevClientCommand = {
			action: "session.create",
			requestId: this.requestId(),
			sessionId: row.id,
			agentPlacementId: placement.id,
			workspaceRoot,
			workspaceRoots: placement.workspaceRoots,
			command: placement.command,
			args: placement.args,
			cwd: placement.cwd,
			...(resumeAcpSessionId ? { acpSessionId: resumeAcpSessionId } : {}),
		};
		try {
			const result = await this.request(client.socketId, command, this.deps.createTimeoutMs ?? 30_000);
			if (!result.ok || !result.generationId) {
				throw error(
					"RDS_COMMAND_FAILED",
					result.error?.message ?? "Client 创建 RDS 失败",
					502,
				);
			}
			const activeCount = await this.deps.prisma.remoteDevSession.updateMany({
				where: { id: row.id, state: "starting" },
				data: {
					state: "active",
					generationId: result.generationId,
					agentStatus: "ready",
				},
			});
			if (activeCount.count !== 1) {
				const current = await this.row(row.id);
				if (TERMINAL_STATES.includes(current.state as RemoteDevState)) {
					throw error(
						"RDS_INVALID_STATE",
						"Client 在创建确认前结束了会话",
						409,
					);
				}
			}
			const active = await this.row(row.id);
			await this.audit(row.id, "agent_started", actor, {
				agentPlacementId: placement.id,
			});
			return toRemoteDevSessionInfo(active);
		} catch (cause) {
			const code = (cause as { code?: string }).code ?? "RDS_COMMAND_FAILED";
			const message =
				(cause as { message?: string }).message ?? "Client 创建 RDS 失败";
			const current = await this.deps.prisma.remoteDevSession.findUnique({
				where: { id: row.id },
			});
			if (
				!current ||
				!TERMINAL_STATES.includes(
					(current as unknown as RemoteDevSessionRow).state as RemoteDevState,
				)
			) {
				await this.deps.prisma.remoteDevSession.update({
					where: { id: row.id },
					data: {
						state: "failed",
						cleanupStatus: "partial",
						closeReason: code,
					},
				});
				await this.audit(row.id, "failed", actor, { code });
			}
			throw error("RDS_COMMAND_FAILED", message, 502);
		}
	}

	async list(
		filter: { clientId?: string; state?: RemoteDevState },
		page: number,
		pageSize: number,
	): Promise<PaginatedResult<RemoteDevSessionInfo>> {
		const where = {
			...(filter.clientId ? { clientId: filter.clientId } : {}),
			...(filter.state ? { state: filter.state } : {}),
		};
		const [rows, total] = await Promise.all([
			this.deps.prisma.remoteDevSession.findMany({
				where,
				include: { ports: true },
				orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.deps.prisma.remoteDevSession.count({ where }),
		]);
		return {
			data: (rows as unknown as RemoteDevSessionRow[]).map(
				toRemoteDevSessionInfo,
			),
			total,
			page,
			pageSize,
			totalPages: Math.max(1, Math.ceil(total / pageSize)),
		};
	}

	async get(id: string): Promise<RemoteDevSessionInfo> {
		return toRemoteDevSessionInfo(await this.row(id));
	}

	/** 浏览器 operator 发 prompt；Server 只转发受控文本。 */
	async prompt(id: string, text: string, actor: ActorContext): Promise<string> {
		const session = await this.requireOwner(id, actor);
		if (session.state !== "active" && session.state !== "detached") {
			throw error("RDS_INVALID_STATE", "会话当前不能发 prompt", 409);
		}
		const socketId = await this.clientSocketId(session.clientId);
		if (!socketId) throw error("RDS_CLIENT_OFFLINE", "目标 Client 不在线", 409);
		// 先落库再做请求：一回回合的事件会持续写进 transcript，prompt 必须排在它们前面，
		// 否则回放时用户消息会跑到 agent 回复后面。请求失败则回滚这一条。
		const seq = await this.persistPrompt(id, text);
		const rollback = async (): Promise<void> => {
			await this.deps.prisma.remoteDevEvent
				.deleteMany({ where: { sessionId: id, seq } })
				.catch(() => undefined);
		};
		let result: RemoteDevCommandResult;
		try {
			result = await this.request(socketId, {
				action: "agent.prompt",
				requestId: this.requestId(),
				sessionId: id,
				text,
			}, 10 * 60_000);
		} catch (cause) {
			await rollback();
			throw cause;
		}
		if (!result.ok) {
			await rollback();
			throw error("RDS_COMMAND_FAILED", result.error?.message ?? "prompt 失败", 502);
		}
		return result.stopReason ?? "end_turn";
	}

	async cancel(id: string, actor: ActorContext): Promise<void> {
		const session = await this.requireOwner(id, actor);
		const socketId = await this.clientSocketId(session.clientId);
		if (!socketId) throw error("RDS_CLIENT_OFFLINE", "目标 Client 不在线", 409);
		await this.request(socketId, {
			action: "agent.cancel",
			requestId: this.requestId(),
			sessionId: id,
		}, 15_000).then((result) => {
			if (!result.ok) {
				throw error("RDS_COMMAND_FAILED", result.error?.message ?? "cancel 失败", 502);
			}
		});
	}

	async permission(
		id: string,
		requestId: string,
		optionId: string | undefined,
		actor: ActorContext,
	): Promise<void> {
		const session = await this.requireOwner(id, actor);
		const socketId = await this.clientSocketId(session.clientId);
		if (!socketId) throw error("RDS_CLIENT_OFFLINE", "目标 Client 不在线", 409);
		const result = await this.request(socketId, {
			action: "agent.permission",
			requestId: this.requestId(),
			sessionId: id,
			permissionRequestId: requestId,
			outcome: optionId
				? { outcome: "selected", optionId }
				: { outcome: "cancelled" },
		}, 15_000);
		if (!result.ok) {
			throw error("RDS_COMMAND_FAILED", result.error?.message ?? "permission 失败", 502);
		}
		await this.audit(id, "permission_resolved", actor, {
			requestId,
			optionId: optionId ?? null,
		});
	}

	/** Client 回报 RDS 事件：校验归属/generation，更新轻量状态并转发浏览器。 */
	async handleClientEvent(
		socketId: string,
		event: RemoteDevClientEvent,
	): Promise<void> {
		const row = await this.deps.prisma.remoteDevSession.findUnique({
			where: { id: event.sessionId },
		});
		if (!row) return;
		const session = row as unknown as RemoteDevSessionRow;
		const currentSocket = await this.clientSocketId(session.clientId);
		if (currentSocket !== socketId) return;
		if (session.generationId && session.generationId !== event.generationId) return;
		if (TERMINAL_STATES.includes(session.state as RemoteDevState)) return;
		if (event.type === "agent.event") {
			await this.deps.prisma.remoteDevSession.update({
				where: { id: event.sessionId },
				data: { lastSeq: Math.max(session.lastSeq, event.seq) },
			});
			// 落库失败不能影响实时转发：宁可丢一条回放记录，也不能让浏览器看不到当前输出。
			await this.persistAgentEvent(event.sessionId, event.event).catch(() => undefined);
		}
		if (event.type === "agent.status") {
			await this.deps.prisma.remoteDevSession.update({
				where: { id: event.sessionId },
				data: { agentStatus: event.status },
			});
		}
		if (event.type === "session.ended") {
			const state =
				event.reason === "closed"
					? "closed"
					: event.reason === "error"
						? "failed"
						: "interrupted";
			await this.deps.prisma.remoteDevSession.update({
				where: { id: event.sessionId },
				data: {
					state,
					agentStatus: event.reason === "error" ? "failed" : "exited",
					...(state === "closed" ? { closedAt: this.now } : {}),
				},
			});
			await this.auditSystem(
				event.sessionId,
				state === "closed" ? "closed" : "interrupted",
				{ reason: event.reason },
			);
		}
		this.browserEmitter?.(event.sessionId, event);
	}

	async ports(id: string): Promise<RemoteDevPortInfo[]> {
		await this.row(id);
		const rows = await this.deps.prisma.remoteDevPort.findMany({
			where: { sessionId: id },
			orderBy: { createdAt: "asc" },
		});
		return (rows as unknown as RemoteDevPortRow[]).map(toRemoteDevPortInfo);
	}

	/** 关闭 RDS：先关闭端口与子终端，再等待 Client 确认；失败如实标记 partial。 */
	async close(
		id: string,
		actor: ActorContext,
		reason = "owner",
	): Promise<RemoteDevSessionInfo> {
		const current = await this.row(id);
		if (current.state === "closed" || current.state === "closing") {
			return toRemoteDevSessionInfo(current);
		}
		if (current.ownerIdentityId && current.ownerIdentityId !== actor.identityId) {
			throw error("RDS_OPERATOR_REQUIRED", "只有会话所有者可以关闭", 403);
		}
		const closing = (await this.deps.prisma.remoteDevSession.update({
			where: { id },
			data: { state: "closing", closeReason: reason },
			include: { ports: true },
		})) as unknown as RemoteDevSessionRow;
		await this.audit(id, "closing", actor, { reason });
		await this.closeOpenPorts(id);
		const terminalCleanup = await this.deps.terminals
			.closeByParent(id, actor)
			.catch(() => ({ attempted: 1, closed: 0, failed: 1 }));

		if (!closing.generationId) {
			await this.deps.prisma.remoteDevSession.update({
				where: { id },
				data: {
					state: "failed",
					cleanupStatus: "partial",
					closedAt: this.now,
				},
			});
			return this.get(id);
		}
		const socketId = await this.clientSocketId(closing.clientId);
		if (!socketId) {
			await this.deps.prisma.remoteDevSession.update({
				where: { id },
				data: { state: "failed", cleanupStatus: "partial" },
			});
			return this.get(id);
		}
		try {
			const result = await this.request(
				socketId,
				{
					action: "session.close",
					requestId: this.requestId(),
					sessionId: id,
					reason,
				},
				this.deps.closeTimeoutMs ?? 5_000,
			);
			if (!result.ok) throw new Error(result.error?.message ?? "close failed");
			const closed = (await this.deps.prisma.remoteDevSession.update({
				where: { id },
				data: {
					state: "closed",
					closedAt: this.now,
					cleanupStatus:
						terminalCleanup.failed === 0 ? "complete" : "partial",
				},
				include: { ports: true },
			})) as unknown as RemoteDevSessionRow;
			await this.audit(id, "closed", actor, {
				reason,
				terminalCleanup,
			});
			return toRemoteDevSessionInfo(closed);
		} catch {
			await this.deps.prisma.remoteDevSession.update({
				where: { id },
				data: { state: "failed", cleanupStatus: "partial" },
			});
			await this.audit(id, "failed", actor, { code: "RDS_CLEANUP_PARTIAL" });
			return this.get(id);
		}
	}

	async openPort(
		id: string,
		input: RemoteDevPortCreateRequest,
		actor: ActorContext,
	): Promise<RemoteDevPortInfo> {
		const session = await this.row(id);
		if (session.ownerIdentityId && session.ownerIdentityId !== actor.identityId) {
			throw error("RDS_OPERATOR_REQUIRED", "只有会话所有者可以打开端口", 403);
		}
		if (session.state !== "active" && session.state !== "detached") {
			throw error("RDS_INVALID_STATE", "会话当前不能打开端口", 409);
		}
		const count = await this.deps.prisma.remoteDevPort.count({
			where: { sessionId: id, status: { not: "closed" } },
		});
		if (count >= RDS_LIMITS.maxPortsPerSession) {
			throw error("RDS_LIMIT_EXCEEDED", "端口数量达到上限", 409);
		}
		const existing = await this.deps.prisma.remoteDevPort.findUnique({
			where: {
				sessionId_remotePort: { sessionId: id, remotePort: input.remotePort },
			},
		});
		if (existing && existing.status !== "closed") {
			throw error("RDS_PORT_INVALID", "端口已打开", 409);
		}
		const row = existing
			? ((await this.deps.prisma.remoteDevPort.update({
					where: { id: existing.id },
					data: {
						status: "open",
						closedAt: null,
						lastErrorCode: null,
						label: input.label ?? null,
					},
				})) as unknown as RemoteDevPortRow)
			: ((await this.deps.prisma.remoteDevPort.create({
					data: {
						id: portId(),
						sessionId: id,
						remotePort: input.remotePort,
						protocol: "tcp",
						...(input.label ? { label: input.label } : {}),
						status: "open",
					},
				})) as unknown as RemoteDevPortRow);
		await this.audit(id, "port_opened", actor, {
			portId: row.id,
			remotePort: row.remotePort,
		});
		return toRemoteDevPortInfo(row);
	}

	async closePort(
		id: string,
		targetPortId: string,
		actor: ActorContext,
	): Promise<RemoteDevPortInfo> {
		const session = await this.row(id);
		if (session.ownerIdentityId && session.ownerIdentityId !== actor.identityId) {
			throw error("RDS_OPERATOR_REQUIRED", "只有会话所有者可以关闭端口", 403);
		}
		const row = await this.deps.prisma.remoteDevPort.findUnique({
			where: { id: targetPortId },
		});
		if (!row || row.sessionId !== id) {
			throw error("RDS_NOT_FOUND", "端口不存在", 404);
		}
		if (row.status === "closed") {
			return toRemoteDevPortInfo(row as unknown as RemoteDevPortRow);
		}
		const closed = (await this.deps.prisma.remoteDevPort.update({
			where: { id: targetPortId },
			data: { status: "closed", closedAt: this.now },
		})) as unknown as RemoteDevPortRow;
		await this.audit(id, "port_closed", actor, { portId: targetPortId });
		return toRemoteDevPortInfo(closed);
	}

	async handleCommandResult(
		socketId: string,
		result: RemoteDevCommandResult,
	): Promise<void> {
		const pending = this.pending.get(result.requestId);
		if (!pending || pending.socketId !== socketId) return;
		clearTimeout(pending.timer);
		this.pending.delete(result.requestId);
		pending.resolve(result);
	}

	/**
	 * Client 上报 ACP 侧会话标识。
	 *
	 * 独立事件而不是给 `rds:command-result` 加字段：旧 Server 对结果做严格解析，
	 * 多一个字段会让整条结果被丢弃，创建会话会退化成超时。
	 */
	async handleAcpSessionReport(
		socketId: string,
		report: RemoteDevAcpSessionReport,
	): Promise<void> {
		const session = (await this.deps.prisma.remoteDevSession.findUnique({
			where: { id: report.sessionId },
		})) as unknown as RemoteDevSessionRow | null;
		if (!session) return;
		// Client 先发 rds:acp-session、后发 rds:command-result，因此上报到达时行上的
		// generationId 往往还是空串（"未知"）。此时按 socket 归属接受，与
		// handleClientEvent 的宽容判定保持一致；只有已知且不匹配的 generation 才丢弃。
		if (session.generationId && session.generationId !== report.generationId) return;
		const owner = await this.deps.prisma.client.findUnique({
			where: { id: session.clientId },
			select: { socketId: true },
		});
		if ((owner as { socketId?: string | null } | null)?.socketId !== socketId) {
			return;
		}
		await this.deps.prisma.remoteDevSession.updateMany({
			where: session.generationId
				? { id: report.sessionId, generationId: report.generationId }
				: { id: report.sessionId },
			data: { acpSessionId: report.acpSessionId },
		});
	}

	/**
	 * 读取会话 transcript（供附着后回放）。
	 *
	 * 损坏的行直接跳过：回放失败不该让会话打不开。
	 */
	async transcript(id: string): Promise<RemoteDevTranscriptPayload> {
		const rows = await this.deps.prisma.remoteDevEvent.findMany({
			where: { sessionId: id },
			orderBy: { seq: "asc" },
		});
		const entries: RemoteDevTranscriptEntry[] = [];
		for (const row of rows) {
			const at = row.createdAt.toISOString();
			if (row.kind === "prompt") {
				const text = readPersistedPrompt(row.payload);
				if (text !== null) entries.push({ seq: row.seq, at, kind: "prompt", text });
				continue;
			}
			const event = readPersistedEvent(row.payload);
			if (event) entries.push({ seq: row.seq, at, kind: "event", event });
		}
		const first = rows[0];
		return {
			sessionId: id,
			entries,
			truncated: first !== undefined && first.seq > 1,
		};
	}

	/**
	 * Client 离线时的会话收敛。
	 *
	 * agent 进程活在 Client 上：socket 断开后会话不可能继续产出事件，必须停止
	 * 对外声称 `active`。这里只降级为 `disconnected`，真正的"是否已死"由 Client
	 * 重新注册时上报的存活列表判定（见 `reconcileClientSessions`）。
	 */
	async handleClientOffline(clientId: string): Promise<void> {
		await this.deps.prisma.remoteDevSession.updateMany({
			where: { clientId, state: { notIn: [...TERMINAL_STATES] } },
			data: { state: "disconnected" },
		});
	}

	/**
	 * Client 重新注册时的会话对账（ADR-0058 修订 2026-10-19）。
	 *
	 * `reported` 缺省 = 旧 Client 没有上报能力，此时不做任何判定（不能凭"没上报"
	 * 把别人的会话判死）。空数组 = 明确没有存活会话，该机器所有非终态会话收敛为
	 * `interrupted`，从而在历史页可选「继续」。
	 */
	async reconcileClientSessions(
		clientId: string,
		reported: { sessionId: string; generationId: string }[] | undefined,
	): Promise<void> {
		if (reported === undefined) return;
		const alive = new Map(reported.map((item) => [item.sessionId, item.generationId]));
		const rows = (await this.deps.prisma.remoteDevSession.findMany({
			where: { clientId, state: { notIn: [...TERMINAL_STATES] } },
		})) as unknown as RemoteDevSessionRow[];
		for (const row of rows) {
			const generationId = alive.get(row.id);
			if (generationId !== undefined && generationId === row.generationId) {
				// 存活：socket 抖动后恢复，不改动其它字段。
				if (row.state !== "active") {
					await this.deps.prisma.remoteDevSession.update({
						where: { id: row.id },
						data: { state: "active" },
					});
				}
				continue;
			}
			await this.deps.prisma.remoteDevSession.update({
				where: { id: row.id },
				data: {
					state: "interrupted",
					agentStatus: "exited",
					closeReason: "client-restarted",
					closedAt: row.closedAt ?? this.now,
				},
			});
			await this.auditSystem(row.id, "interrupted", {
				reason: "client-restarted",
			});
		}
	}

	/** 落库一条操作者 prompt；返回它的 seq 供失败时回滚。 */
	private async persistPrompt(id: string, text: string): Promise<number> {
		const last = await this.deps.prisma.remoteDevEvent.findFirst({
			where: { sessionId: id },
			orderBy: { seq: "desc" },
			select: { seq: true },
		});
		const seq = (last?.seq ?? 0) + 1;
		await this.deps.prisma.remoteDevEvent.create({
			data: { sessionId: id, seq, kind: "prompt", payload: JSON.stringify({ text }) },
		});
		await this.trimTranscript(id, seq);
		return seq;
	}

	/** 落库一条 agent 事件；可合并的增量就地更新，避免行数爆炸。 */
	private async persistAgentEvent(
		id: string,
		event: AcpAdapterEvent,
	): Promise<void> {
		const last = await this.deps.prisma.remoteDevEvent.findFirst({
			where: { sessionId: id },
			orderBy: { seq: "desc" },
		});
		if (last?.kind === "event") {
			const previous = readPersistedEvent(last.payload);
			const merged = previous ? mergeAdjacentEvent(previous, event) : null;
			if (merged) {
				await this.deps.prisma.remoteDevEvent.update({
					where: { id: last.id },
					data: { payload: JSON.stringify(merged) },
				});
				return;
			}
		}
		const seq = (last?.seq ?? 0) + 1;
		await this.deps.prisma.remoteDevEvent.create({
			data: {
				sessionId: id,
				seq,
				kind: "event",
				payload: JSON.stringify(event),
			},
		});
		await this.trimTranscript(id, seq);
	}

	/** 按 seq 一次性截断超出保留上限的旧记录。 */
	private async trimTranscript(id: string, seq: number): Promise<void> {
		const cutoff = seq - RDS_TRANSCRIPT_MAX_ENTRIES;
		if (cutoff <= 0) return;
		await this.deps.prisma.remoteDevEvent.deleteMany({
			where: { sessionId: id, seq: { lte: cutoff } },
		});
	}

	private async row(id: string): Promise<RemoteDevSessionRow> {
		const row = await this.deps.prisma.remoteDevSession.findUnique({
			where: { id },
			include: { ports: true },
		});
		if (!row) throw error("RDS_NOT_FOUND", "RDS 会话不存在", 404);
		return row as unknown as RemoteDevSessionRow;
	}

	private async requireOwner(
		id: string,
		actor: ActorContext,
	): Promise<RemoteDevSessionRow> {
		const row = await this.row(id);
		if (row.ownerIdentityId && row.ownerIdentityId !== actor.identityId) {
			throw error("RDS_OPERATOR_REQUIRED", "只有会话所有者可以操作", 403);
		}
		return row;
	}

	private async clientSocketId(clientId: string): Promise<string | null> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
			select: { socketId: true, online: true },
		});
		return client?.online ? (client.socketId ?? null) : null;
	}

	private async closeOpenPorts(id: string): Promise<void> {
		await this.deps.prisma.remoteDevPort.updateMany({
			where: { sessionId: id, status: { not: "closed" } },
			data: { status: "closed", closedAt: this.now },
		});
	}

	private async audit(
		sessionIdValue: string,
		event: string,
		actor: ActorContext,
		data?: unknown,
	): Promise<void> {
		await this.deps.audit
			.record({
				sessionId: sessionIdValue,
				event,
				actorIdentityId: actor.identityId,
				...(data !== undefined ? { data } : {}),
			})
			.catch(() => undefined);
	}

	private async auditSystem(
		sessionIdValue: string,
		event: string,
		data?: unknown,
	): Promise<void> {
		await this.deps.audit
			.record({
				sessionId: sessionIdValue,
				event,
				...(data !== undefined ? { data } : {}),
			})
			.catch(() => undefined);
	}

	private requestId(): string {
		return `rds_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
	}

	private request(
		socketId: string,
		command: RemoteDevClientCommand,
		timeoutMs: number,
	): Promise<RemoteDevCommandResult> {
		const send = this.deps.send;
		if (!send) {
			return Promise.reject(
				error("RDS_CLIENT_OFFLINE", "Client RDS 通道未连接", 409),
			);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(command.requestId);
				reject(error("RDS_COMMAND_FAILED", "Client RDS 命令超时", 504));
			}, timeoutMs);
			this.pending.set(command.requestId, {
				socketId,
				resolve,
				reject,
				timer,
			});
			try {
				send(socketId, command);
			} catch (cause) {
				clearTimeout(timer);
				this.pending.delete(command.requestId);
				reject(cause);
			}
		});
	}
}

function isAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/");
}
