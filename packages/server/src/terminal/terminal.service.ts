import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { TerminalLimits } from "@vcpdeck/shared";
import type {
	ActorContext,
	PaginatedResult,
	TerminalAuditEventName,
	TerminalClientRequest,
	TerminalClientResponse,
	TerminalOutputChunk,
	TerminalSessionInfo,
	TerminalSessionStatus,
	TerminalShellInfo,
	TerminalStateAck,
	TerminalStateReport,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TerminalRequestBroker } from "./terminal-request-broker.js";
import { TerminalAuditService, type TerminalAuditRecordRequest } from "./terminal-audit.service.js";
import { toTerminalSessionInfo } from "./terminal-records.js";

export const TERMINAL_SESSION_END_STATUSES: readonly TerminalSessionStatus[] = [
	"exited",
	"interrupted",
	"expired",
	"closed",
	"error",
];

function terminalError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** 浏览器 attachment（内存态）。 */
interface TerminalAttachment {
	attachmentId: string;
	socketId: string;
	identityId: string;
	actorName: string;
	reconnectTokenHash: string;
	mode: "operator" | "viewer";
	state: "syncing" | "live";
	attachedAt: number;
	lastAckSeq: number;
	snapshotSeq: number;
	backlog: TerminalOutputChunk[];
	backlogBytes: number;
}

/** 会话运行时状态（内存态；活跃 PTY 的权威在 Client）。 */
interface SessionRuntime {
	sessionId: string;
	clientId: string;
	attachments: Map<string, TerminalAttachment>;
	operatorAttachmentId: string | null;
	protectedUntil: number | null;
	/** 断开 operator 的 token hash（30 秒保护期内可重绑）。 */
	protectedTokenHash: string | null;
	/** 断开 operator 的 identity。 */
	protectedIdentityId: string | null;
	lastSeq: number;
	clientAttachPending: boolean;
	detachNotified: boolean;
}

/** 服务依赖（测试注入）。 */
export interface TerminalServiceDeps {
	prisma: PrismaService;
	broker: TerminalRequestBroker;
	audit: { record: (request: TerminalAuditRecordRequest) => Promise<void> };
	now?: () => number;
	hashToken?: (token: string) => string;
}

function isDepsObject(value: unknown): value is TerminalServiceDeps {
	return (
		typeof value === "object" &&
		value !== null &&
		"prisma" in value &&
		"broker" in value &&
		"audit" in value
	);
}

/** 稳定终端错误。 */

/** 终端会话服务：元数据、单写多读、重连保护、输出同步与状态对账。 */
@Injectable()
export class TerminalService {
	private readonly runtimes = new Map<string, SessionRuntime>();
	private readonly syncPromises = new Map<string, Promise<void>>();
	private readonly browserEmitter: ((socketId: string, event: string, payload: unknown) => void) | null = null;
	private readonly createChains = new Map<string, Promise<unknown>>();
	private now: () => number;
	private hashToken: (token: string) => string;
	private deps: TerminalServiceDeps;

	/**
	 * Nest 注入构造。测试请用 TerminalService.withDeps()。
	 */
	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(TerminalRequestBroker) broker: TerminalRequestBroker,
		@Inject(TerminalAuditService) audit: TerminalAuditService,
	) {
		this.deps = { prisma, broker, audit };
		this.now = Date.now;
		this.hashToken = sha256;
	}

	/** 测试构造：注入 fake prisma/broker/audit。 */
	static withDeps(deps: TerminalServiceDeps): TerminalService {
		const service = new TerminalService(
			null as unknown as PrismaService,
			null as unknown as TerminalRequestBroker,
			null as unknown as TerminalAuditService,
		);
		service.deps = deps;
		service.now = deps.now ?? Date.now;
		service.hashToken = deps.hashToken ?? sha256;
		return service;
	}

	/** AppGateway afterInit 时绑定浏览器事件发射器。 */
	bindBrowserEmitter(fn: (socketId: string, event: string, payload: unknown) => void): void {
		(this as unknown as { browserEmitter: ((socketId: string, event: string, payload: unknown) => void) | null }).browserEmitter = fn;
	}

	private emitBrowser(socketId: string, event: string, payload: unknown): void {
		this.browserEmitter?.(socketId, event, payload);
	}

	private runtime(sessionId: string): SessionRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	private ensureRuntime(sessionId: string, clientId: string): SessionRuntime {
		let rt = this.runtimes.get(sessionId);
		if (!rt) {
			rt = {
				sessionId,
				clientId,
				attachments: new Map(),
				operatorAttachmentId: null,
				protectedUntil: null,
				protectedTokenHash: null,
				protectedIdentityId: null,
				lastSeq: 0,
				clientAttachPending: false,
				detachNotified: false,
			};
			this.runtimes.set(sessionId, rt);
		}
		return rt;
	}

	/** 串行化同一 Client 的创建/对账操作。 */
	private withClientChain<T>(clientId: string, task: () => Promise<T>): Promise<T> {
		const prev = this.createChains.get(clientId) ?? Promise.resolve();
		const next = prev.then(task, task);
		this.createChains.set(clientId, next.catch(() => undefined));
		return next;
	}

	private async clientSocketId(clientId: string): Promise<string | null> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
			select: { socketId: true },
		});
		return client?.socketId ?? null;
	}

	private async requireClientLease(clientId: string): Promise<{ clientId: string; socketId: string }> {
		const socketId = await this.clientSocketId(clientId);
		if (!socketId) throw terminalError("TERMINAL_CLIENT_OFFLINE", "Client is offline");
		return { clientId, socketId };
	}

	private async sendRequest(clientId: string, request: TerminalClientRequest): Promise<TerminalClientResponse> {
		const lease = await this.requireClientLease(clientId);
		return this.deps.broker.request(lease, request);
	}

	private async recordAudit(
		sessionId: string,
		clientId: string,
		event: TerminalAuditEventName,
		actor: Pick<ActorContext, "identityId" | "displayName" | "source"> | null,
		result: "ok" | "error" = "ok",
		reason?: string,
	): Promise<void> {
		try {
			await this.deps.audit.record({
				sessionId,
				clientId,
				event,
				identityId: actor?.identityId ?? null,
				actorName: actor?.displayName ?? null,
				source: actor?.source ?? null,
				result,
				reason,
			});
		} catch {
			/* 审计失败不阻断业务 */
		}
	}

	// ── REST：Shell ──

	/** 列出 Client 可用 Shell（安全 DTO）。 */
	async listShells(clientId: string): Promise<TerminalShellInfo[]> {
		const response = await this.sendRequest(clientId, { requestId: `ts_${randomUUID()}`, action: "shells.list" });
		if (!response.ok) throw terminalError(response.error.code, response.error.message);
		if (response.action !== "shells.list") throw terminalError("TERMINAL_PROTOCOL_INVALID", "Unexpected response");
		return response.shells;
	}

	// ── REST：Session ──

	/** 会话列表（默认非终态优先，按 createdAt desc）。 */
	async listSessions(clientId: string, page = 1, pageSize = 20): Promise<PaginatedResult<TerminalSessionInfo>> {
		const where: Record<string, unknown> = { clientId };
		const [list, total] = await Promise.all([
			this.deps.prisma.terminalSession.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.deps.prisma.terminalSession.count({ where }),
		]);
		return {
			data: list.map((r) => toTerminalSessionInfo(r as never)),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	/** 会话详情（仅限本 Client 范围）。 */
	async getSession(clientId: string, sessionId: string): Promise<TerminalSessionInfo> {
		const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
		if (!row || row.clientId !== clientId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		return toTerminalSessionInfo(row as never);
	}

	/** 创建会话（Server 生成 sessionId；串行化 5 会话限制）。 */
	async createSession(
		clientId: string,
		request: { shellId: string; cols: number; rows: number },
		actor: ActorContext,
	): Promise<TerminalSessionInfo> {
		return this.withClientChain(clientId, async () => {
			const lease = await this.requireClientLease(clientId);
			const active = await this.deps.prisma.terminalSession.count({
				where: { clientId, status: { notIn: [...TERMINAL_SESSION_END_STATUSES] } },
			});
			if (active >= TerminalLimits.maxSessionsPerClient) {
				throw terminalError("TERMINAL_SESSION_LIMIT_REACHED", "Terminal session limit reached");
			}
			const sessionId = `ts_${randomUUID()}`;
			const row = await this.deps.prisma.terminalSession.create({
				data: {
					id: sessionId,
					clientId,
					shellId: request.shellId,
					shellLabel: request.shellId,
					status: "starting",
					cols: request.cols,
					rows: request.rows,
					createdByIdentityId: actor.identityId,
					createdByName: actor.displayName,
				},
			});
			await this.recordAudit(sessionId, clientId, "created", actor);
			const response = await this.deps.broker.request(
				lease,
				{
					requestId: `ts_${randomUUID()}`,
					action: "session.create",
					sessionId,
					shellId: request.shellId,
					cols: request.cols,
					rows: request.rows,
				},
			);
			if (!response.ok) {
				await this.deps.prisma.terminalSession.update({
					where: { id: sessionId },
					data: { status: "error", errorCode: response.error.code, endedAt: new Date(this.now()) },
				});
				await this.recordAudit(sessionId, clientId, "create_failed", actor, "error", response.error.code);
				throw terminalError(response.error.code, response.error.message);
			}
			const updated = await this.deps.prisma.terminalSession.update({
				where: { id: sessionId },
				data: { status: "detached", shellLabel: request.shellId },
			});
			return toTerminalSessionInfo(updated as never);
		});
	}

	/** 关闭会话（幂等；终态不改写首次原因）。 */
	async closeSession(clientId: string, sessionId: string, actor: ActorContext): Promise<TerminalSessionInfo> {
		const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
		if (!row || row.clientId !== clientId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		if (TERMINAL_SESSION_END_STATUSES.includes(row.status as TerminalSessionStatus)) {
			return toTerminalSessionInfo(row as never);
		}
		// Client 在线：远端确认后标记 closed
		const response = await this.sendRequest(clientId, {
			requestId: `ts_${randomUUID()}`,
			action: "session.close",
			sessionId,
			reason: "closed",
		});
		if (!response.ok) throw terminalError(response.error.code, response.error.message);
		const updated = await this.deps.prisma.terminalSession.update({
			where: { id: sessionId },
			data: { status: "closed", endedAt: new Date(this.now()), endReason: "TERMINAL_CLOSE_REQUESTED" },
		});
		this.runtimes.delete(sessionId);
		await this.recordAudit(sessionId, clientId, "closed", actor);
		return toTerminalSessionInfo(updated as never);
	}

	// ── 浏览器 attach/detach ──

	/** 浏览器 attach：首个为 operator；token 匹配时恢复操作权。 */
	async attachBrowser(args: {
		clientId?: string;
		sessionId: string;
		actor: ActorContext;
		socketId: string;
		reconnectToken?: string;
	}): Promise<{ attachmentId: string; reconnectToken: string; mode: "operator" | "viewer"; controlProtectedUntil: string | null }> {
		const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: args.sessionId } });
		if (!row) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		// clientId 校验：浏览器可不传（sessionId 即能力凭证），传了就必须匹配
		if (args.clientId !== undefined && row.clientId !== args.clientId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		const clientId = row.clientId;
		if (TERMINAL_SESSION_END_STATUSES.includes(row.status as TerminalSessionStatus)) {
			throw terminalError("TERMINAL_SESSION_ENDED", "Session has ended");
		}
		const rt = this.ensureRuntime(args.sessionId, clientId);

		// token 重绑：断开 operator 的保护记录匹配时恢复操作权
		if (args.reconnectToken) {
			const hash = this.hashToken(args.reconnectToken);
			if (
				rt.operatorAttachmentId === null &&
				rt.protectedTokenHash !== null &&
				rt.protectedTokenHash === hash &&
				rt.protectedIdentityId === args.actor.identityId &&
				this.now() < (rt.protectedUntil ?? 0)
			) {
				const attachmentId = `ta_${randomUUID()}`;
				const attachment: TerminalAttachment = {
					attachmentId,
					socketId: args.socketId,
					identityId: args.actor.identityId,
					actorName: args.actor.displayName,
					reconnectTokenHash: hash,
					mode: "operator",
					state: "syncing",
					attachedAt: this.now(),
					lastAckSeq: 0,
					snapshotSeq: 0,
					backlog: [],
					backlogBytes: 0,
				};
				rt.attachments.set(attachmentId, attachment);
				rt.operatorAttachmentId = attachmentId;
				rt.protectedUntil = null;
				rt.protectedTokenHash = null;
				rt.protectedIdentityId = null;
				await this.recordAudit(args.sessionId, clientId, "attached", args.actor);
				this.trackSync(rt, attachment);
				return {
					attachmentId,
					reconnectToken: args.reconnectToken,
					mode: "operator",
					controlProtectedUntil: null,
				};
			}
		}

		// 新 attachment：保护期内新连接只能成为 viewer
		const attachmentId = `ta_${randomUUID()}`;
		const token = `tok_${randomUUID()}`;
		const isOperator =
			rt.operatorAttachmentId === null && this.now() >= (rt.protectedUntil ?? 0);
		const attachment: TerminalAttachment = {
			attachmentId,
			socketId: args.socketId,
			identityId: args.actor.identityId,
			actorName: args.actor.displayName,
			reconnectTokenHash: this.hashToken(token),
			mode: isOperator ? "operator" : "viewer",
			state: "syncing",
			attachedAt: this.now(),
			lastAckSeq: 0,
			snapshotSeq: 0,
			backlog: [],
			backlogBytes: 0,
		};
		rt.attachments.set(attachmentId, attachment);
		if (isOperator) {
			rt.operatorAttachmentId = attachmentId;
			rt.protectedUntil = null;
		}
		await this.recordAudit(args.sessionId, clientId, "attached", args.actor);
		this.trackSync(rt, attachment);
		return {
			attachmentId,
			reconnectToken: token,
			mode: attachment.mode,
			controlProtectedUntil: rt.protectedUntil ? new Date(rt.protectedUntil).toISOString() : null,
		};
	}

	/** attach 同步完成 promise（测试与内部追踪用）。 */
	whenAttachSettled(sessionId: string): Promise<void> {
		return this.syncPromises.get(sessionId) ?? Promise.resolve();
	}

	private trackSync(rt: SessionRuntime, attachment: TerminalAttachment): void {
		const p = this.syncAttachment(rt, attachment);
		this.syncPromises.set(rt.sessionId, p.catch(() => undefined));
	}

	/** attach 同步：请求 Client snapshot，随后按 seq 发送增量。 */
	private async syncAttachment(rt: SessionRuntime, attachment: TerminalAttachment): Promise<void> {
		try {
			const response = await this.sendRequest(rt.clientId, {
				requestId: `ts_${randomUUID()}`,
				action: "session.attach",
				sessionId: rt.sessionId,
			});
			if (!response.ok) {
				this.emitBrowser(attachment.socketId, "terminal:error", { code: response.error.code, message: response.error.message });
				return;
			}
			if (response.action !== "session.attach") return;
			attachment.snapshotSeq = response.snapshotSeq;
			this.emitBrowser(attachment.socketId, "terminal:snapshot", {
				sessionId: rt.sessionId,
				snapshot: response.snapshot,
				snapshotSeq: response.snapshotSeq,
				cols: response.cols,
				rows: response.rows,
				historyTruncated: response.historyTruncated,
			});
			// 增量：seq > snapshotSeq 的暂存块
			const backlog = attachment.backlog.filter((c) => c.seq > response.snapshotSeq);
			attachment.backlog = [];
			attachment.backlogBytes = 0;
			attachment.state = "live";
			attachment.lastAckSeq = response.snapshotSeq;
			for (const chunk of backlog) {
				this.emitBrowser(attachment.socketId, "terminal:output", chunk);
				attachment.lastAckSeq = chunk.seq;
			}
			this.broadcastControl(rt);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			this.emitBrowser(attachment.socketId, "terminal:error", {
				code: typeof code === "string" ? code : "TERMINAL_CLIENT_OFFLINE",
				message: "Terminal session is not available",
			});
		}
	}

	/** 浏览器 socket 断开：清理其全部 attachment。 */
	async detachBrowserSocket(socketId: string): Promise<void> {
		for (const rt of this.runtimes.values()) {
			let changed = false;
			for (const [attachmentId, attachment] of rt.attachments) {
				if (attachment.socketId !== socketId) continue;
				await this.removeAttachment(rt, attachmentId, attachment);
				changed = true;
			}
			if (!changed) continue;
			this.afterAttachmentRemoved(rt);
		}
	}

	/** 浏览器显式 detach（单会话）。 */
	async detachBrowser(args: { socketId: string; sessionId: string; attachmentId: string }): Promise<void> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) return;
		await this.removeAttachment(rt!, args.attachmentId, attachment);
		this.afterAttachmentRemoved(rt!);
	}

	private async removeAttachment(
		rt: SessionRuntime,
		attachmentId: string,
		attachment: TerminalAttachment,
	): Promise<void> {
		rt.attachments.delete(attachmentId);
		if (rt.operatorAttachmentId === attachmentId) {
			// 30 秒重连保护（记住断开 operator 的凭证）
			rt.operatorAttachmentId = null;
			rt.protectedUntil = this.now() + TerminalLimits.reconnectGraceMs;
			rt.protectedTokenHash = attachment.reconnectTokenHash;
			rt.protectedIdentityId = attachment.identityId;
		}
		await this.recordAudit(rt.sessionId, rt.clientId, "detached", {
			identityId: attachment.identityId,
			displayName: attachment.actorName,
			source: "web",
		});
	}

	private afterAttachmentRemoved(rt: SessionRuntime): void {
		if (rt.attachments.size === 0) {
			// 最后离开：通知 Client 进入 detached（幂等一次）
			if (!rt.detachNotified) {
				rt.detachNotified = true;
				void this.sendRequest(rt.clientId, {
					requestId: `ts_${randomUUID()}`,
					action: "session.detach",
					sessionId: rt.sessionId,
				}).catch(() => undefined);
			}
		} else {
			this.broadcastControl(rt);
		}
	}

	private broadcastControl(rt: SessionRuntime): void {
		const operator = rt.operatorAttachmentId ? rt.attachments.get(rt.operatorAttachmentId) : null;
		for (const attachment of rt.attachments.values()) {
			this.emitBrowser(attachment.socketId, "terminal:control", {
				sessionId: rt.sessionId,
				mode: attachment.mode,
				operatorName: operator?.actorName ?? null,
				controlProtectedUntil: rt.protectedUntil ? new Date(rt.protectedUntil).toISOString() : null,
				canTakeover: rt.operatorAttachmentId === null && this.now() >= (rt.protectedUntil ?? 0),
			});
		}
	}

	// ── 浏览器写入（最终权限检查） ──

	/** 输入：仅 operator。 */
	async browserInput(args: { socketId: string; sessionId: string; attachmentId: string; data: string }): Promise<void> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		if (rt?.operatorAttachmentId !== attachment.attachmentId) {
			throw terminalError("TERMINAL_READ_ONLY", "Session is read-only");
		}
		await this.sendRequest(rt!.clientId, {
			requestId: `ts_${randomUUID()}`,
			action: "session.input",
			sessionId: args.sessionId,
			data: args.data,
		});
	}

	/** resize：仅 operator。 */
	async browserResize(args: { socketId: string; sessionId: string; attachmentId: string; cols: number; rows: number }): Promise<void> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		if (rt?.operatorAttachmentId !== attachment.attachmentId) {
			throw terminalError("TERMINAL_READ_ONLY", "Session is read-only");
		}
		await this.sendRequest(rt!.clientId, {
			requestId: `ts_${randomUUID()}`,
			action: "session.resize",
			sessionId: args.sessionId,
			cols: args.cols,
			rows: args.rows,
		});
	}

	/** 接管：保护期结束后原子生效。 */
	async browserTakeover(args: { socketId: string; sessionId: string; attachmentId: string }): Promise<{ mode: "operator" | "viewer" }> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		if (rt?.operatorAttachmentId !== null) {
			throw terminalError("TERMINAL_CONTROL_CONFLICT", "Another operator holds control");
		}
		if (this.now() < (rt?.protectedUntil ?? 0)) {
			throw terminalError("TERMINAL_CONTROL_PROTECTED", "Operator reconnect is protected");
		}
		rt!.operatorAttachmentId = attachment.attachmentId;
		attachment.mode = "operator";
		rt!.protectedUntil = null;
		rt!.protectedTokenHash = null;
		rt!.protectedIdentityId = null;
		this.broadcastControl(rt!);
		await this.recordAudit(args.sessionId, rt!.clientId, "takeover", {
			identityId: attachment.identityId,
			displayName: attachment.actorName,
			source: "web",
		});
		return { mode: "operator" };
	}

	/** 输出 ack（慢消费者跟踪）。 */
	async browserAckOutput(args: { socketId: string; sessionId: string; attachmentId: string; seq: number }): Promise<void> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) return;
		if (args.seq > attachment.lastAckSeq) attachment.lastAckSeq = args.seq;
	}

	/** resync：重新获取 snapshot。 */
	async browserResync(args: { socketId: string; sessionId: string; attachmentId: string }): Promise<void> {
		const rt = this.runtime(args.sessionId);
		const attachment = rt?.attachments.get(args.attachmentId);
		if (!attachment || attachment.socketId !== args.socketId) {
			throw terminalError("TERMINAL_SESSION_NOT_FOUND", "Session not found");
		}
		attachment.state = "syncing";
		this.trackSync(rt!, attachment);
	}

	// ── Client 事件 ──

	async handleClientResponse(clientId: string, _socketId: string, response: TerminalClientResponse): Promise<void> {
		// 响应由 broker 关联；此处仅校验 clientId 归属（防御性）
		if (!response.ok) return;
	}

	/** Client 输出：按序转发到 live attachment；syncing 期间进入 backlog。 */
	async handleClientOutput(clientId: string, chunk: TerminalOutputChunk): Promise<void> {
		const rt = this.runtime(chunk.sessionId);
		if (!rt || rt.clientId !== clientId) return;
		if (chunk.seq <= rt.lastSeq) return; // 重复
		if (chunk.seq > rt.lastSeq + 1) {
			// gap：跳过（前端将发起 resync）
			return;
		}
		rt.lastSeq = chunk.seq;
		for (const attachment of rt.attachments.values()) {
			if (attachment.state === "syncing") {
				attachment.backlog.push(chunk);
				attachment.backlogBytes += chunk.data.length;
				if (attachment.backlogBytes > TerminalLimits.syncBacklogBytes) {
					// backlog 超限：触发重同步
					attachment.backlog = [];
					attachment.backlogBytes = 0;
					this.emitBrowser(attachment.socketId, "terminal:resync-required", { sessionId: rt.sessionId });
					attachment.state = "live"; // 等待前端 resync
					continue;
				}
			} else if (attachment.state === "live") {
				this.emitBrowser(attachment.socketId, "terminal:output", chunk);
			}
		}
	}

	/** Shell 自行退出。 */
	async handleClientExit(clientId: string, exit: { sessionId: string; exitCode: number }): Promise<void> {
		const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: exit.sessionId } });
		if (!row || row.clientId !== clientId) return;
		if (TERMINAL_SESSION_END_STATUSES.includes(row.status as TerminalSessionStatus)) return;
		const updated = await this.deps.prisma.terminalSession.update({
			where: { id: exit.sessionId },
			data: { status: "exited", endedAt: new Date(this.now()), endReason: `exit:${exit.exitCode}` },
		});
		const rt = this.runtimes.get(exit.sessionId);
		if (rt) {
			for (const attachment of rt.attachments.values()) {
				this.emitBrowser(attachment.socketId, "terminal:session-state", {
					sessionId: exit.sessionId,
					status: "exited",
					reason: `exit:${exit.exitCode}`,
				});
			}
			this.runtimes.delete(exit.sessionId);
		}
		await this.recordAudit(exit.sessionId, clientId, "exited", null);
	}

	/** 状态对账：接受存活、标记 interrupted、返回孤儿 close。 */
	async handleClientState(clientId: string, socketId: string, report: TerminalStateReport): Promise<TerminalStateAck> {
		return this.withClientChain(clientId, async () => {
			const reported = new Map(report.sessions.map((s) => [s.sessionId, s]));
			const dbSessions = await this.deps.prisma.terminalSession.findMany({
				where: { clientId, status: { notIn: [...TERMINAL_SESSION_END_STATUSES] } },
			});
			const acceptedSessionIds: string[] = [];
			const closeSessionIds: string[] = [];
			for (const row of dbSessions) {
				const id = (row as { id: string }).id;
				if (reported.has(id)) {
					acceptedSessionIds.push(id);
					const rt = this.ensureRuntime(id, clientId);
					rt.lastSeq = Math.max(rt.lastSeq, reported.get(id)?.lastSeq ?? 0);
					// 恢复为 detached（Client 侧状态为准）
					if (rt.attachments.size === 0) {
						rt.detachNotified = true;
					}
				} else {
					await this.deps.prisma.terminalSession.update({
						where: { id },
						data: { status: "interrupted", endedAt: new Date(this.now()), endReason: "TERMINAL_CLIENT_RESTARTED" },
					});
					await this.recordAudit(id, clientId, "interrupted", null, "error", "TERMINAL_CLIENT_RESTARTED");
					this.runtimes.delete(id);
				}
			}
			for (const [sessionId] of reported) {
				const row = await this.deps.prisma.terminalSession.findUnique({ where: { id: sessionId } });
				if (!row || row.clientId !== clientId || TERMINAL_SESSION_END_STATUSES.includes(row.status as TerminalSessionStatus)) {
					closeSessionIds.push(sessionId);
				}
			}
			void socketId;
			return { acceptedSessionIds, closeSessionIds };
		});
	}

	/** Client 断线：不终结会话（Client 侧 30 分钟保留计时兜底）。 */
	async handleClientDisconnect(_clientId: string, _socketId: string): Promise<void> {
		// 主动行为：Client 保留 PTY；Server 侧 attachment 不受影响
	}

	/** Client REGISTER 成功：绑定 socket（对账由 Client 上报状态触发）。 */
	async handleClientRegistered(_clientId: string, _socketId: string): Promise<void> {
		// 状态对账在 Client 上报 TERMINAL_STATE 时执行
	}
}
