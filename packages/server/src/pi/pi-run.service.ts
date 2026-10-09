/**
 * Agent Run 状态机(ADR-0041)。
 *
 * 职责边界:
 * - 每轮 Prompt/扩展命令一个 AgentRun;活动状态使用条件更新 CAS;
 * - 会话 activeRunId 作为原子指针,结算后清空并释放精确项目锁;
 * - 连接 generation、项目锁、settlement timer 与重连对账;
 * - 不写 Job,不保存 Prompt/正文/路径;失败只记稳定错误码。
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	isPiToolExecutionMode,
	type ActorContext,
	type PiAgentState,
	type PiErrorCode,
	type PiStateAck,
	type PiStateReport,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { isPiAgentIdle } from "@vcpdeck/shared";
import { PiRuntimeService } from "./pi-runtime.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

interface ProjectLock {
	clientId: string;
	projectKey: string;
	sessionId: string;
	runId: string;
}

interface ClientGeneration {
	socketId: string;
	ready: boolean;
}

interface RunRow {
	id: string;
	sessionId: string;
	clientId: string;
	status: string;
	kind: string;
	executionMode?: string | null;
	createdByIdentityId?: string | null;
	createdByName?: string | null;
	createdVia?: string | null;
	createdAt: Date;
	acceptedAt?: Date | null;
	startedAt?: Date | null;
	finishedAt?: Date | null;
	errorCode?: string | null;
}

interface SessionRow {
	id: string;
	clientId: string;
	status: string;
	ownerIdentityId?: string | null;
	activeRunId?: string | null;
	toolExecutionModeOverride?: string | null;
	executionModeNeedsConfirmation?: boolean;
	deleteToken?: string | null;
}

const SETTLEMENT_GRACE_MS = 30_000;
const PENDING = "pending";
const RUNNING = "running";
const WAITING_INPUT = "waiting_input";
const DISCONNECTED = "disconnected";
const ACTIVE_RUN_STATUSES = [PENDING, RUNNING, WAITING_INPUT, DISCONNECTED] as const;
const TERMINAL_STATUSES = ["succeeded", "failed", "aborted"] as const;

type RunStatus = (typeof ACTIVE_RUN_STATUSES)[number] | (typeof TERMINAL_STATUSES)[number];

function piError(code: PiErrorCode, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function parseStoredExecutionMode(raw: unknown): PiToolExecutionMode | null {
	if (raw === null || raw === undefined) return null;
	if (!isPiToolExecutionMode(raw)) {
		throw piError("PI_CONFIG_UNAVAILABLE", "Session execution mode is invalid");
	}
	return raw;
}

/** 稳定错误码 → 安全英文消息(不泄露外部原始错误)。 */
export function safePiErrorMessage(code: string): string {
	const messages: Record<PiErrorCode, string> = {
		PI_PROTOCOL_INVALID: "Pi protocol input was invalid",
		PI_CLIENT_UNSUPPORTED: "Pi client is unsupported",
		PI_NODE_UNSUPPORTED: "Node.js version is unsupported",
		PI_BASH_NOT_FOUND: "Bash was not found on the client",
		PI_RUNTIME_UNAVAILABLE: "Pi runtime is unavailable",
		PI_AUTH_UNAVAILABLE: "Pi authentication is unavailable",
		PI_MODEL_NOT_FOUND: "Pi model was not found",
		PI_PROJECT_NOT_ALLOWED: "Pi project is not allowed",
		PI_SESSION_NOT_FOUND: "Pi session was not found",
		PI_PROJECT_BUSY: "Pi project has an active run",
		PI_CONTROL_FORBIDDEN: "Pi session control is forbidden",
		PI_CLIENT_DISCONNECTED: "Pi client disconnected",
		PI_WORKER_EXITED: "Pi worker exited unexpectedly",
		PI_CLIENT_RESTARTED: "Client restarted before the Pi run could be recovered",
		PI_IMAGE_INVALID: "Pi image is invalid",
		PI_IMAGE_TOO_LARGE: "Pi image is too large",
		PI_REQUEST_TIMEOUT: "Pi request timed out",
		PI_STATE_PENDING: "Pi client state reconciliation is pending",
		PI_CONFIG_UNAVAILABLE: "Pi configuration is unavailable",
		PI_CREDENTIAL_UNAVAILABLE: "Pi credentials are unavailable",
		PI_RUNTIME_SPEC_INCOMPATIBLE: "Pi runtime spec is incompatible",
		PI_PROVIDER_VALIDATION_FAILED: "Pi provider validation failed",
		PI_BUNDLE_UNAVAILABLE: "Pi resource bundle is unavailable",
		PI_POLICY_UNAVAILABLE: "Pi tool policy is unavailable",
		PI_TOOL_POLICY_DENIED: "Tool call was denied by policy",
		PI_TOOL_POLICY_REJECTED: "Tool call was not approved",
		PI_EXECUTION_CONFIRMATION_REQUIRED: "Pi execution mode needs explicit confirmation",
		PI_EXTENSION_COMMAND_NOT_FOUND: "Pi extension command was not found",
		PI_EXTENSION_UNSUPPORTED: "Pi extension operation is unsupported",
		PI_EXTENSION_UI_LIMIT_EXCEEDED: "Pi extension UI state exceeded limits",
	};
	return messages[code as PiErrorCode] ?? "Pi session failed";
}

/** Agent Run 的原子状态机、项目锁与连接代次租约。 */
@Injectable()
export class PiRunService {
	private readonly locks = new Map<string, ProjectLock>();
	private readonly settlementTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly generations = new Map<string, ClientGeneration>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly executionModeQueues = new Map<string, Promise<void>>();
	private readonly profileForClient: (clientId: string) => Promise<PiToolExecutionMode>;
	private readonly runtimeReady: (clientId: string) => void;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Optional() @Inject(PiRuntimeService) runtimeSource?: PiRuntimeService,
	) {
		this.profileForClient = async (clientId) => {
			if (!runtimeSource) throw piError("PI_CONFIG_UNAVAILABLE", "Pi execution mode is unavailable");
			return runtimeSource.effectiveExecutionMode(clientId);
		};
		this.runtimeReady = (clientId) => {
			if (!runtimeSource) throw piError("PI_CONFIG_UNAVAILABLE", "Pi execution mode is unavailable");
			runtimeSource.assertReady(clientId);
		};
	}

	private runs() {
		return (this.prisma as unknown as { agentRun: RunQueries }).agentRun;
	}

	private sessions() {
		return (this.prisma as unknown as { agentSession: SessionQueries }).agentSession;
	}

	private lockKey(clientId: string, projectKey: string): string {
		return `${clientId}:${projectKey}`;
	}

	private settlementKey(sessionId: string, runId: string): string {
		return `${sessionId}:${runId}`;
	}

	private async serialized<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(clientId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => current);
		this.queues.set(clientId, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.queues.get(clientId) === tail) this.queues.delete(clientId);
		}
	}

	private requireGeneration(clientId: string, socketId?: string): ClientGeneration {
		const generation = this.generations.get(clientId);
		if (!generation?.ready || (socketId !== undefined && generation.socketId !== socketId)) {
			throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
		}
		return generation;
	}

	private async withExecutionModeQueue<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.executionModeQueues.get(clientId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => current);
		this.executionModeQueues.set(clientId, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.executionModeQueues.get(clientId) === tail) this.executionModeQueues.delete(clientId);
		}
	}

	private async findSession(sessionId: string): Promise<SessionRow> {
		const row = await this.sessions().findUnique({ where: { id: sessionId } }) as SessionRow | null;
		if (!row) throw piError("PI_SESSION_NOT_FOUND", "Pi session was not found");
		return row;
	}

	private setLock(clientId: string, projectKey: string, sessionId: string, runId: string): void {
		this.locks.set(this.lockKey(clientId, projectKey), { clientId, projectKey, sessionId, runId });
	}

	private releaseLock(sessionId: string, runId: string): void {
		for (const [key, lock] of this.locks) {
			if (lock.sessionId === sessionId && lock.runId === runId) this.locks.delete(key);
		}
	}

	/** 仅供精确 run 测试与短期编排判断。 */
	hasLock(sessionId: string, runId: string): boolean {
		return [...this.locks.values()].some((lock) => lock.sessionId === sessionId && lock.runId === runId);
	}

	async assertIdleMutation(clientId: string, projectKey: string): Promise<void> {
		if (this.locks.has(this.lockKey(clientId, projectKey))) {
			throw piError("PI_PROJECT_BUSY", "Project has an active turn");
		}
	}

	/**
	 * 接纳一轮新执行:同一事务创建 AgentRun 并抢占会话 activeRunId。
	 * 归档会话在新 Prompt 时恢复为 available(调用方补 restored 审计)。
	 */
	async startRun(
		actor: ActorContext,
		input: { clientId: string; sessionId: string; projectKey: string; kind: "prompt" | "command" },
	): Promise<{ sessionId: string; runId: string; executionMode: PiToolExecutionMode; restoredFromArchive: boolean }> {
		return this.withExecutionModeQueue(input.clientId, async () => {
			this.runtimeReady(input.clientId);
			const profileMode = await this.profileForClient(input.clientId);
			const session = await this.findSession(input.sessionId);
			if (session.clientId !== input.clientId || session.ownerIdentityId !== actor.identityId) {
				throw piError("PI_CONTROL_FORBIDDEN", "Only the session owner can start a run");
			}
			if (session.status === "deleted") throw piError("PI_PROJECT_BUSY", "Session is deleted");
			if (session.deleteToken) throw piError("PI_PROJECT_BUSY", "Session has a pending deletion");
			if (session.executionModeNeedsConfirmation === true) {
				throw piError("PI_EXECUTION_CONFIRMATION_REQUIRED", "Execution mode migration is not confirmed");
			}
			const override = parseStoredExecutionMode(session.toolExecutionModeOverride);
			const mode = override ?? profileMode;
			const key = this.lockKey(input.clientId, input.projectKey);
			if (this.locks.has(key)) throw piError("PI_PROJECT_BUSY", "Project has an active run");
			const runId = randomUUID();
			const restoredFromArchive = session.status === "archived";
			this.setLock(input.clientId, input.projectKey, input.sessionId, runId);
			try {
				await this.prisma.$transaction(async (client) => {
					const scoped = client as unknown as { agentRun: RunQueries; agentSession: SessionQueries };
					await scoped.agentRun.create({
						data: {
							id: runId,
							sessionId: input.sessionId,
							clientId: input.clientId,
							status: PENDING,
							kind: input.kind,
							executionMode: mode,
							createdByIdentityId: actor.identityId ?? null,
							createdByName: actor.displayName ?? null,
							createdVia: actor.source ?? null,
						},
					});
					const updated = await scoped.agentSession.updateMany({
						where: {
							id: input.sessionId,
							clientId: input.clientId,
							activeRunId: null,
							deleteToken: null,
							status: { in: ["available", "archived"] },
						},
						data: {
							activeRunId: runId,
							lastActivityAt: new Date(),
							...(restoredFromArchive ? { status: "available", archivedAt: null } : {}),
						},
					});
					if (updated.count !== 1) throw piError("PI_PROJECT_BUSY", "Session has an active run");
				});
			} catch (error) {
				this.releaseLock(input.sessionId, runId);
				throw error;
			}
			return { sessionId: input.sessionId, runId, executionMode: mode, restoredFromArchive };
		});
	}

	async accept(sessionId: string, runId: string): Promise<boolean> {
		return this.runTransition(sessionId, runId, [PENDING], {
			status: RUNNING,
			acceptedAt: new Date(),
			startedAt: new Date(),
		});
	}

	async waitForInput(sessionId: string, runId: string): Promise<boolean> {
		return this.runTransition(sessionId, runId, [PENDING, RUNNING], { status: WAITING_INPUT });
	}

	async resume(sessionId: string, runId: string): Promise<boolean> {
		return this.runTransition(sessionId, runId, [WAITING_INPUT], { status: RUNNING });
	}

	/** 精确断线标记:matching run 才进入 disconnected,断线不是失败。 */
	async markRunDisconnected(sessionId: string, runId: string): Promise<boolean> {
		return this.runTransition(sessionId, runId, [PENDING, RUNNING, WAITING_INPUT], { status: DISCONNECTED });
	}

	/**
	 * 权威结算一轮:先 CAS Run 终态,再清会话指针并释放精确锁。
	 * 非 failed 不允许 errorCode;failed 未给码时按 Worker 异常处理。
	 */
	async settleRun(
		sessionId: string,
		runId: string,
		outcome: { status: "succeeded" | "failed" | "aborted"; errorCode?: PiErrorCode },
	): Promise<boolean> {
		const terminal = TERMINAL_STATUSES.includes(outcome.status);
		if (!terminal) throw piError("PI_PROTOCOL_INVALID", "Run can only settle to a terminal status");
		const errorCode = outcome.status === "failed" ? (outcome.errorCode ?? "PI_WORKER_EXITED") : null;
		const updated = await this.runTransition(sessionId, runId, ACTIVE_RUN_STATUSES, {
			status: outcome.status,
			finishedAt: new Date(),
			errorCode,
		});
		if (!updated) return false;
		await this.clearActiveRun(sessionId, runId);
		this.releaseLock(sessionId, runId);
		return true;
	}

	/** 旧事件/取消前的中止请求:只收敛 matching active run。 */
	async failRun(sessionId: string, runId: string, code: PiErrorCode): Promise<boolean> {
		return this.settleRun(sessionId, runId, { status: "failed", errorCode: code });
	}

	/** 重连后按 Client 权威状态收敛本轮。 */
	async reconcileOpen(sessionId: string, runId: string, state: PiAgentState): Promise<boolean> {
		if (isPiAgentIdle(state)) {
			return this.settleRun(sessionId, runId, { status: "succeeded" });
		}
		const target = state.waitingForExtensionInput || state.status === "waiting_for_extension_input"
			? WAITING_INPUT
			: RUNNING;
		return this.runTransition(sessionId, runId, [RUNNING, WAITING_INPUT, DISCONNECTED], { status: target });
	}

	async scheduleSettlement(sessionId: string, runId: string, onSettle: () => Promise<void>): Promise<void> {
		this.cancelSettlement(sessionId, runId);
		const key = this.settlementKey(sessionId, runId);
		const timer = setTimeout(() => {
			this.settlementTimers.delete(key);
			void this.findRun(sessionId, runId)
				.then((run) => {
					if (run && ACTIVE_RUN_STATUSES.includes(run.status as typeof ACTIVE_RUN_STATUSES[number])) {
						return onSettle();
					}
				})
				.catch(() => {});
		}, SETTLEMENT_GRACE_MS);
		this.settlementTimers.set(key, timer);
	}

	cancelSettlement(sessionId: string, runId: string): void {
		const key = this.settlementKey(sessionId, runId);
		const timer = this.settlementTimers.get(key);
		if (timer) {
			clearTimeout(timer);
			this.settlementTimers.delete(key);
		}
	}

	async markReconcilePending(clientId: string, socketId: string): Promise<void> {
		await this.serialized(clientId, async () => {
			this.generations.set(clientId, { socketId, ready: false });
		});
	}

	async withReconciledClient<T>(clientId: string, operation: (lease: { clientId: string; socketId: string }) => Promise<T>): Promise<T> {
		const generation = this.requireGeneration(clientId);
		const socketId = generation.socketId;
		return this.serialized(clientId, async () => {
			this.requireGeneration(clientId, socketId);
			return operation({ clientId, socketId });
		});
	}

	async withReconciledSocket<T>(clientId: string, socketId: string, operation: () => Promise<T>): Promise<T> {
		this.requireGeneration(clientId, socketId);
		return this.serialized(clientId, async () => {
			this.requireGeneration(clientId, socketId);
			return operation();
		});
	}

	async reconcileGeneration(clientId: string, socketId: string, report: PiStateReport): Promise<PiStateAck> {
		return this.serialized(clientId, async () => {
			const generation = this.generations.get(clientId);
			if (!generation || generation.socketId !== socketId || generation.ready) {
				throw piError("PI_STATE_PENDING", safePiErrorMessage("PI_STATE_PENDING"));
			}
			const ack = await this.reconcileReport(clientId, report);
			if (!ack.reportAgain) generation.ready = true;
			return ack;
		});
	}

	async disconnectGeneration(clientId: string, socketId: string): Promise<boolean> {
		return this.serialized(clientId, async () => {
			const generation = this.generations.get(clientId);
			if (!generation || generation.socketId !== socketId) return false;
			this.generations.delete(clientId);
			for (const run of await this.listActiveRuns(clientId)) {
				if (![PENDING, RUNNING, WAITING_INPUT].includes(run.status as typeof PENDING)) continue;
				await this.runTransition(run.sessionId, run.id, [PENDING, RUNNING, WAITING_INPUT], { status: DISCONNECTED });
			}
			return true;
		});
	}

	private async reconcileReport(clientId: string, report: PiStateReport): Promise<PiStateAck> {
		const acceptedRunIds: string[] = [];
		const closedRunIds: string[] = [];
		const activeReports = report.runs.filter((run) => run.status === "running" || run.status === "waiting_input");
		const duplicateKeys = new Set<string>();
		const seenKeys = new Set<string>();
		for (const run of activeReports) {
			if (!run.projectKey) continue;
			if (seenKeys.has(run.projectKey)) duplicateKeys.add(run.projectKey);
			seenKeys.add(run.projectKey);
		}
		for (const run of activeReports) {
			const row = await this.findRun(run.sessionId, run.runId);
			if (!row || row.clientId !== clientId || !ACTIVE_RUN_STATUSES.includes(row.status as typeof ACTIVE_RUN_STATUSES[number])) {
				closedRunIds.push(run.runId);
				continue;
			}
			if (run.projectKey && duplicateKeys.has(run.projectKey)) {
				await this.failRun(run.sessionId, run.runId, "PI_PROTOCOL_INVALID");
				closedRunIds.push(run.runId);
				continue;
			}
			const status = run.status === "waiting_input" ? WAITING_INPUT : RUNNING;
			if (await this.runTransition(run.sessionId, run.runId, ACTIVE_RUN_STATUSES, { status })) {
				acceptedRunIds.push(run.runId);
				if (run.projectKey) this.setLock(clientId, run.projectKey, run.sessionId, run.runId);
			}
		}
		for (const run of report.runs.filter((candidate) => candidate.status === "succeeded" || candidate.status === "aborted")) {
			const row = await this.findRun(run.sessionId, run.runId);
			if (row?.clientId === clientId) {
				const settled = await this.settleRun(run.sessionId, run.runId, {
					status: run.status === "aborted" ? "aborted" : "succeeded",
				});
				if (settled) acceptedRunIds.push(run.runId);
			}
		}
		for (const run of report.runs.filter((candidate) => candidate.status === "failed")) {
			const row = await this.findRun(run.sessionId, run.runId);
			if (row?.clientId === clientId && await this.failRun(run.sessionId, run.runId, run.errorCode ?? "PI_WORKER_EXITED")) {
				acceptedRunIds.push(run.runId);
			}
		}
		const reported = new Set(report.runs.map((run) => `${run.sessionId}:${run.runId}`));
		for (const row of await this.listActiveRuns(clientId)) {
			if (reported.has(`${row.sessionId}:${row.id}`)) continue;
			await this.failRun(row.sessionId, row.id, "PI_CLIENT_RESTARTED");
		}
		return { acceptedRunIds, closedRunIds, reportAgain: closedRunIds.length > 0 };
	}

	/** 某 Client 的非终态 Run(重连对账与发布 drain 使用)。 */
	async listActiveRuns(clientId: string): Promise<Array<{ id: string; sessionId: string; status: string; kind: string }>> {
		const rows = await this.runs().findMany({
			where: { clientId, status: { in: [...ACTIVE_RUN_STATUSES] } },
		}) as RunRow[];
		return rows.map((row) => ({ id: row.id, sessionId: row.sessionId, status: row.status, kind: row.kind }));
	}

	/** 全库非终态 Run 数量(发布 drain 闸门)。 */
	async countActiveRuns(): Promise<number> {
		return this.runs().count({ where: { status: { in: [...ACTIVE_RUN_STATUSES] } } });
	}

	private async findRun(sessionId: string, runId: string): Promise<RunRow | null> {
		const row = await this.runs().findUnique({ where: { id: runId } }) as RunRow | null;
		return row && row.sessionId === sessionId ? row : null;
	}

	/** 仅当会话 activeRunId 仍指向本轮时清空,避免误清新 Run 指针。 */
	private async clearActiveRun(sessionId: string, runId: string): Promise<void> {
		await this.sessions().updateMany({
			where: { id: sessionId, activeRunId: runId },
			data: { activeRunId: null, lastActivityAt: new Date() },
		});
	}

	private async runTransition(
		sessionId: string,
		runId: string,
		statuses: readonly string[],
		data: Record<string, unknown>,
	): Promise<boolean> {
		const updated = await this.runs().updateMany({
			where: { id: runId, sessionId, status: { in: [...statuses] } },
			data,
		});
		return updated.count > 0;
	}
}

interface RunQueries {
	create(args: { data: Record<string, unknown> }): Promise<unknown>;
	findUnique(args: { where: { id: string } }): Promise<unknown>;
	findMany(args: Record<string, unknown>): Promise<unknown>;
	count(args: Record<string, unknown>): Promise<number>;
	updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}
interface SessionQueries {
	findUnique(args: { where: { id: string } }): Promise<unknown>;
	updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export type { RunStatus };
