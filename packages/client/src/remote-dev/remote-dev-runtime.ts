import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type {
	AcpAdapterEvent,
	AcpPermissionOutcome,
	AcpPermissionRequest,
	RemoteDevAgentState,
	RemoteDevClientCommand,
	RemoteDevClientEvent,
} from "@vcpdeck/shared";
import { createAcpHost, type AcpHost, type AcpHostOptions } from "../acp/acp-host.js";
export type RemoteDevRuntimeErrorCode =
	| "RDS_WORKSPACE_INVALID"
	| "RDS_AGENT_UNAVAILABLE"
	| "RDS_RESUME_FAILED"
	| "RDS_SESSION_NOT_FOUND"
	| "RDS_SESSION_EXISTS"
	| "RDS_NOT_READY";

export class RemoteDevRuntimeError extends Error {
	constructor(
		readonly code: RemoteDevRuntimeErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RemoteDevRuntimeError";
	}
}

export interface RemoteDevRuntimeDeps {
	createHost: (options: AcpHostOptions) => AcpHost;
	emit: (event: RemoteDevClientEvent) => void;
	canonicalize?: (workspaceRoot: string, roots: string[]) => Promise<string>;
}

export interface RemoteDevRuntime {
	create(
		command: Extract<RemoteDevClientCommand, { action: "session.create" }>,
	): Promise<{ sessionId: string; generationId: string; acpSessionId: string }>;
	prompt(sessionId: string, text: string): Promise<{ stopReason: string }>;
	cancel(sessionId: string): Promise<void>;
	permission(
		sessionId: string,
		requestId: string,
		outcome: AcpPermissionOutcome,
	): void;
	close(sessionId: string, reason?: string): Promise<void>;
	/**
	 * 仍在运行的会话（sessionId + generationId）。
	 *
	 * 注册到 Server 时上报，作为"谁还活着"的权威来源：Server 用它把 Client
	 * 重启遗留的会话收敛为 `interrupted`，否则历史页会一直显示"运行中"。
	 */
	listSessions(): { sessionId: string; generationId: string }[];
}

interface PendingPermission {
	resolve: (outcome: AcpPermissionOutcome) => void;
	request: AcpPermissionRequest;
}

interface RuntimeSession {
	sessionId: string;
	generationId: string;
	host: AcpHost;
	agentStatus: RemoteDevAgentState;
	seq: number;
	closed: boolean;
	pending: Map<string, PendingPermission>;
}

function runtimeError(
	code: RemoteDevRuntimeErrorCode,
	message: string,
): RemoteDevRuntimeError {
	return new RemoteDevRuntimeError(code, message);
}

/** 校验 workspace 的 realpath 必须落在 placement roots 内。 */
async function canonicalizeWorkspace(
	workspaceRoot: string,
	roots: string[],
): Promise<string> {
	const target = await realpath(resolvePath(workspaceRoot));
	const canonicalRoots: string[] = [];
	for (const root of roots) {
		try {
			canonicalRoots.push(await realpath(resolvePath(root)));
		} catch {
			// 不存在的 root 不参与允许范围，避免把错误配置变成放行。
		}
	}
	const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
	const allowed = canonicalRoots.some((root) => {
		const prefix = root.replace(/\\/g, "/").replace(/\/+$/, "");
		return normalized === prefix || normalized.startsWith(`${prefix}/`);
	});
	if (!allowed) {
		throw runtimeError("RDS_WORKSPACE_INVALID", "workspace 越出 placement roots");
	}
	return target;
}

/** Client 侧 RDS 运行时：一个 RDS 对应一个 ACP Host 与一条权限等待链。 */
export function createRemoteDevRuntime(
	deps: RemoteDevRuntimeDeps,
): RemoteDevRuntime {
	const sessions = new Map<string, RuntimeSession>();
	const canonicalize = deps.canonicalize ?? canonicalizeWorkspace;

	const emitStatus = (session: RuntimeSession, status: RemoteDevAgentState) => {
		session.agentStatus = status;
		deps.emit({
			type: "agent.status",
			sessionId: session.sessionId,
			generationId: session.generationId,
			status,
		});
	};

	const emitAgentEvent = (session: RuntimeSession, event: AcpAdapterEvent) => {
		session.seq += 1;
		deps.emit({
			type: "agent.event",
			sessionId: session.sessionId,
			generationId: session.generationId,
			seq: session.seq,
			event,
		});
	};

	const waitPermission = (
		session: RuntimeSession,
		request: AcpPermissionRequest,
	): Promise<AcpPermissionOutcome> => {
		return new Promise((resolve) => {
			session.pending.set(request.requestId, { resolve, request });
			emitAgentEvent(session, {
				type: "permission.requested",
				requestId: request.requestId,
				toolCallId: request.toolCallId,
				...(request.title ? { title: request.title } : {}),
				options: request.options,
			});
			emitStatus(session, "idle");
		});
	};

	return {
		async create(command) {
			if (sessions.has(command.sessionId)) {
				throw runtimeError("RDS_SESSION_EXISTS", "RDS session already exists");
			}
			let workspace: string;
			try {
				workspace = await canonicalize(
					command.workspaceRoot,
					command.workspaceRoots,
				);
			} catch (cause) {
				throw runtimeError(
					"RDS_WORKSPACE_INVALID",
					cause instanceof Error ? cause.message : "workspace 无效",
				);
			}
			const generationId = randomUUID();
			let session: RuntimeSession | null = null;
			const host = deps.createHost({
				command: command.command,
				args: command.args,
				cwd: workspace,
				...(command.acpSessionId
					? { resumeSessionId: command.acpSessionId }
					: {}),
				onEvent: (event) => {
					if (session) emitAgentEvent(session, event);
				},
				onPermission: (request) => {
					if (!session) return Promise.resolve({ outcome: "cancelled" });
					return waitPermission(session, request);
				},
				onExit: () => {
					if (!session || session.closed) return;
					emitStatus(session, "exited");
					deps.emit({
						type: "session.ended",
						sessionId: session.sessionId,
						generationId: session.generationId,
						reason: "exited",
					});
				},
			});
			session = {
				sessionId: command.sessionId,
				generationId,
				host,
				agentStatus: "starting",
				seq: 0,
				closed: false,
				pending: new Map(),
			};
			sessions.set(command.sessionId, session);
			try {
				const started = await host.start();
				emitStatus(session, "ready");
				return {
					sessionId: command.sessionId,
					generationId,
					acpSessionId: started.sessionId,
				};
			} catch (cause) {
				session.closed = true;
				sessions.delete(command.sessionId);
				await host.close().catch(() => undefined);
				if (command.acpSessionId) {
					throw runtimeError(
						"RDS_RESUME_FAILED",
						cause instanceof Error ? cause.message : "ACP 会话续接失败",
					);
				}
				throw runtimeError(
					"RDS_AGENT_UNAVAILABLE",
					cause instanceof Error ? cause.message : "ACP agent 启动失败",
				);
			}
		},

		async prompt(sessionId, text) {
			const session = sessions.get(sessionId);
			if (!session) {
				throw runtimeError("RDS_SESSION_NOT_FOUND", "RDS session not found");
			}
			if (session.closed) {
				throw runtimeError("RDS_NOT_READY", "RDS session is closed");
			}
			if (session.agentStatus === "busy") {
				throw runtimeError("RDS_NOT_READY", "ACP agent is busy");
			}
			emitStatus(session, "busy");
			try {
				const result = await session.host.prompt(text);
				emitStatus(session, "idle");
				return result;
			} catch (cause) {
				emitStatus(session, "failed");
				throw cause;
			}
		},

		async cancel(sessionId) {
			const session = sessions.get(sessionId);
			if (!session || session.closed) return;
			await session.host.cancel();
		},

		permission(sessionId, requestId, outcome) {
			const session = sessions.get(sessionId);
			if (!session) return;
			const pending = session.pending.get(requestId);
			if (!pending) return;
			session.pending.delete(requestId);
			pending.resolve(outcome);
			emitAgentEvent(session, {
				type: "permission.resolved",
				requestId,
				outcome: outcome.outcome,
				...(outcome.outcome === "selected"
					? { optionId: outcome.optionId }
					: {}),
			});
		},

		async close(sessionId, _reason) {
			const session = sessions.get(sessionId);
			if (!session || session.closed) return;
			session.closed = true;
			for (const pending of session.pending.values()) {
				pending.resolve({ outcome: "cancelled" });
			}
			session.pending.clear();
			await session.host.close().catch(() => undefined);
			emitStatus(session, "exited");
			deps.emit({
				type: "session.ended",
				sessionId: session.sessionId,
				generationId: session.generationId,
				reason: "closed",
			});
			sessions.delete(sessionId);
		},

		listSessions() {
			const alive: { sessionId: string; generationId: string }[] = [];
			for (const session of sessions.values()) {
				if (session.closed) continue;
				alive.push({
					sessionId: session.sessionId,
					generationId: session.generationId,
				});
			}
			return alive;
		},
	};
}
