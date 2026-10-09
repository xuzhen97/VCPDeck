import {
	BadGatewayException,
	BadRequestException,
	ConflictException,
	Controller,
	Delete,
	Get,
	Inject,
	Optional,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
	Body,
	HttpCode,
	Sse,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	isPiWorkerAction,
	isPiAgentIdle,
	isPiThinkingLevel,
	parsePiAgentState,
	assertSourceName,
	parsePiImportListResponse,
	parsePiImportPreviewResponse,
	parsePiImportRunRequest,
	parsePiImportRunResponse,
	isPiToolExecutionMode,
	PI_ERROR_CODES,
	PI_SESSION_PROTOCOL_VERSION,
	parsePiExtensionCommands,
	parsePiExtensionUiSnapshot,
	type ActorContext,
	type PiAttachmentDescriptor,
	type PiCwdRef,
	type PiExtensionCommands,
	type PiExtensionUiSnapshot,
	type PaginatedResult,
	type PiAuditEventInfo,
	type PiPromptAccepted,
	type PiRequest,
	type PiRunInfo,
	type PiRuntimeStatus,
	type PiResponse,
	type PiSessionCreated,
	type PiSessionSnapshot,
	type PiSessionOpenResult,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { ClientService } from "../client/client.service.js";
import { PiEventBroker } from "./pi-event-broker.js";
import {
	PiRequestBroker,
	type PiGenerationLease,
} from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
import { PiSessionService } from "./pi-session.service.js";
import { PiRuntimeService } from "./pi-runtime.service.js";
import { PiAttachmentService } from "./pi-attachment.service.js";

/** 把 Client 返回的 code 收敛到已登记错误码,未知值不进入审计。 */
function safeErrorCode(code: string): import("@vcpdeck/shared").PiErrorCode {
	return (PI_ERROR_CODES as readonly string[]).includes(code)
		? (code as import("@vcpdeck/shared").PiErrorCode)
		: "PI_PROTOCOL_INVALID";
}

/**
 * 取服务端错误里已登记的 Pi 错误码:服务层抛的是 Error+code,
 * 控制器 badRequest 抛的是 HttpException(response.code),两者都要认。
 * 未登记的 code 返回 undefined,不把原始值写进审计。
 */
function piErrorCodeOf(error: unknown): import("@vcpdeck/shared").PiErrorCode | undefined {
	const direct =
		error instanceof Error && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	const fromResponse = (error as { response?: { code?: unknown } } | null)?.response?.code;
	const raw =
		typeof direct === "string"
			? direct
			: typeof fromResponse === "string"
				? fromResponse
				: undefined;
	return raw && (PI_ERROR_CODES as readonly string[]).includes(raw)
		? (raw as import("@vcpdeck/shared").PiErrorCode)
		: undefined;
}

function badRequest(code: string, message: string): BadRequestException {
	return new BadRequestException({ code, message });
}

function isPiError(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error &&
		typeof error.code === "string" &&
		(PI_ERROR_CODES as readonly string[]).includes(error.code);
}

function requireObject(body: unknown): asserts body is Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw badRequest("PI_PROTOCOL_INVALID", "body must be an object");
	}
}

function requireCwd(body: unknown): PiCwdRef {
	requireObject(body);
	if (typeof body.rootDir !== "string" || typeof body.relativePath !== "string") {
		throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
	}
	return { rootDir: body.rootDir, relativePath: body.relativePath };
}

function optionalRunId(body: unknown): string | undefined {
	requireObject(body);
	if (body.runId === undefined) return undefined;
	if (typeof body.runId !== "string" || body.runId.length === 0 || body.runId.length > 256) {
		throw badRequest("PI_PROTOCOL_INVALID", "invalid runId");
	}
	return body.runId;
}

function requiredRunId(body: unknown): string {
	const runId = optionalRunId(body);
	if (runId === undefined) throw badRequest("PI_PROTOCOL_INVALID", "runId required");
	return runId;
}

/** 机器命名空间的远程 Pi REST/SSE 接口 */
@Controller("api/clients/:clientId/pi")
export class PiController {
	constructor(
		@Inject(PiRequestBroker) private readonly requests: PiRequestBroker,
		@Inject(PiEventBroker) private readonly events: PiEventBroker,
		@Inject(PiRunService) private readonly runs: PiRunService,
		@Inject(PiSessionService) private readonly sessionsService: PiSessionService,
		@Inject(ClientService) private readonly clients: ClientService,
		@Inject(PiAttachmentService) private readonly attachments: PiAttachmentService,
		// RuntimeSpec 就绪门控（可选注入：旧测试构造保持兼容）
		@Optional()
		@Inject(PiRuntimeService)
		private readonly runtime?: PiRuntimeService,
	) {}

	// ── helpers ──

	private async requirePiClient(clientId: string): Promise<void> {
		const online = await this.clients.listOnline();
		const client = online.find((c) => c.clientId === clientId);
		if (!client) {
			throw new NotFoundException({
				code: "PI_CLIENT_DISCONNECTED",
				message: `Client "${clientId}" is offline or unknown`,
			});
		}
		if (
			!client.capabilities.includes("agent.pi") ||
			client.capabilityDetails.pi?.available !== true ||
			client.capabilityDetails.pi.sessionProtocolVersion !== PI_SESSION_PROTOCOL_VERSION
		) {
			throw badRequest(
				"PI_CLIENT_UNSUPPORTED",
				`Client "${clientId}" does not support Pi`,
			);
		}
	}

	/**
	 * 上游（Client）响应的严格解析：失败按 502 稳定映射，
	 * 不回显上游数据（跨信任边界出口必须严格校验）。
	 */
	private parseUpstream<T>(
		what: string,
		data: unknown,
		parse: (value: unknown) => T,
	): T {
		try {
			return parse(data);
		} catch {
			throw new BadGatewayException({
				code: "PI_PROTOCOL_INVALID",
				message: `${what} 返回了不合法的 Pi 响应`,
			});
		}
	}

	/** 在单一 ready generation 内执行 REST 编排，并稳定映射 broker/generation 错误。 */
	private async withReconciledClient<T>(
		clientId: string,
		operation: (lease: PiGenerationLease) => Promise<T>,
	): Promise<T> {
		try {
			return await this.runs.withReconciledClient(clientId, operation);
		} catch (err) {
			if (isPiError(err)) {
				throw badRequest(err.code, err.message);
			}
			throw err;
		}
	}

	/** 使用已有 generation lease 解析不透明 projectKey（不持久化）。 */
	private async resolveProjectKey(
		lease: PiGenerationLease,
		cwdRef: PiCwdRef,
	): Promise<string> {
		this.runtime?.assertCompatible(lease.clientId);
		const response = await this.requests.request(lease, {
			requestId: randomUUID(),
			action: "project.resolve",
			cwdRef,
		});
		if (!response.ok) {
			throw badRequest(response.error.code, response.error.message);
		}
		return (response.data as { projectKey: string }).projectKey;
	}

	private async requestOnce(
		lease: PiGenerationLease,
		request: PiRequest,
	): Promise<unknown> {
		try {
			// 需要活跃 Worker 的动作必须先 ready（fail closed，不 fallback 本机 Pi）。
			if (this.runtime) {
				this.runtime.assertCompatible(lease.clientId);
				if (isPiWorkerAction(request.action)) this.runtime.assertReady(lease.clientId);
			} else {
				// 旧 Server 不具备隔离运行时门控时，所有 Pi action 均拒绝。
				throw badRequest("PI_CLIENT_UNSUPPORTED", "Pi 隔离运行时未启用");
			}
			const response = await this.requests.request(lease, request);
			if (!response.ok) {
				throw badRequest(response.error.code, response.error.message);
			}
			return response.data;
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				throw badRequest(String((err as { code: unknown }).code), err.message);
			}
			throw err;
		}
	}

	private requestForClient(clientId: string, request: PiRequest): Promise<unknown> {		return this.withReconciledClient(clientId, (lease) =>
			this.requestOnce(lease, request),
		);
	}

	/**
	 * 校验 prompt 携带的图片引用（File 行是权威），并把服务层稳定码映射为 HTTP 400。
	 * 调用方提供的 url/sha256 不回显、不信任。
	 */
	private async validatePromptImages(
		clientId: string,
		refs: unknown,
	): Promise<PiAttachmentDescriptor[]> {
		try {
			return await this.attachments.validatePromptRefs(clientId, refs);
		} catch (err) {
			if (isPiError(err)) throw badRequest(err.code, err.message);
			throw err;
		}
	}

	private async assertSessionOwner(sessionId: string, actor: ActorContext): Promise<void> {
		try {
			await this.sessionsService.assertSessionOwner(sessionId, actor.identityId);
		} catch (err) {
			if (isPiError(err)) throw badRequest(err.code, err.message);
			throw err;
		}
	}

	/** 控制当前回合:必须是 Owner,且 runId 指向会话当前活跃 Run。 */
	private async assertActiveOwner(sessionId: string, runId: string, actor: ActorContext): Promise<void> {
		try {
			await this.sessionsService.assertSessionOwner(sessionId, actor.identityId);
			const snapshot = await this.sessionsService.snapshot(sessionId, actor.identityId);
			if (!snapshot.activeRun || snapshot.activeRun.runId !== runId) {
				throw Object.assign(new Error("Run is no longer current"), {
					code: "PI_CONTROL_FORBIDDEN",
				});
			}
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				throw badRequest(
					String((err as { code: unknown }).code),
					err.message,
				);
			}
			throw err;
		}
	}

	private async assertIdle(clientId: string, projectKey: string): Promise<void> {
		try {
			await this.runs.assertIdleMutation(clientId, projectKey);
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				throw badRequest(
					String((err as { code: unknown }).code),
					err.message,
				);
			}
			throw err;
		}
	}

	// ── runtime 状态（诊断用，不需要 Pi ready） ──

	@Get("runtime")
	async runtimeStatus(@Param("clientId") clientId: string): Promise<PiRuntimeStatus> {
		if (this.runtime) return this.runtime.status(clientId);
		// 未注入（旧测试构造）时不得谎报 ready。
		return {
			clientId,
			specId: null,
			desiredRuntimeRevision: null,
			activeRuntimeRevision: null,
			configState: "pending",
			reasonCode: null,
			piSdkVersion: null,
			runtimeSpecProtocolVersion: null,
			providers: [],
			unavailableModels: [],
		};
	}

	// ── capability / models ──

	@Get("capability")
	async capability(@Param("clientId") clientId: string) {
		const online = await this.clients.listOnline();
		const client = online.find((c) => c.clientId === clientId);
		if (!client) {
			return {
				available: false,
				code: "PI_CLIENT_DISCONNECTED",
				message: `Client "${clientId}" is offline or unknown`,
			};
		}
		return (
			client.capabilityDetails.pi ?? {
				available: false,
				code: "PI_CLIENT_UNSUPPORTED",
				message: "Client 版本不支持 Pi",
			}
		);
	}

	@Get("models")
	async models(
		@Param("clientId") clientId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	) {
		await this.requirePiClient(clientId);
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "models.list",
			cwdRef: { rootDir, relativePath },
		});
		// Client 的 models.list 直接返回模型数组（不是 { models: [...] } 包壳）；
		// 按包壳取值会得到 undefined，导致 200 空响应、前端模型下拉永远为空。
		return data;
	}

	// ── sessions ──

	@Get("sessions")
	async sessions(
		@Param("clientId") clientId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	) {
		await this.requirePiClient(clientId);
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "sessions.list",
			cwdRef: { rootDir, relativePath },
		});
		const sessions = (data as { sessions: unknown[] }).sessions;
		// 控制状态来自 Server 的 AgentSession(归档/删除),只对本页有界 ID 合并;
		// 未登记的会话保持未归档,不因一次列表读取就创建 Owner。
		const ids = sessions
			.map((item) => (item as { id?: unknown }).id)
			.filter((id): id is string => typeof id === "string")
			.slice(0, 200);
		const controlStatus = await this.sessionsService.controlStatusFor(clientId, ids);
		return sessions.map((item) => {
			const id = (item as { id?: unknown }).id;
			const status = typeof id === "string" ? controlStatus.get(id) : undefined;
			return status ? { ...(item as Record<string, unknown>), controlStatus: status } : item;
		});
	}

	// ── 旧 Session 显式导入（ADR-0031；设计 §21.3）：
	// 必须注册在 `sessions/:sessionId` 之前，否则该两段路径会被参数路由吞掉。

	@Get("sessions/importable")
	async listImportable(@Param("clientId") clientId: string) {
		await this.requirePiClient(clientId);
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.import.list",
		});
		return this.parseUpstream("Client", data, parsePiImportListResponse);
	}

	@Get("sessions/importable/:sourceName/preview")
	async previewImportable(
		@Param("clientId") clientId: string,
		@Param("sourceName") sourceName: string,
	) {
		await this.requirePiClient(clientId);
		let safeName: string;
		try {
			safeName = assertSourceName(sourceName, "sourceName");
		} catch (err) {
			throw badRequest("PI_PROTOCOL_INVALID", (err as Error).message);
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.import.preview",
			payload: { sourceName: safeName },
		});
		return this.parseUpstream("Client", data, parsePiImportPreviewResponse);
	}

	@Post("sessions/import")
	async importSessions(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	) {
		await this.requirePiClient(clientId);
		let parsed: { sourceNames: string[] };
		try {
			parsed = parsePiImportRunRequest(body);
		} catch (err) {
			throw badRequest("PI_PROTOCOL_INVALID", (err as Error).message);
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.import.run",
			payload: { sourceNames: parsed.sourceNames },
		});
		const response = this.parseUpstream(
			"Client",
			data,
			parsePiImportRunResponse,
		);
		// ADR-0041 决策 4:导入是会话控制面操作,必须留下独立最小审计。
		// 只有实际存在于 VCPDeck 的副本才登记(imported / alreadyImported),
		// rejected 没有新会话;旧 Client 不上报 sessionId 时保持原样。
		for (const result of response.results) {
			if (result.status === "rejected" || !result.sessionId) continue;
			await this.sessionsService.ensureSession(actor, {
				clientId,
				sessionId: result.sessionId,
				event: "imported",
			});
		}
		return response;
	}

	@Get("sessions/:sessionId")
	async sessionDetail(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	) {
		await this.requirePiClient(clientId);
		return this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.get",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
	}

	@Get("sessions/:sessionId/context")
	async sessionContext(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
		@Query("leafId") leafId?: string,
		@Query("cursor") cursor?: string,
	) {
		await this.requirePiClient(clientId);
		return this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.context",
			cwdRef: { rootDir, relativePath },
			sessionId,
			payload: {
				...(leafId ? { leafId } : {}),
				...(cursor ? { cursor } : {}),
			},
		});
	}

	@Get("sessions/:sessionId/entries/:entryId/content")
	async entryContent(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Param("entryId") entryId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
		@Query("blockIndex") blockIndex?: string,
	) {
		await this.requirePiClient(clientId);
		return this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "session.entryContent",
			cwdRef: { rootDir, relativePath },
			sessionId,
			payload: {
				entryId,
				blockIndex: Number(blockIndex ?? 0),
			},
		});
	}

	@Patch("sessions/:sessionId")
	async renameSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; name?: string },
		@Actor() actor: ActorContext,
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, name } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof name !== "string" || name.trim() === "") {
			throw badRequest("PI_PROTOCOL_INVALID", "name required");
		}
		// 从侧边栏对未打开的会话改名/删/克隆等:必须先补控制面记录,再查 owner
		await this.sessionsService.ensureSession(actor, { clientId, sessionId });
		await this.assertSessionOwner(sessionId, actor);
		// 控制面变更必须与审计一致:先记"已请求",远端确认后才记成功。
		const operationId = randomUUID();
		await this.sessionsService.recordAudit({
			sessionId,
			clientId,
			event: "renamed",
			result: "requested",
			actor,
			operationId,
		});
		try {
			await this.withReconciledClient(clientId, async (lease) => {
				const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
				await this.assertIdle(clientId, projectKey);
				await this.requestOnce(lease, {
					requestId: randomUUID(),
					action: "session.rename",
					cwdRef: { rootDir, relativePath },
					sessionId,
					payload: { name },
				});
			});
		} catch (error) {
			// 超时/断线表示结果不确定,保留 requested 不宣称失败;其余记 failed。
			const code = piErrorCodeOf(error);
			if (code && code !== "PI_REQUEST_TIMEOUT" && code !== "PI_CLIENT_DISCONNECTED") {
				await this.sessionsService.recordAudit({
					sessionId,
					clientId,
					event: "renamed",
					result: "failed",
					actor,
					operationId,
					errorCode: code,
				});
			}
			throw error;
		}
		await this.sessionsService.recordAudit({
			sessionId,
			clientId,
			event: "renamed",
			result: "ok",
			actor,
			operationId,
		});
		return { ok: true };
	}

	@Delete("sessions/:sessionId")
	@HttpCode(200)
	async deleteSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string },
		@Actor() actor: ActorContext,
	) {
		await this.requirePiClient(clientId);
		const cwdRef = requireCwd(body);
		return this.withReconciledClient(clientId, async (lease) => {
			await this.sessionsService.ensureSession(actor, { clientId, sessionId });
			const reservation = await this.sessionsService.beginDelete(sessionId, actor.identityId, {
				actor,
			});
			this.runtime?.assertCompatible(lease.clientId);
			this.runtime?.assertReady(lease.clientId);
			let response: PiResponse;
			try {
				response = await this.requests.request(lease, {
					requestId: randomUUID(), action: "session.delete", cwdRef, sessionId,
				});
			} catch (error) {
				const code = error instanceof Error && "code" in error
					? String((error as { code: unknown }).code)
					: undefined;
				if (code === "PI_REQUEST_TIMEOUT" || code === "PI_CLIENT_DISCONNECTED") {
					throw badRequest(code, error instanceof Error ? error.message : code);
				}
				throw error;
			}
			if (response.ok || response.error.code === "PI_SESSION_NOT_FOUND") {
				await this.sessionsService.commitDelete(sessionId, reservation.deleteToken, { actor });
				return { ok: true };
			}
			if (["PI_PROTOCOL_INVALID", "PI_PROJECT_NOT_ALLOWED", "PI_PROJECT_BUSY"].includes(response.error.code)) {
				await this.sessionsService.rollbackDelete(sessionId, reservation.deleteToken, {
					actor,
					errorCode: response.error.code,
				});
				throw badRequest(response.error.code, response.error.message);
			}

			let confirmation: PiResponse;
			try {
				confirmation = await this.requests.request(lease, {
					requestId: randomUUID(), action: "session.get", cwdRef, sessionId,
				});
			} catch (error) {
				const code = error instanceof Error && "code" in error
					? String((error as { code: unknown }).code)
					: undefined;
				if (code === "PI_REQUEST_TIMEOUT" || code === "PI_CLIENT_DISCONNECTED") {
					throw badRequest(code, error instanceof Error ? error.message : code);
				}
				throw error;
			}
			if (!confirmation.ok && confirmation.error.code === "PI_SESSION_NOT_FOUND") {
				await this.sessionsService.commitDelete(sessionId, reservation.deleteToken, { actor });
				return { ok: true };
			}
			if (confirmation.ok) {
				await this.sessionsService.rollbackDelete(sessionId, reservation.deleteToken, {
					actor,
					errorCode: response.error.code,
				});
				throw badRequest(response.error.code, response.error.message);
			}
			throw badRequest(confirmation.error.code, confirmation.error.message);
		});
	}

	@Post("sessions/:sessionId/fork")
	async forkSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; messageId?: string },
		@Actor() actor: ActorContext,
	): Promise<PiSessionCreated> {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, messageId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof messageId !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "messageId required");
		}
		await this.assertSessionOwner(sessionId, actor);
		return this.withReconciledClient(clientId, async (lease) => {
			const cwdRef = { rootDir, relativePath };
			const projectKey = await this.resolveProjectKey(lease, cwdRef);
			await this.assertIdle(clientId, projectKey);
			const data = await this.requestOnce(lease, {
				requestId: randomUUID(), action: "session.fork", cwdRef, sessionId,
				payload: { messageId },
			});
			return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
		});
	}

	@Post("sessions/:sessionId/clone")
	async cloneSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string },
		@Actor() actor: ActorContext,
	): Promise<PiSessionCreated> {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		await this.assertSessionOwner(sessionId, actor);
		return this.withReconciledClient(clientId, async (lease) => {
			const cwdRef = { rootDir, relativePath };
			const projectKey = await this.resolveProjectKey(lease, cwdRef);
			await this.assertIdle(clientId, projectKey);
			const data = await this.requestOnce(lease, {
				requestId: randomUUID(), action: "session.clone", cwdRef, sessionId,
			});
			return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
		});
	}

	@Post("sessions/:sessionId/navigate")
	async navigateSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; targetId?: string },
		@Actor() actor: ActorContext,
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, targetId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof targetId !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "targetId required");
		}
		await this.assertSessionOwner(sessionId, actor);
		return this.withReconciledClient(clientId, async (lease) => {
			const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
			await this.assertIdle(clientId, projectKey);
			return this.requestOnce(lease, {
				requestId: randomUUID(),
				action: "session.navigate",
				cwdRef: { rootDir, relativePath },
				sessionId,
				payload: { targetId },
			});
		});
	}

	// ── agent ──

	private async ensureCreatedSession(
		lease: PiGenerationLease,
		actor: ActorContext,
		clientId: string,
		cwdRef: PiCwdRef,
		data: unknown,
	): Promise<PiSessionCreated> {
		const sessionId = (data as { sessionId?: unknown })?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw badRequest("PI_PROTOCOL_INVALID", "Client returned invalid sessionId");
		}
		let original: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await this.sessionsService.ensureSession(actor, { clientId, sessionId, event: "created" });
				return { sessionId };
			} catch (error) {
				original ??= error;
			}
		}
		try {
			await this.requestOnce(lease, { requestId: randomUUID(), action: "session.delete", cwdRef, sessionId });
		} catch { /* best effort; timeout/disconnect remains uncertain */ }
		throw original;
	}

	@Post("agent/new")
	async newSession(
		@Param("clientId") clientId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<PiSessionCreated> {
		await this.requirePiClient(clientId);
		const cwdRef = requireCwd(body);
		return this.withReconciledClient(clientId, async (lease) => {
			const data = await this.requestOnce(lease, { requestId: randomUUID(), action: "session.new", cwdRef });
			return this.ensureCreatedSession(lease, actor, clientId, cwdRef, data);
		});
	}

	@Post("agent/:sessionId/open")
	async openSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<PiSessionOpenResult> {
		await this.requirePiClient(clientId);
		const cwdRef = requireCwd(body);
		return this.withReconciledClient(clientId, async (lease) => {
			await this.requestOnce(lease, { requestId: randomUUID(), action: "session.get", cwdRef, sessionId });
			await this.sessionsService.ensureSession(actor, { clientId, sessionId });
			const snapshot = await this.sessionsService.snapshot(sessionId, actor.identityId);
			const activeRunId = snapshot.activeRun?.runId ?? null;
			const agentState = parsePiAgentState(await this.requestOnce(lease, {
				requestId: randomUUID(), action: "agent.state", cwdRef, sessionId,
				runId: activeRunId ?? undefined,
			}));
			if (activeRunId) await this.runs.reconcileOpen(sessionId, activeRunId, agentState);
			return { snapshot: await this.sessionsService.snapshot(sessionId, actor.identityId), agentState };
		});
	}

	@Post("agent/:sessionId/execution-mode")
	async setExecutionMode(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<PiSessionSnapshot> {
		await this.requirePiClient(clientId);
		requireObject(body);
		if (typeof body.rootDir !== "string" || typeof body.relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (body.mode !== null && !isPiToolExecutionMode(body.mode)) {
			throw badRequest("PI_PROTOCOL_INVALID", "mode must be supervised, automatic, or null");
		}
		return this.withReconciledClient(clientId, async (lease) => {
			if (Object.keys(body).some((key) => !["rootDir", "relativePath", "mode"].includes(key))) {
				throw badRequest("PI_PROTOCOL_INVALID", "unknown execution-mode field");
			}
			const cwdRef = { rootDir: body.rootDir as string, relativePath: body.relativePath as string };
			const projectKey = await this.resolveProjectKey(lease, cwdRef);
			await this.assertIdle(clientId, projectKey);
			const response = await this.requestOnce(lease, {
				requestId: randomUUID(), action: "session.get", cwdRef, sessionId,
			});
			if (!response || typeof response !== "object" || !("info" in response)
				|| typeof response.info !== "object" || response.info === null
				|| !("id" in response.info) || response.info.id !== sessionId) {
				throw new NotFoundException({ code: "PI_SESSION_NOT_FOUND", message: "Pi session was not found in the selected project" });
			}
			await this.sessionsService.ensureSession(actor, { clientId, sessionId });
			const session = await this.sessionsService.snapshot(sessionId, actor.identityId);
			if (!session.isOwner) throw badRequest("PI_CONTROL_FORBIDDEN", "Only the session owner can change execution mode");
			return this.sessionsService.setExecutionMode(actor, {
				clientId, sessionId, mode: body.mode as PiToolExecutionMode | null,
			});
		});
	}

	/**
	 * 旧"完成会话"入口:ADR-0041 已移除会话完成语义。
	 * 明确拒绝而不是静默映射为归档或 Run 成功,避免旧调用方误判执行结果:
	 * 整理会话用 /archive 与 /restore;停止本轮用 /abort。
	 */
	@Post("agent/:sessionId/complete")
	async completeSession(
		@Param("clientId") clientId: string,
	): Promise<never> {
		await this.requirePiClient(clientId);
		throw badRequest(
			"PI_PROTOCOL_INVALID",
			"Session completion was removed (ADR-0041); use /archive, /restore or /abort",
		);
	}

	// ── 独立会话控制面:快照、归档/恢复、Run 与审计查询(不需要 Client 在线) ──

	@Get("agent/:sessionId/snapshot")
	async sessionSnapshot(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<PiSessionSnapshot> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.snapshot(sessionId, actor.identityId);
	}

	@Post("agent/:sessionId/archive")
	async archiveSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<PiSessionSnapshot> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.setArchived(actor, { clientId, sessionId, archived: true });
	}

	@Post("agent/:sessionId/restore")
	async restoreSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Actor() actor: ActorContext,
	): Promise<PiSessionSnapshot> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.setArchived(actor, { clientId, sessionId, archived: false });
	}

	@Get("agent/:sessionId/runs")
	async listRuns(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	): Promise<PaginatedResult<PiRunInfo>> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.listRuns(sessionId, {
			...(page !== undefined ? { page: Number(page) } : {}),
			...(pageSize !== undefined ? { pageSize: Number(pageSize) } : {}),
		});
	}

	@Get("agent/:sessionId/runs/:runId")
	async runInfo(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Param("runId") runId: string,
	): Promise<PiRunInfo> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.runInfo(sessionId, runId);
	}

	@Get("agent/:sessionId/audit")
	async listAudit(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("page") page?: string,
		@Query("pageSize") pageSize?: string,
	): Promise<PaginatedResult<PiAuditEventInfo>> {
		await this.sessionsService.requireClientSession(sessionId, clientId);
		return this.sessionsService.listAudit(sessionId, {
			...(page !== undefined ? { page: Number(page) } : {}),
			...(pageSize !== undefined ? { pageSize: Number(pageSize) } : {}),
		});
	}

	@Get("agent/:sessionId")
	async agentState(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	) {
		await this.requirePiClient(clientId);
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		return this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "agent.state",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
	}

	@Post("agent/:sessionId")
	async prompt(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body()
		body: {
			rootDir?: string;
			relativePath?: string;
			type?: string;
			submissionId?: string;
			prompt?: string;
			images?: unknown[];
		},
		@Actor() actor: ActorContext,
	): Promise<PiPromptAccepted> {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, type, submissionId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (type !== "prompt") {
			throw badRequest("PI_PROTOCOL_INVALID", "type must be 'prompt'");
		}
		if (typeof submissionId !== "string" || submissionId.length === 0) {
			throw badRequest("PI_PROTOCOL_INVALID", "submissionId required");
		}
		if (typeof body.prompt !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "prompt required");
		}
		// 图片引用以 Server 侧的 File 行为权威；空文本只有在至少一张有效图片时才合法（ADR-0035），
		// 且调用方提供的描述符一律换成服务端签发值。校验必须在创建 Run 之前完成。
		const images = body.images === undefined
			? []
			: await this.validatePromptImages(clientId, body.images);
		if (body.prompt.trim() === "" && images.length === 0) {
			throw badRequest("PI_PROTOCOL_INVALID", "prompt or images required");
		}

		return this.withReconciledClient(clientId, (lease) =>
			this.admitAndDispatch(lease, actor, {
				clientId,
				sessionId,
				cwdRef: { rootDir, relativePath },
				submissionId,
				action: "agent.prompt",
				payload: (executionMode) => ({
					prompt: body.prompt,
					submissionId,
					executionMode,
					...(images.length > 0 ? { attachments: images } : {}),
				}),
			}),
		);
	}


	/**
	 * 接纳一个新 Run 并分发一次动作。
	 *
	 * prompt 与扩展命令共用同一条 Run 生命周期（ADR-0040 决策 2）：复用项目互斥、
	 * 取消、重连对账与结算，不建立独立的后台命令通道。调用方**不得**自带 runId，
	 * 否则会绕过项目互斥与结算对账。
	 */
	private async admitAndDispatch(
		lease: PiGenerationLease,
		actor: ActorContext,
		params: {
			clientId: string;
			sessionId: string;
			cwdRef: PiCwdRef;
			submissionId: string;
			action: PiRequest["action"];
			payload: (executionMode: PiToolExecutionMode) => Record<string, unknown>;
			/**
			 * 判定动作是否被拒绝。Client 对已注册但失败的命令返回 `{ok:false}` 而非
			 * transport 错误，必须在此翻成稳定 HTTP 错误，否则调用方会看到 200
			 * 却什么都没发生（静默失败）。
			 */
			rejectResult?: (data: unknown) => { code: string; message: string } | null;
		},
	): Promise<PiPromptAccepted> {
		const { clientId, sessionId, cwdRef, submissionId } = params;
		const [projectKey] = await Promise.all([
			this.resolveProjectKey(lease, cwdRef),
			this.sessionsService.ensureSession(actor, { clientId, sessionId }),
		]);
		await this.assertIdle(clientId, projectKey);
		let run: {
			sessionId: string;
			runId: string;
			executionMode: PiToolExecutionMode;
			restoredFromArchive: boolean;
		};
		const kind = params.action === "agent.command" ? "command" as const : "prompt" as const;
		try {
			run = await this.runs.startRun(actor, { clientId, sessionId, projectKey, kind });
		} catch (err) {
			if (!isPiError(err) || err.code !== "PI_PROJECT_BUSY") throw err;
			const previous = await this.sessionsService.snapshot(sessionId, actor.identityId);
			const previousRunId = previous.activeRun?.runId;
			if (!previousRunId)
				throw new ConflictException({ code: err.code, message: err.message });
			const state = parsePiAgentState(
				await this.requestOnce(lease, {
					requestId: randomUUID(),
					action: "agent.state",
					cwdRef,
					sessionId,
					runId: previousRunId,
				}),
			);
			await this.runs.reconcileOpen(sessionId, previousRunId, state);
			try {
				run = await this.runs.startRun(actor, { clientId, sessionId, projectKey, kind });
			} catch (retryError) {
				if (isPiError(retryError) && retryError.code === "PI_PROJECT_BUSY") {
					throw new ConflictException({
						code: retryError.code,
						message: retryError.message,
					});
				}
				throw retryError;
			}
		}
		const { runId } = run;

		if (run.restoredFromArchive) {
			// 归档会话被新 Prompt 恢复:与接纳同一路径记录最小审计。
			await this.sessionsService
				.recordAudit({
					sessionId,
					clientId,
					event: "restored",
					result: "ok",
					actor,
					operationId: runId,
				})
				.catch(() => {});
		}

		// 先发布 run_created（submissionId 绑定），再 dispatch，保证首个 Agent 事件不丢
		await this.events.publish({
			clientId,
			sessionId,
			runId,
			event: { type: "run_created", sessionId, submissionId, runId },
		});

		let dispatchError: unknown;
		this.runtime?.assertCompatible(lease.clientId);
		this.runtime?.assertReady(lease.clientId);
		let response: PiResponse;
		try {
			response = await this.requests.request(lease, {
				requestId: randomUUID(),
				action: params.action,
				cwdRef,
				sessionId,
				runId,
				payload: params.payload(run.executionMode),
			});
			const rejection = response.ok
				? (params.rejectResult?.(response.data) ?? null)
				: { code: response.error.code, message: response.error.message };
			if (rejection) {
				// 被拒绝的一轮是确定失败:记安全错误码,不留假活跃状态。
				await this.runs.settleRun(sessionId, runId, {
					status: "failed",
					errorCode: safeErrorCode(rejection.code),
				});
				dispatchError = badRequest(rejection.code, rejection.message);
			} else {
				await this.runs.accept(sessionId, runId);
			}
		} catch (error) {
			dispatchError = error;
			const code =
				error instanceof Error && "code" in error
					? String((error as { code: unknown }).code)
					: undefined;
			if (code === "PI_CLIENT_DISCONNECTED") {
				await this.runs.markRunDisconnected(sessionId, runId);
			} else if (code === "PI_REQUEST_TIMEOUT") {
				try {
					const stateResponse: PiResponse = await this.requests.request(lease, {
						requestId: randomUUID(),
						action: "agent.state",
						cwdRef,
						sessionId,
						runId,
					});
					if (stateResponse.ok) {
						const state = parsePiAgentState(stateResponse.data);
						if (isPiAgentIdle(state)) {
							await this.runs.settleRun(sessionId, runId, { status: "succeeded" });
						} else {
							await this.runs.accept(sessionId, runId);
							await this.runs.reconcileOpen(sessionId, runId, state);
						}
					}
				} catch (stateError) {
					if (
						stateError instanceof Error &&
						"code" in stateError &&
						String((stateError as { code: unknown }).code) ===
							"PI_CLIENT_DISCONNECTED"
					) {
						await this.runs.markRunDisconnected(sessionId, runId);
					}
				}
			}
		}

		if (dispatchError) throw dispatchError;
		return { sessionId, runId };
	}

	@Sse("agent/:sessionId/events")
	stream(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
	) {
		// SSE 是 session 级；Observer 无需 Owner
		return this.events.stream(clientId, sessionId);
	}

	@Get("running")
	async running(@Param("clientId") clientId: string) {
		await this.requirePiClient(clientId);
		return this.runs.listActiveRuns(clientId);
	}

	// ── 图片附件（临时 Storage + FileRef） ──

	@Post("attachments")
	async createAttachments(
		@Param("clientId") clientId: string,
		@Body()
		body: {
			images?: Array<{ filename?: string; size?: number; mimeType?: string }>;
		},
	) {
		await this.requirePiClient(clientId);
		if (!Array.isArray(body.images) || body.images.length === 0) {
			throw badRequest("PI_PROTOCOL_INVALID", "images required");
		}
		const images = body.images.map((img) => {
			if (
				typeof img.filename !== "string" ||
				typeof img.size !== "number" ||
				typeof img.mimeType !== "string"
			) {
				throw badRequest("PI_PROTOCOL_INVALID", "invalid image descriptor");
			}
			return { filename: img.filename, size: img.size, mimeType: img.mimeType };
		});
		return this.attachments.createPromptUploads(clientId, images);
	}

	@Post("attachments/:attachmentId/complete")
	async completeAttachment(
		@Param("clientId") clientId: string,
		@Param("attachmentId") attachmentId: string,
	) {
		await this.requirePiClient(clientId);
		return this.attachments.completePromptUpload(attachmentId, clientId);
	}

	@Delete("attachments/:attachmentId")
	@HttpCode(200)
	async deleteAttachment(
		@Param("clientId") clientId: string,
		@Param("attachmentId") attachmentId: string,
	) {
		await this.requirePiClient(clientId);
		await this.attachments.deleteAttachment(attachmentId, clientId);
		return { ok: true };
	}

	// ── 活动回合控制（Owner only） ──

	private async controlAction(
		clientId: string,
		sessionId: string,
		runId: string,
		action: PiRequest["action"],
		actor: ActorContext,
		payload?: Record<string, unknown>,
	): Promise<unknown> {
		await this.requirePiClient(clientId);
		await this.assertActiveOwner(sessionId, runId, actor);
		return this.requestForClient(clientId, {
			requestId: randomUUID(),
			action,
			sessionId,
			runId,
			...(payload ? { payload } : {}),
		});
	}

	@Post("agent/:sessionId/steer")
	async steer(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string; message?: string },
		@Actor() actor: ActorContext,
	) {
		const runId = requiredRunId(body);
		if (typeof body.message !== "string") throw badRequest("PI_PROTOCOL_INVALID", "message required");
		return this.controlAction(clientId, sessionId, runId, "agent.steer", actor, {
			message: body.message,
		});
	}

	@Post("agent/:sessionId/follow-up")
	async followUp(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string; message?: string },
		@Actor() actor: ActorContext,
	) {
		const runId = requiredRunId(body);
		if (typeof body.message !== "string") throw badRequest("PI_PROTOCOL_INVALID", "message required");
		return this.controlAction(clientId, sessionId, runId, "agent.followUp", actor, {
			message: body.message,
		});
	}

	@Post("agent/:sessionId/abort")
	async abort(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string },
		@Actor() actor: ActorContext,
	) {
		const runId = requiredRunId(body);
		await this.requirePiClient(clientId);
		await this.assertActiveOwner(sessionId, runId, actor);
		// 中止请求本身不证明远端已中止:不在此伪造终态,
		// 由 Client 的权威终局摘要或重连对账收敛。
		await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "agent.abort",
			sessionId,
			runId,
		});
		return { ok: true };
	}

	@Post("agent/:sessionId/compact")
	async compact(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string; customInstructions?: string },
		@Actor() actor: ActorContext,
	) {
		const runId = requiredRunId(body);
		return this.controlAction(clientId, sessionId, runId, "agent.compact", actor, {
			...(typeof body.customInstructions === "string"
				? { customInstructions: body.customInstructions }
				: {}),
		});
	}

	@Post("agent/:sessionId/abort-compact")
	async abortCompact(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string },
		@Actor() actor: ActorContext,
	) {
		return this.controlAction(clientId, sessionId, requiredRunId(body), "agent.abortCompact", actor);
	}

	@Post("agent/:sessionId/extension-response")
	async extensionResponse(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { runId?: string; requestId?: string; value?: string; confirmed?: boolean; cancelled?: boolean },
		@Actor() actor: ActorContext,
	) {
		const runId = requiredRunId(body);
		if (typeof body.requestId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "requestId required");
		await this.requirePiClient(clientId);
		await this.assertActiveOwner(sessionId, runId, actor);
		await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "extension.respond",
			sessionId,
			runId,
			payload: {
				requestId: body.requestId,
				...(body.value !== undefined ? { value: body.value } : {}),
				...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
				...(body.cancelled === true ? { cancelled: true } : {}),
			},
		});
		return { ok: true };
	}

	@Get("agent/:sessionId/commands")
	async extensionCommands(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	): Promise<PiExtensionCommands> {
		await this.requirePiClient(clientId);
		// Client 用 cwdRef 解析会话归属与项目，缺失即 PI_PROTOCOL_INVALID。
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "agent.commands",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
		// Client 只应投影调用名与描述；本地来源路径不得越过 Client 边界。
		return this.parseUpstream("Client", data, parsePiExtensionCommands);
	}

	@Get("agent/:sessionId/extension-ui")
	async extensionUiSnapshot(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Query("rootDir") rootDir: string,
		@Query("relativePath") relativePath: string,
	): Promise<PiExtensionUiSnapshot> {
		await this.requirePiClient(clientId);
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const data = await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "extension.ui.get",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
		return this.parseUpstream("Client", data, parsePiExtensionUiSnapshot);
	}

	@Post("agent/:sessionId/command")
	async executeCommand(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body()
		body: {
			rootDir?: string;
			relativePath?: string;
			submissionId?: string;
			name?: string;
			args?: string;
		},
		@Actor() actor: ActorContext,
	): Promise<PiPromptAccepted> {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, name } = body ?? {};
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof name !== "string" || name.length === 0) {
			throw badRequest("PI_PROTOCOL_INVALID", "name required");
		}
		// 命令是**启动新工作**，因此与 prompt 一样由 Server 接纳 Run：
		// 复用项目互斥、取消、重连对账与结算，不接受调用方自带 runId
		// （否则会绕过互斥与结算对账）。
		const submissionId =
			typeof body.submissionId === "string" && body.submissionId.length > 0
				? body.submissionId
				: randomUUID();
		return this.withReconciledClient(clientId, (lease) =>
			this.admitAndDispatch(lease, actor, {
				clientId,
				sessionId,
				cwdRef: { rootDir, relativePath },
				submissionId,
				action: "agent.command",
				payload: () => ({
					name,
					args: typeof body.args === "string" ? body.args : "",
				}),
				// 未注册命令由 Client 以 `{ ok: false }` 返回而非 transport 错误
				// （真实 SDK 不会 reject）：必须翻成稳定 HTTP 错误，
				// 否则调用方会看到 200 却什么都没发生。
				rejectResult: (data) => {
					const r = data as {
						ok?: boolean;
						error?: { code?: string; message?: string };
					} | null;
					if (r?.ok !== false) return null;
					return {
						code: r.error?.code ?? "PI_PROTOCOL_INVALID",
						message: r.error?.message ?? "Pi command rejected",
					};
				},
			}),
		);
	}

	// ── 空闲项目操作（idle mutation lock） ──

	private async idleAction(
		clientId: string,
		rootDir: string,
		relativePath: string,
		action: PiRequest["action"],
		sessionId?: string,
		payload?: Record<string, unknown>,
		actor?: ActorContext,
	): Promise<unknown> {
		await this.requirePiClient(clientId);
		if (sessionId && actor) await this.assertSessionOwner(sessionId, actor);
		return this.withReconciledClient(clientId, async (lease) => {
			const projectKey = await this.resolveProjectKey(lease, { rootDir, relativePath });
			await this.assertIdle(clientId, projectKey);
			return this.requestOnce(lease, {
				requestId: randomUUID(),
				action,
				cwdRef: { rootDir, relativePath },
				...(sessionId ? { sessionId } : {}),
				...(payload ? { payload } : {}),
			});
		});
	}

	@Post("agent/:sessionId/model")
	async setModel(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; provider?: string; modelId?: string },
		@Actor() actor: ActorContext,
	) {
		const { rootDir, relativePath, provider, modelId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof provider !== "string" || typeof modelId !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "provider/modelId required");
		}
		return this.idleAction(clientId, rootDir, relativePath, "model.set", sessionId, {
			provider,
			modelId,
		}, actor);
	}

	@Post("agent/:sessionId/thinking")
	async setThinking(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; level?: string },
		@Actor() actor: ActorContext,
	) {
		const { rootDir, relativePath, level } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (!isPiThinkingLevel(level)) {
			throw badRequest("PI_PROTOCOL_INVALID", "invalid thinking level");
		}
		return this.idleAction(clientId, rootDir, relativePath, "thinking.set", sessionId, {
			level,
		}, actor);
	}
}
