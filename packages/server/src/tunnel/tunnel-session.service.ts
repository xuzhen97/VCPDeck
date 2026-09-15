import { randomUUID } from "node:crypto";
import {
	Inject,
	Injectable,
	type OnModuleDestroy,
	type OnModuleInit,
} from "@nestjs/common";
import {
	Events,
	P2P_TUNNEL_PROTOCOL_VERSION,
	TunnelLimits,
	parseP2pTunnelCapabilityStatus,
	parseTunnelBrowserAttach,
	parseTunnelBrowserSignal,
	parseTunnelClientSignal,
	parseTunnelClientState,
	parseTunnelClose,
	parseTunnelSessionCreateRequest,
	type ActorContext,
	type TunnelClientState,
	type TunnelIceServer,
	type TunnelSessionCreated,
	type TunnelSignal,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { TunnelConfigService } from "./tunnel-config.service.js";

const SWEEP_INTERVAL_MS = 5_000;

/** 隧道 Session 领域错误；code 稳定，statusCode 映射 HTTP。 */
export class TunnelSessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly statusCode: number,
	) {
		super(message);
	}
}

/** 活动隧道 Session（仅内存，绑定创建者/双方 socket lease）。 */
interface TunnelSession {
	id: string;
	actorIdentityId: string;
	clientId: string;
	clientSocketId: string;
	browserSocketId: string | null;
	targetPort: number;
	iceServers: TunnelIceServer[];
	attachExpiresAt: number;
	expiresAt: number;
}

/** 精确 socket emitter 回调（由 Gateway 绑定）。 */
export type TunnelSender = (socketId: string, event: string, payload: unknown) => void;

/**
 * 管理活动 P2P 隧道 Session：创建、绑定、信令转发与幂等清理。
 * 全部只存内存；SDP/candidate/HTTP 正文不落日志。
 */
@Injectable()
export class TunnelSessionService implements OnModuleInit, OnModuleDestroy {
	private sessions = new Map<string, TunnelSession>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private sendClient: TunnelSender = () => {};
	private sendBrowser: TunnelSender = () => {};

	constructor(
		@Inject(TunnelConfigService) private readonly config: TunnelConfigService,
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	onModuleInit() {
		this.timer = setInterval(() => {
			void this.sweep();
		}, SWEEP_INTERVAL_MS);
	}

	onModuleDestroy() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** 由 ClientGateway 绑定 /client 精确 socket emitter。 */
	bindClientSender(fn: TunnelSender): void {
		this.sendClient = fn;
	}

	/** 由 AppGateway 绑定 /app 精确 socket emitter。 */
	bindBrowserSender(fn: TunnelSender): void {
		this.sendBrowser = fn;
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** 创建临时 Session：校验 Client 在线 + p2pTunnel 能力，并签发短期凭据。 */
	async create(raw: unknown, actor: ActorContext): Promise<TunnelSessionCreated> {
		const req = parseTunnelSessionCreateRequest(raw);
		const client = await this.prisma.client.findUnique({ where: { id: req.clientId } });
		if (!client || client.online !== true || typeof client.socketId !== "string") {
			throw new TunnelSessionError("TUNNEL_CLIENT_UNAVAILABLE", "目标 Client 离线", 409);
		}
		const p2p = this.readP2pCapability(client.capabilityDetails);
		if (!p2p || p2p.available !== true || p2p.protocolVersion !== P2P_TUNNEL_PROTOCOL_VERSION) {
			throw new TunnelSessionError("TUNNEL_CLIENT_UNSUPPORTED", "目标 Client 不支持 P2P 隧道", 409);
		}

		const now = Date.now();
		const id = `tn_${randomUUID()}`;
		const iceServers = await this.config.issueIceServers(id, new Date(now));
		const session: TunnelSession = {
			id,
			actorIdentityId: actor.identityId,
			clientId: req.clientId,
			clientSocketId: client.socketId,
			browserSocketId: null,
			targetPort: req.targetPort,
			iceServers,
			attachExpiresAt: now + TunnelLimits.attachTimeoutMs,
			expiresAt: now + TunnelLimits.sessionTtlMs,
		};
		this.sessions.set(id, session);

		return {
			sessionId: id,
			clientId: req.clientId,
			targetPort: req.targetPort,
			attachDeadline: new Date(session.attachExpiresAt).toISOString(),
			iceServers,
		};
	}

	/** 绑定 Browser socket 到 Session，并向目标 Client lease 下发 prepare。 */
	async attachBrowser(sessionId: string, actor: ActorContext, browserSocketId: string): Promise<void> {
		const session = this.requireOwned(sessionId, actor.identityId);
		if (Date.now() > session.attachExpiresAt) {
			this.release(session.id, "attach expired");
			throw new TunnelSessionError("TUNNEL_SESSION_EXPIRED", "隧道 attach 已超时", 410);
		}
		if (session.browserSocketId !== null) {
			if (session.browserSocketId !== browserSocketId) {
				throw new TunnelSessionError("TUNNEL_FORBIDDEN", "隧道已被其他 Browser 绑定", 403);
			}
			return; // 同一 browser 幂等重连
		}
		session.browserSocketId = browserSocketId;
		this.sendClient(session.clientSocketId, Events.TUNNEL_PREPARE, {
			sessionId: session.id,
			clientId: session.clientId,
			targetPort: session.targetPort,
			iceServers: session.iceServers,
		});
	}

	/** 转发 Browser 信令（offer/candidate）到目标 Client lease。 */
	async signalFromBrowser(browserSocketId: string, raw: unknown): Promise<void> {
		const parsed = this.parseBrowserSignal(raw);
		const session = this.sessions.get(parsed.sessionId);
		if (!session) throw new TunnelSessionError("TUNNEL_SESSION_NOT_FOUND", "隧道不存在", 404);
		if (session.browserSocketId !== browserSocketId) {
			throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Browser", 403);
		}
		this.sendClient(session.clientSocketId, Events.TUNNEL_SIGNAL, parsed);
	}

	/** 转发 Client 信令（answer/candidate）到已绑定 Browser。 */
	async signalFromClient(clientSocketId: string, raw: unknown): Promise<void> {
		const parsed = this.parseClientSignal(raw);
		const session = this.sessions.get(parsed.sessionId);
		if (!session || session.clientSocketId !== clientSocketId) {
			throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Client", 403);
		}
		if (session.browserSocketId) {
			this.sendBrowser(session.browserSocketId, Events.TUNNEL_SIGNAL, parsed);
		}
	}

	/** Client 上报数据面状态；failed/closed 时先通知 Browser 再释放。 */
	async clientState(clientSocketId: string, raw: unknown): Promise<void> {
		let parsed: TunnelClientState;
		try {
			parsed = parseTunnelClientState(raw);
		} catch {
			throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "状态非法", 400);
		}
		const session = this.sessions.get(parsed.sessionId);
		if (!session || session.clientSocketId !== clientSocketId) {
			throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非绑定 Client", 403);
		}
		if (parsed.state === "failed" || parsed.state === "closed") {
			if (session.browserSocketId) {
				this.sendBrowser(session.browserSocketId, Events.TUNNEL_STATE, {
					sessionId: session.id,
					state: parsed.state,
					code: parsed.code,
				});
			}
			this.release(session.id, `client ${parsed.state}`);
		}
	}

	/** 创建者显式关闭（幂等）。 */
	async close(sessionId: string, actor: ActorContext): Promise<{ closed: true }> {
		const session = this.sessions.get(sessionId);
		if (session && session.actorIdentityId !== actor.identityId) {
			throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非创建者", 403);
		}
		this.release(sessionId, "closed");
		return { closed: true };
	}

	/** Client 侧显式关闭（校验 lease 后幂等释放）。 */
	async closeFromClient(clientId: string, clientSocketId: string, sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.clientId !== clientId || session.clientSocketId !== clientSocketId) return;
		this.release(session.id, "closed");
	}

	/** Browser socket 断开：只清理绑定该 socket 的 Session。 */
	disconnectBrowser(browserSocketId: string): void {
		for (const [id, session] of this.sessions) {
			if (session.browserSocketId === browserSocketId) this.release(id, "browser disconnect");
		}
	}

	/** Client socket 断开：只清理匹配 lease 的 Session。 */
	disconnectClient(clientId: string, clientSocketId: string): void {
		for (const [id, session] of this.sessions) {
			if (session.clientId === clientId && session.clientSocketId === clientSocketId) {
				this.release(id, "client disconnect");
			}
		}
	}

	// ── 内部 ──

	private sweep(): void {
		const now = Date.now();
		for (const [id, session] of this.sessions) {
			if (session.browserSocketId === null && now >= session.attachExpiresAt) {
				this.release(id, "attach expired");
			} else if (session.browserSocketId !== null && now > session.expiresAt) {
				this.release(id, "expired");
			}
		}
	}

	private release(id: string, _reason: string): void {
		const session = this.sessions.get(id);
		if (!session) return; // 幂等
		if (session.browserSocketId) this.sendBrowser(session.browserSocketId, Events.TUNNEL_CLOSE, { sessionId: id });
		this.sendClient(session.clientSocketId, Events.TUNNEL_CLOSE, { sessionId: id });
		this.sessions.delete(id);
	}

	private requireOwned(sessionId: string, identityId: string): TunnelSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new TunnelSessionError("TUNNEL_SESSION_NOT_FOUND", "隧道不存在", 404);
		if (session.actorIdentityId !== identityId) {
			throw new TunnelSessionError("TUNNEL_FORBIDDEN", "非创建者", 403);
		}
		return session;
	}

	private parseBrowserSignal(raw: unknown): TunnelSignal {
		try {
			return parseTunnelBrowserSignal(raw);
		} catch {
			throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "信令非法", 400);
		}
	}

	private parseClientSignal(raw: unknown): TunnelSignal {
		try {
			return parseTunnelClientSignal(raw);
		} catch {
			throw new TunnelSessionError("TUNNEL_SIGNAL_INVALID", "信令非法", 400);
		}
	}

	/** 从持久化 capabilityDetails 严格读取 p2pTunnel 摘要；损坏/缺失返回 null。 */
	private readP2pCapability(
		json: string | null,
	): { available: boolean; protocolVersion: number } | null {
		if (!json) return null;
		let details: unknown;
		try {
			details = JSON.parse(json);
		} catch {
			return null;
		}
		if (!details || typeof details !== "object") return null;
		const raw = (details as { p2pTunnel?: unknown }).p2pTunnel;
		if (raw === undefined || raw === null) return null;
		try {
			return parseP2pTunnelCapabilityStatus(raw);
		} catch {
			return null;
		}
	}
}
