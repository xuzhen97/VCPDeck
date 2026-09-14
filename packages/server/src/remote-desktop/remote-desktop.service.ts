import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
	REMOTE_DESKTOP_PROTOCOL_VERSION,
	RemoteDesktopLimits,
	parseRemoteDesktopClientResponse,
	parseRemoteDesktopSignal,
	safeRemoteDesktopErrorMessage,
	type ActorContext,
	type PaginatedResult,
	type RemoteDesktopBrowserAttached,
	type RemoteDesktopClientRequest,
	type RemoteDesktopClientResponse,
	type RemoteDesktopDisplayInfo,
	type RemoteDesktopRole,
	type RemoteDesktopSessionCreateRequest,
	type RemoteDesktopSessionInfo,
	type RemoteDesktopSignal,
	type RemoteDesktopStateAck,
	type RemoteDesktopStateReport,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import {
	toRemoteDesktopSessionInfo,
	type RemoteDesktopSessionRecord,
} from "./remote-desktop-records.js";
import {
	RemoteDesktopRequestBroker,
	type RemoteDesktopClientLease,
} from "./remote-desktop-request-broker.js";
import {
	RemoteDesktopAuditService,
	type RemoteDesktopAuditRecordRequest,
} from "./remote-desktop-audit.service.js";
import { RemoteDesktopSignalingService } from "./remote-desktop-signaling.service.js";
import { RemoteDesktopIceConfigService } from "./ice-config.service.js";

const TERMINAL_SESSION_STATUSES = new Set(["closed", "interrupted", "error"]);
const ACTIVE_SESSION_STATUSES = ["creating", "ready", "connecting", "connected", "detached"];

function remoteDesktopError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function safeString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : fallback;
}

function parsePreparedDisplay(value: unknown, index: number): RemoteDesktopDisplayInfo {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", `Invalid display ${index}`);
	}
	const input = value as Record<string, unknown>;
	const allowed = new Set([
		"id",
		"label",
		"width",
		"height",
		"physical",
		"virtual",
		"primary",
		"rotation",
		"scalePercent",
	]);
	if (Object.keys(input).some((key) => !allowed.has(key))) {
		throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", `Invalid display ${index}`);
	}
	const id = input.id;
	const label = input.label;
	if (
		typeof id !== "string" ||
		id.length === 0 ||
		id.length > 128 ||
		typeof label !== "string" ||
		label.length === 0 ||
		label.length > 128
	) {
		throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", `Invalid display ${index}`);
	}
	const integerField = (field: "width" | "height" | "scalePercent", min: number, max: number): number => {
		const value = input[field];
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", `Invalid display ${index}`);
		}
		return value;
	};
	const width = integerField("width", 1, 16_384);
	const height = integerField("height", 1, 16_384);
	const scalePercent = integerField("scalePercent", 50, 400);
	const physical = input.physical;
	const virtual = input.virtual;
	const primary = input.primary;
	const rotation = input.rotation;
	if (
		typeof physical !== "boolean" ||
		typeof virtual !== "boolean" ||
		typeof primary !== "boolean" ||
		typeof rotation !== "number" ||
		![0, 90, 180, 270].includes(rotation) ||
		(physical && virtual)
	) {
		throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", `Invalid display ${index}`);
	}
	const parsedRotation: 0 | 90 | 180 | 270 =
		rotation === 0 ? 0 : rotation === 90 ? 90 : rotation === 180 ? 180 : 270;
	return {
		id,
		label,
		width,
		height,
		physical,
		virtual,
		primary,
		rotation: parsedRotation,
		scalePercent,
	};
}

function parsePreparedDisplays(result: Record<string, unknown> | undefined): RemoteDesktopDisplayInfo[] {
	if (!Array.isArray(result?.displays) || result.displays.length === 0 || result.displays.length > 16) {
		throw remoteDesktopError("REMOTE_DESKTOP_NO_DISPLAY", "Desktop Host returned no display");
	}
	const displays = result.displays.map(parsePreparedDisplay);
	const ids = new Set<string>();
	for (const display of displays) {
		if (ids.has(display.id)) {
			throw remoteDesktopError("REMOTE_DESKTOP_PROTOCOL_MISMATCH", "Duplicate display id");
		}
		ids.add(display.id);
	}
	return displays;
}

export interface RemoteDesktopServiceDeps {
	prisma: PrismaService;
	broker: RemoteDesktopRequestBroker;
	audit: Pick<RemoteDesktopAuditService, "record">;
	signaling?: Pick<RemoteDesktopSignalingService, "acceptBrowserSignal" | "acceptHostSignal" | "reset">;
	iceConfig?: Pick<RemoteDesktopIceConfigService, "forAttachment" | "policy">;
	now?: () => number;
}

interface RemoteDesktopAttachmentRuntime {
	attachmentId: string;
	sessionId: string;
	clientId: string;
	socketId: string;
	identityId: string;
	actorName: string;
	role: RemoteDesktopRole;
	reconnectTokenHash: string;
	attachedAt: number;
}

interface RemoteDesktopSessionRuntime {
	sessionId: string;
	clientId: string;
	attachments: Map<string, RemoteDesktopAttachmentRuntime>;
	operatorAttachmentId: string | null;
	protectedUntil: number | null;
	protectedTokenHash: string | null;
	protectedIdentityId: string | null;
	detachedTimer: ReturnType<typeof setTimeout> | null;
	clientDisconnectTimer: ReturnType<typeof setTimeout> | null;
	inputFrozen: boolean;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Remote Desktop 控制面会话服务。
 * Server 只管理会话、租约和安全元数据，Desktop Host 才是捕获、输入和媒体的权威。
 */
@Injectable()
export class RemoteDesktopService {
	private deps: RemoteDesktopServiceDeps;
	private now: () => number;
	private readonly createChains = new Map<string, Promise<unknown>>();
	private readonly runtimes = new Map<string, RemoteDesktopSessionRuntime>();
	private signaling: Pick<RemoteDesktopSignalingService, "acceptBrowserSignal" | "acceptHostSignal" | "reset">;
	private browserEmitter: ((socketId: string, event: string, payload: unknown) => void) | null = null;
	private iceConfig: Pick<RemoteDesktopIceConfigService, "forAttachment" | "policy">;

	constructor(
		@Inject(PrismaService) prisma: PrismaService,
		@Inject(RemoteDesktopRequestBroker) broker: RemoteDesktopRequestBroker,
		@Inject(RemoteDesktopAuditService) audit: RemoteDesktopAuditService,
		@Optional() @Inject(RemoteDesktopSignalingService) signaling?: RemoteDesktopSignalingService,
		@Optional() @Inject(RemoteDesktopIceConfigService) iceConfig?: RemoteDesktopIceConfigService,
	) {
		this.deps = { prisma, broker, audit, signaling, iceConfig };
		this.now = Date.now;
		this.signaling = signaling ?? new RemoteDesktopSignalingService();
		this.iceConfig = iceConfig ?? new RemoteDesktopIceConfigService();
	}

	/** 测试构造：注入 fake Prisma、Broker、审计和 ICE 配置。 */
	static withDeps(deps: RemoteDesktopServiceDeps): RemoteDesktopService {
		// SAFETY: withDeps replaces all constructor dependencies before any method is called; null is never dereferenced.
		const service = new RemoteDesktopService(
			null as unknown as PrismaService,
			null as unknown as RemoteDesktopRequestBroker,
			null as unknown as RemoteDesktopAuditService,
			deps.signaling as RemoteDesktopSignalingService | undefined,
			deps.iceConfig as RemoteDesktopIceConfigService | undefined,
		);
		service.deps = deps;
		service.now = deps.now ?? Date.now;
		service.signaling = deps.signaling ?? new RemoteDesktopSignalingService(service.now);
		service.iceConfig = deps.iceConfig ?? new RemoteDesktopIceConfigService();
		return service;
	}

	/** AppGateway afterInit 时绑定 Browser 精确投递通道。 */
	bindBrowserEmitter(fn: (socketId: string, event: string, payload: unknown) => void): void {
		this.browserEmitter = fn;
	}

	private emitBrowser(socketId: string, event: string, payload: unknown): void {
		// 未绑定时明确失败，而不是静默丢弃——静默会把"信令永远到不了浏览器"
		// 变成完全不可观测的故障。
		if (!this.browserEmitter) {
			throw remoteDesktopError(
				"REMOTE_DESKTOP_HOST_OFFLINE",
				"Remote Desktop browser emitter is not bound",
			);
		}
		this.browserEmitter(socketId, event, payload);
	}

	private runtime(sessionId: string, clientId: string): RemoteDesktopSessionRuntime {
		const existing = this.runtimes.get(sessionId);
		if (existing) return existing;
		const created: RemoteDesktopSessionRuntime = {
			sessionId,
			clientId,
			attachments: new Map(),
			operatorAttachmentId: null,
			protectedUntil: null,
			protectedTokenHash: null,
			protectedIdentityId: null,
			detachedTimer: null,
			clientDisconnectTimer: null,
			inputFrozen: false,
		};
		this.runtimes.set(sessionId, created);
		return created;
	}

	private clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
		if (timer) clearTimeout(timer);
		return null;
	}

	private unrefTimer(timer: ReturnType<typeof setTimeout>): void {
		// SAFETY: Node.js timers expose unref(); the optional shape also keeps browser-like test timers valid.
		const candidate = timer as unknown as { unref?: () => void };
		candidate.unref?.();
	}

	private setSessionTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const timer = setTimeout(callback, delayMs);
		this.unrefTimer(timer);
		return timer;
	}

	private async hostRequest(
		clientId: string,
		socketId: string,
		request: RemoteDesktopClientRequest,
	): Promise<RemoteDesktopClientResponse> {
		const response = parseRemoteDesktopClientResponse(
			await this.deps.broker.request({ clientId, socketId }, request),
		);
		if (!response.ok) {
			throw remoteDesktopError(
				response.error?.code ?? "REMOTE_DESKTOP_PROTOCOL_MISMATCH",
				safeRemoteDesktopErrorMessage(response.error?.message),
			);
		}
		return response;
	}

	private withClientChain<T>(clientId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.createChains.get(clientId) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.createChains.set(clientId, next.catch(() => undefined));
		return next;
	}

	private async requireClientLease(clientId: string): Promise<RemoteDesktopClientLease> {
		const client = await this.deps.prisma.client.findUnique({
			where: { id: clientId },
			select: { id: true, online: true, socketId: true },
		});
		if (!client?.online || !client.socketId) {
			throw remoteDesktopError("REMOTE_DESKTOP_HOST_OFFLINE", "Desktop Host is offline");
		}
		return { clientId: client.id, socketId: client.socketId };
	}

	private async recordAudit(
		request: RemoteDesktopAuditRecordRequest,
	): Promise<void> {
		try {
			await this.deps.audit.record(request);
		} catch (error) {
			console.error(
				`[remote-desktop-audit] ${request.event} failed:`,
				safeString((error as { message?: unknown }).message, "audit failed"),
			);
		}
	}

	private async sessionRow(clientId: string, sessionId: string): Promise<RemoteDesktopSessionRecord> {
		const row = await this.deps.prisma.remoteDesktopSession.findUnique({
			where: { id: sessionId },
		});
		if (!row || row.clientId !== clientId) {
			throw remoteDesktopError("REMOTE_DESKTOP_NO_ACTIVE_SESSION", "Remote Desktop session not found");
		}
		// SAFETY: Prisma row fields match the narrow projection contract consumed by toRemoteDesktopSessionInfo.
		return row as unknown as RemoteDesktopSessionRecord;
	}

	async createSession(
		clientId: string,
		request: RemoteDesktopSessionCreateRequest,
		actor: ActorContext,
	): Promise<RemoteDesktopSessionInfo> {
		return this.withClientChain(clientId, async () => {
			const lease = await this.requireClientLease(clientId);
			const active = await this.deps.prisma.remoteDesktopSession.count({
				where: { clientId, status: { in: ACTIVE_SESSION_STATUSES } },
			});
			if (active > 0) {
				throw remoteDesktopError(
					"REMOTE_DESKTOP_SESSION_LIMIT",
					"Only one active Remote Desktop session is allowed per Client",
				);
			}
			const sessionId = `rds_${randomUUID()}`;
			const qualityProfile = request.qualityProfile ?? "balanced";
			const clipboardMode = request.clipboardMode ?? "off";
			await this.deps.prisma.remoteDesktopSession.create({
				data: {
					id: sessionId,
					clientId,
					createdByIdentityId: actor.identityId,
					createdByName: actor.displayName,
					status: "creating",
					selectedDisplayId: null,
					displaysJson: "[]",
					qualityProfile,
					clipboardMode,
					protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
					hostGeneration: null,
				},
			});
			await this.recordAudit({
				sessionId,
				clientId,
				event: "session.created",
				identityId: actor.identityId,
				actorName: actor.displayName,
				attachmentId: null,
				role: null,
				result: "ok",
			});

			let response: RemoteDesktopClientResponse;
			try {
				response = parseRemoteDesktopClientResponse(
					await this.deps.broker.request(lease, {
						requestId: `rdc_${randomUUID()}`,
						protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
						action: "session.prepare",
						sessionId,
						payload: { qualityProfile, clipboardMode },
					}),
				);
			} catch (error) {
				const code = typeof (error as { code?: unknown }).code === "string"
					? (error as { code: string }).code
					: "REMOTE_DESKTOP_HOST_OFFLINE";
				await this.markError(sessionId, code, safeRemoteDesktopErrorMessage((error as Error).message));
				await this.recordAudit({
					sessionId,
					clientId,
					event: "session.error",
					identityId: actor.identityId,
					actorName: actor.displayName,
					attachmentId: null,
					role: null,
					result: "error",
					reason: code,
				});
				throw remoteDesktopError(code, safeRemoteDesktopErrorMessage((error as Error).message));
			}
			if (!response.ok) {
				const code = response.error?.code ?? "REMOTE_DESKTOP_PROTOCOL_MISMATCH";
				const message = safeRemoteDesktopErrorMessage(response.error?.message);
				await this.markError(sessionId, code, message);
				await this.recordAudit({
					sessionId,
					clientId,
					event: "session.error",
					identityId: actor.identityId,
					actorName: actor.displayName,
					attachmentId: null,
					role: null,
					result: "error",
					reason: code,
				});
				throw remoteDesktopError(code, message);
			}
			let displays: RemoteDesktopDisplayInfo[];
			try {
				displays = parsePreparedDisplays(response.result);
			} catch (error) {
				const code = typeof (error as { code?: unknown }).code === "string"
					? (error as { code: string }).code
					: "REMOTE_DESKTOP_PROTOCOL_MISMATCH";
				const message = safeRemoteDesktopErrorMessage((error as Error).message);
				await this.markError(sessionId, code, message);
				throw remoteDesktopError(code, message);
			}
			const updated = await this.deps.prisma.remoteDesktopSession.update({
				where: { id: sessionId },
				data: {
					status: "ready",
					displaysJson: JSON.stringify(displays),
					selectedDisplayId: displays.find((display) => display.primary)?.id ?? displays[0]?.id ?? null,
					hostGeneration: response.hostGeneration,
				},
			});
			// SAFETY: this update returns the same Prisma model row shape as the projection contract.
			return toRemoteDesktopSessionInfo(updated as unknown as RemoteDesktopSessionRecord);
		});
	}

	private async markError(sessionId: string, code: string, message: string): Promise<void> {
		await this.deps.prisma.remoteDesktopSession.update({
			where: { id: sessionId },
			data: {
				status: "error",
				safeErrorCode: code,
				safeErrorMessage: message,
				endedAt: new Date(this.now()),
			},
		});
	}

	async getSession(clientId: string, sessionId: string): Promise<RemoteDesktopSessionInfo> {
		return toRemoteDesktopSessionInfo(await this.sessionRow(clientId, sessionId));
	}

	async listSessions(
		clientId: string,
		page = 1,
		pageSize = 20,
	): Promise<PaginatedResult<RemoteDesktopSessionInfo>> {
		const where = { clientId };
		const [list, total] = await Promise.all([
			this.deps.prisma.remoteDesktopSession.findMany({
				where,
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			this.deps.prisma.remoteDesktopSession.count({ where }),
		]);
		return {
			data: list.map((row) => {
				// SAFETY: each row is a Prisma RemoteDesktopSession model row; projection validates persisted enums and JSON.
				return toRemoteDesktopSessionInfo(row as unknown as RemoteDesktopSessionRecord);
			}),
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize),
		};
	}

	async closeSession(
		clientId: string,
		sessionId: string,
		actor: ActorContext,
	): Promise<RemoteDesktopSessionInfo> {
		const row = await this.sessionRow(clientId, sessionId);
		if (TERMINAL_SESSION_STATUSES.has(row.status)) {
			return toRemoteDesktopSessionInfo(row);
		}
		const lease = await this.requireClientLease(clientId);
		let response: RemoteDesktopClientResponse;
		try {
			response = parseRemoteDesktopClientResponse(
				await this.deps.broker.request(lease, {
					requestId: `rdc_${randomUUID()}`,
					protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
					action: "session.close",
					sessionId,
				}),
			);
		} catch (error) {
			throw remoteDesktopError(
				typeof (error as { code?: unknown }).code === "string"
					? (error as { code: string }).code
					: "REMOTE_DESKTOP_HOST_OFFLINE",
				safeRemoteDesktopErrorMessage((error as Error).message),
			);
		}
		if (!response.ok) {
			throw remoteDesktopError(
				response.error?.code ?? "REMOTE_DESKTOP_PROTOCOL_MISMATCH",
				safeRemoteDesktopErrorMessage(response.error?.message),
			);
		}
		const updated = await this.deps.prisma.remoteDesktopSession.update({
			where: { id: sessionId },
			data: { status: "closed", endedAt: new Date(this.now()) },
		});
		await this.recordAudit({
			sessionId,
			clientId,
			event: "session.closed",
			identityId: actor.identityId,
			actorName: actor.displayName,
			attachmentId: null,
			role: null,
			result: "ok",
		});
		// SAFETY: this update returns the same Prisma model row shape as the projection contract.
		return toRemoteDesktopSessionInfo(updated as unknown as RemoteDesktopSessionRecord);
	}

	private async markSessionStatus(
		sessionId: string,
		status: "connecting" | "connected" | "detached" | "closed" | "interrupted" | "error",
		fields: Record<string, unknown> = {},
	): Promise<void> {
		await this.deps.prisma.remoteDesktopSession.update({
			where: { id: sessionId },
			data: { status, ...fields },
		});
	}

	/** 最后一个 Browser 离开后通知 Host 进入 detached，并在 TTL 到期时关闭运行态。 */
	private afterBrowserDetached(runtime: RemoteDesktopSessionRuntime): void {
		if (runtime.attachments.size !== 0) return;
		if (runtime.detachedTimer) return;
		runtime.detachedTimer = this.setSessionTimer(() => {
			void this.closeDetachedRuntime(runtime.sessionId, runtime.clientId);
		}, RemoteDesktopLimits.detachedTtlMs);
		void this.requireClientLease(runtime.clientId)
			.then((lease) => this.hostRequest(runtime.clientId, lease.socketId, {
				requestId: `rdc_${randomUUID()}`,
				protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
				action: "session.detach",
				sessionId: runtime.sessionId,
			}))
			.catch(() => undefined);
	}

	private async closeDetachedRuntime(sessionId: string, clientId: string): Promise<void> {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime || runtime.attachments.size !== 0) return;
		try {
			const lease = await this.requireClientLease(clientId);
			await this.hostRequest(clientId, lease.socketId, {
				requestId: `rdc_${randomUUID()}`,
				protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
				action: "session.close",
				sessionId,
			});
		} catch {
			// Host lease 已失效时由本地 watchdog 负责释放资源。
		}
		await this.markSessionStatus(sessionId, "closed", { endedAt: new Date(this.now()) });
		this.clearRuntime(sessionId);
	}

	private clearRuntime(sessionId: string): void {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime) return;
		runtime.detachedTimer = this.clearTimer(runtime.detachedTimer);
		runtime.clientDisconnectTimer = this.clearTimer(runtime.clientDisconnectTimer);
		for (const attachment of runtime.attachments.values()) {
			this.signaling.reset(attachment.attachmentId);
		}
		this.runtimes.delete(sessionId);
	}

	private attachmentOf(
		sessionId: string,
		attachmentId: string,
		socketId: string,
	): { runtime: RemoteDesktopSessionRuntime; attachment: RemoteDesktopAttachmentRuntime } {
		const runtime = this.runtimes.get(sessionId);
		const attachment = runtime?.attachments.get(attachmentId);
		if (!runtime || !attachment || attachment.socketId !== socketId) {
			throw remoteDesktopError("REMOTE_DESKTOP_NO_ACTIVE_SESSION", "Remote Desktop attachment not found");
		}
		return { runtime, attachment };
	}

	private async attachHost(
		runtime: RemoteDesktopSessionRuntime,
		attachment: RemoteDesktopAttachmentRuntime,
	): Promise<void> {
		const lease = await this.requireClientLease(runtime.clientId);
		await this.hostRequest(runtime.clientId, lease.socketId, {
			requestId: `rdc_${randomUUID()}`,
			protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
			action: "session.attach",
			sessionId: runtime.sessionId,
			payload: { attachmentId: attachment.attachmentId, role: attachment.role },
		});
	}

	/** Browser attach：首个 attachment 为 operator，保护期内的新连接只能 viewer。 */
	async attachBrowser(args: {
		clientId?: string;
		sessionId: string;
		actor: ActorContext;
		socketId: string;
		reconnectToken?: string;
	}): Promise<RemoteDesktopBrowserAttached> {
		const row = args.clientId
			? await this.sessionRow(args.clientId, args.sessionId)
			: await this.sessionRecordById(args.sessionId);
		if (TERMINAL_SESSION_STATUSES.has(row.status)) {
			throw remoteDesktopError("REMOTE_DESKTOP_NO_ACTIVE_SESSION", "Remote Desktop session is not active");
		}
		const runtime = this.runtime(row.id, row.clientId);
		// 同一操作者对同一会话重复 attach（包括页面刷新后 socketId 变化）必须幂等：
		// 就地接管既有 attachment，不新建、不向 Host 重复 attach。
		//
		// 按 socketId 判定不够：刷新页面会换 socketId，于是 Server 新建 attachment
		// 并抛出 operator 请求，而 Host 侧同一会话已有 operator（旧 attachment 会一直
		// 留到显式释放），于是 Host 分配 viewer → 角色冲突 → attach 失败 →
		// 浏览器永远拿不到 answer，停在 have-local-offer。
		const existing = [...runtime.attachments.values()].find(
			(candidate) => candidate.identityId === args.actor.identityId,
		);
		if (existing) {
			// 接管：socket 换了就把归属改成新 socket，PeerConnection 由新 offer 重建。
			existing.socketId = args.socketId;
			// 必须重置信令预算：重连一定是新的 PeerConnection，因此必然要发新的 offer，
			// 而预算里的 `browserOfferSeen` 会把第二个 offer 当成“重复 offer”拒掉，
			// 浏览器就永远停在 have-local-offer 等一个不会来的 answer。
			this.signaling.reset(existing.attachmentId);
			// 返回的 token 必须与落库的 hash 一致，否则调用方拿到的 token 无法用于重连。
			const token = args.reconnectToken ?? `rdt_${randomUUID()}`;
			if (!args.reconnectToken) existing.reconnectTokenHash = sha256(token);
			return {
				sessionId: row.id,
				attachmentId: existing.attachmentId,
				role: existing.role,
				reconnectToken: token,
				controlProtectedUntil: runtime.protectedUntil
					? new Date(runtime.protectedUntil).toISOString()
					: null,
				iceConfig: this.iceConfig.forAttachment(
					existing.attachmentId,
					args.actor.displayName,
				),
			};
		}
		for (const [oldId, oldAttachment] of runtime.attachments) {
			if (oldAttachment.socketId !== args.socketId) continue;
			runtime.attachments.delete(oldId);
			this.signaling.reset(oldId);
			if (runtime.operatorAttachmentId === oldId) runtime.operatorAttachmentId = null;
		}
		if (runtime.attachments.size >= RemoteDesktopLimits.maxAttachments) {
			throw remoteDesktopError("REMOTE_DESKTOP_ATTACHMENT_LIMIT", "Remote Desktop attachment limit reached");
		}
		const now = this.now();
		const reconnectHash = args.reconnectToken ? sha256(args.reconnectToken) : null;
		const canReconnect = reconnectHash !== null &&
			runtime.operatorAttachmentId === null &&
			runtime.protectedTokenHash === reconnectHash &&
			runtime.protectedIdentityId === args.actor.identityId &&
			now < (runtime.protectedUntil ?? 0);
		const role: RemoteDesktopRole = canReconnect ||
			(runtime.operatorAttachmentId === null && now >= (runtime.protectedUntil ?? 0))
			? "operator"
			: "viewer";
		const attachmentId = `rda_${randomUUID()}`;
		const reconnectToken = args.reconnectToken ?? `rdt_${randomUUID()}`;
		const attachment: RemoteDesktopAttachmentRuntime = {
			attachmentId,
			sessionId: row.id,
			clientId: row.clientId,
			socketId: args.socketId,
			identityId: args.actor.identityId,
			actorName: args.actor.displayName,
			role,
			reconnectTokenHash: sha256(reconnectToken),
			attachedAt: now,
		};
		runtime.attachments.set(attachmentId, attachment);
		if (role === "operator") {
			runtime.operatorAttachmentId = attachmentId;
			runtime.protectedUntil = null;
			runtime.protectedTokenHash = null;
			runtime.protectedIdentityId = null;
		}
		try {
			await this.attachHost(runtime, attachment);
			await this.markSessionStatus(row.id, "connecting", { detachedAt: null });
			runtime.detachedTimer = this.clearTimer(runtime.detachedTimer);
			runtime.inputFrozen = false;
		} catch (error) {
			runtime.attachments.delete(attachmentId);
			if (runtime.operatorAttachmentId === attachmentId) runtime.operatorAttachmentId = null;
			throw remoteDesktopError(
				typeof (error as { code?: unknown }).code === "string"
					? (error as { code: string }).code
					: "REMOTE_DESKTOP_HOST_OFFLINE",
				safeRemoteDesktopErrorMessage((error as Error).message),
			);
		}
		await this.recordAudit({
			sessionId: row.id,
			clientId: row.clientId,
			event: canReconnect ? "operator.reconnected" : "attachment.connected",
			identityId: args.actor.identityId,
			actorName: args.actor.displayName,
			attachmentId,
			role,
			result: "ok",
		});
		return {
			sessionId: row.id,
			attachmentId,
			role,
			reconnectToken,
			controlProtectedUntil: runtime.protectedUntil ? new Date(runtime.protectedUntil).toISOString() : null,
			iceConfig: this.iceConfig.forAttachment(attachmentId, args.actor.displayName),
		};
	}

	private async sessionRecordById(sessionId: string): Promise<RemoteDesktopSessionRecord> {
		const row = await this.deps.prisma.remoteDesktopSession.findUnique({ where: { id: sessionId } });
		if (!row) throw remoteDesktopError("REMOTE_DESKTOP_NO_ACTIVE_SESSION", "Remote Desktop session not found");
		return this.asSessionRecord(row);
	}

	private asSessionRecord(row: unknown): RemoteDesktopSessionRecord {
		// SAFETY: Prisma has returned a RemoteDesktopSession row; projection validates all persisted fields before exposure.
		return row as unknown as RemoteDesktopSessionRecord;
	}

	/** Browser 显式 detach；socket 归属不匹配时 fail closed。 */
	async detachBrowser(args: { socketId: string; sessionId: string; attachmentId: string }): Promise<void> {
		const runtime = this.runtimes.get(args.sessionId);
		const attachment = runtime?.attachments.get(args.attachmentId);
		if (!runtime || !attachment || attachment.socketId !== args.socketId) return;
		runtime.attachments.delete(args.attachmentId);
		this.signaling.reset(args.attachmentId);
		// 必须通知 Host 释放该 attachment。否则 Host 会继续把本会话的旧 attachment
		// 当作 operator，而 Server 已清空自己的 attachment 表；下次 attach 时 Server
		// 请求 operator、Host 却分配 viewer，角色一致性校验（防提权）会直接拒绝，
		// 浏览器就再也拿不到 answer（只能停在 have-local-offer）。
		try {
			const lease = await this.requireClientLease(runtime.clientId);
			await this.hostRequest(runtime.clientId, lease.socketId, {
				requestId: `rdc_${randomUUID()}`,
				protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
				action: "session.detach",
				sessionId: args.sessionId,
				payload: { attachmentId: args.attachmentId },
			});
		} catch {
			// Host 不可达时仍然收敛 Server 元数据；Host 侧由自身 watchdog 释放。
		}
		if (runtime.operatorAttachmentId === args.attachmentId) {
			runtime.operatorAttachmentId = null;
			runtime.protectedUntil = this.now() + RemoteDesktopLimits.reconnectGraceMs;
			runtime.protectedTokenHash = attachment.reconnectTokenHash;
			runtime.protectedIdentityId = attachment.identityId;
		}
		await this.recordAudit({
			sessionId: args.sessionId,
			clientId: runtime.clientId,
			event: "session.interrupted",
			identityId: attachment.identityId,
			actorName: attachment.actorName,
			attachmentId: attachment.attachmentId,
			role: attachment.role,
			result: "ok",
			reason: "browser-detached",
		});
		if (runtime.attachments.size === 0) {
			await this.markSessionStatus(args.sessionId, "detached", { detachedAt: new Date(this.now()) });
			this.afterBrowserDetached(runtime);
		}
	}

	/** Browser socket 断开时移除其全部 attachment。 */
	async detachBrowserSocket(socketId: string): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			for (const [attachmentId, attachment] of [...runtime.attachments]) {
				if (attachment.socketId === socketId) {
					await this.detachBrowser({ socketId, sessionId: runtime.sessionId, attachmentId });
				}
			}
		}
	}

	/** Browser 信令经过 attachment 归属、方向、频率和累计预算校验后才投递给 Host。 */
	async browserSignal(args: { socketId: string; sessionId: string; attachmentId: string; signal: RemoteDesktopSignal }): Promise<void> {
		const { runtime, attachment } = this.attachmentOf(args.sessionId, args.attachmentId, args.socketId);
		const signal = parseRemoteDesktopSignal(args.signal);
		this.signaling.acceptBrowserSignal(attachment.attachmentId, signal);
		const lease = await this.requireClientLease(runtime.clientId);
		const response = await this.hostRequest(runtime.clientId, lease.socketId, {
			requestId: `rdc_${randomUUID()}`,
			protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
			action: "session.signal",
			sessionId: runtime.sessionId,
			payload: { attachmentId: attachment.attachmentId, signal },
		});
		const returned = response.result?.signal;
		if (returned === undefined) return;
		const hostSignal = parseRemoteDesktopSignal(returned);
		this.signaling.acceptHostSignal(attachment.attachmentId, hostSignal);
		this.emitBrowser(attachment.socketId, "remote-desktop:signal", {
			sessionId: runtime.sessionId,
			attachmentId: attachment.attachmentId,
			signal: hostSignal,
		});
	}

	/** 保护期结束后，viewer 通过显式 takeover 原子取得 operator。 */
	async browserTakeover(args: { socketId: string; sessionId: string; attachmentId: string }): Promise<{ role: "operator" }> {
		const { runtime, attachment } = this.attachmentOf(args.sessionId, args.attachmentId, args.socketId);
		if (runtime.operatorAttachmentId !== null) {
			throw remoteDesktopError("REMOTE_DESKTOP_TAKEOVER_CONFLICT", "Another operator holds control");
		}
		if (this.now() < (runtime.protectedUntil ?? 0)) {
			throw remoteDesktopError("REMOTE_DESKTOP_TAKEOVER_CONFLICT", "Operator reconnect is protected");
		}
		const lease = await this.requireClientLease(runtime.clientId);
		await this.hostRequest(runtime.clientId, lease.socketId, {
			requestId: `rdc_${randomUUID()}`,
			protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
			action: "session.resume-input",
			sessionId: runtime.sessionId,
			payload: { attachmentId: attachment.attachmentId },
		});
		runtime.operatorAttachmentId = attachment.attachmentId;
		attachment.role = "operator";
		runtime.inputFrozen = false;
		runtime.protectedUntil = null;
		runtime.protectedTokenHash = null;
		runtime.protectedIdentityId = null;
		await this.recordAudit({
			sessionId: runtime.sessionId,
			clientId: runtime.clientId,
			event: "operator.taken_over",
			identityId: attachment.identityId,
			actorName: attachment.actorName,
			attachmentId: attachment.attachmentId,
			role: "operator",
			result: "ok",
		});
		return { role: "operator" };
	}

	/** Client 连接租约失效时立即冻结输入，30 秒后关闭 Host 会话。 */
	async handleClientDisconnect(clientId: string, socketId: string): Promise<void> {
		const client = await this.deps.prisma.client.findUnique({ where: { id: clientId }, select: { socketId: true } });
		if (client?.socketId && client.socketId !== socketId) return;
		for (const runtime of this.runtimes.values()) {
			if (runtime.clientId !== clientId) continue;
			runtime.inputFrozen = true;
			void this.deps.broker.request({ clientId, socketId }, {
				requestId: `rdc_${randomUUID()}`,
				protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
				action: "session.freeze-input",
				sessionId: runtime.sessionId,
			}).catch(() => undefined);
			runtime.clientDisconnectTimer = this.clearTimer(runtime.clientDisconnectTimer);
			runtime.clientDisconnectTimer = this.setSessionTimer(() => {
				void this.closeRuntimeAfterLease(runtime.sessionId, clientId, socketId);
			}, RemoteDesktopLimits.leaseTimeoutMs);
		}
	}

	private async closeRuntimeAfterLease(sessionId: string, clientId: string, socketId: string): Promise<void> {
		const runtime = this.runtimes.get(sessionId);
		if (!runtime || !runtime.inputFrozen) return;
		try {
			await this.hostRequest(clientId, socketId, {
				requestId: `rdc_${randomUUID()}`,
				protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
				action: "session.close",
				sessionId,
			});
		} catch {
			// 连接已断开时仍然收敛 Server 元数据，Host 会在本地 watchdog 中释放资源。
		}
		await this.markSessionStatus(sessionId, "interrupted", {
			endedAt: new Date(this.now()),
			safeErrorCode: "REMOTE_DESKTOP_HOST_OFFLINE",
			safeErrorMessage: "Desktop Host lease expired",
		});
		this.clearRuntime(sessionId);
	}

	/** Client 上报状态并将 Server 持久化状态与 Desktop Host 权威状态收敛。 */
	async handleClientState(
		clientId: string,
		socketId: string,
		report: RemoteDesktopStateReport,
	): Promise<RemoteDesktopStateAck> {
		const client = await this.deps.prisma.client.findUnique({ where: { id: clientId }, select: { socketId: true } });
		if (!client || client.socketId !== socketId || report.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION) {
			return { accepted: false, action: "none" };
		}

		const activeRows = report.sessionId
			? []
			: await this.deps.prisma.remoteDesktopSession.findMany({
					where: { clientId, status: { in: ACTIVE_SESSION_STATUSES } },
				});
		if (!report.sessionId) {
			if (report.status === "idle" || report.status === "closed" || report.status === "error") {
				for (const row of activeRows) {
					await this.deps.prisma.remoteDesktopSession.update({
						where: { id: row.id },
						data: {
							status: "interrupted",
							endedAt: new Date(this.now()),
							safeErrorCode: report.safeErrorCode ?? "REMOTE_DESKTOP_HOST_OFFLINE",
							safeErrorMessage: "Desktop Host reported no active session",
						},
					});
					this.clearRuntime(row.id);
				}
				return activeRows.length > 0
					? { accepted: true, action: "interrupted" }
					: { accepted: true, action: "none" };
			}
			return { accepted: true, action: "none" };
		}

		const row = await this.deps.prisma.remoteDesktopSession.findUnique({ where: { id: report.sessionId } });
		if (!row || row.clientId !== clientId) return { accepted: false, action: "none" };
		if (row.hostGeneration && row.hostGeneration !== report.hostGeneration) {
			await this.deps.prisma.remoteDesktopSession.update({
				where: { id: row.id },
				data: {
					status: "interrupted",
					endedAt: new Date(this.now()),
					safeErrorCode: "REMOTE_DESKTOP_PROTOCOL_MISMATCH",
					safeErrorMessage: "Desktop Host generation changed",
				},
			});
			this.clearRuntime(row.id);
			return { accepted: true, action: "interrupted" };
		}

		const runtime = this.runtimes.get(row.id);
		if (runtime?.clientDisconnectTimer) {
			runtime.clientDisconnectTimer = this.clearTimer(runtime.clientDisconnectTimer);
		}
		if (runtime) runtime.inputFrozen = report.status === "frozen";
		if (report.status === "closed") {
			await this.markSessionStatus(row.id, "closed", {
				endedAt: new Date(this.now()),
				hostGeneration: report.hostGeneration,
			});
			this.clearRuntime(row.id);
			return { accepted: true, action: "close" };
		}
		if (report.status === "error") {
			await this.markSessionStatus(row.id, "error", {
				endedAt: new Date(this.now()),
				hostGeneration: report.hostGeneration,
				safeErrorCode: report.safeErrorCode ?? "REMOTE_DESKTOP_HOST_OFFLINE",
				safeErrorMessage: "Desktop Host reported an error",
			});
			this.clearRuntime(row.id);
			return { accepted: true, action: "interrupted" };
		}

		const status = report.status === "connected" ? "connected" : "connecting";
		await this.markSessionStatus(row.id, status, { hostGeneration: report.hostGeneration });
		return { accepted: true, action: "reconcile" };
	}
}
