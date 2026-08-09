import {
	BadRequestException,
	ConflictException,
	Controller,
	Delete,
	Get,
	Inject,
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
	isPiAgentIdle,
	isPiThinkingLevel,
	parsePiAgentState,
	PI_ERROR_CODES,
	PI_SESSION_JOB_PROTOCOL_VERSION,
	type ActorContext,
	type PiCwdRef,
	type PiPromptAccepted,
	type PiRequest,
	type PiSessionCreated,
	type PiSessionJobSnapshot,
	type PiSessionOpenResult,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { ClientService } from "../client/client.service.js";
import { PiEventBroker } from "./pi-event-broker.js";
import {
	PiRequestBroker,
	type PiGenerationLease,
} from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
import { PiAttachmentService } from "./pi-attachment.service.js";

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
		@Inject(ClientService) private readonly clients: ClientService,
		@Inject(PiAttachmentService) private readonly attachments: PiAttachmentService,
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
			client.capabilityDetails.pi.sessionJobProtocolVersion !== PI_SESSION_JOB_PROTOCOL_VERSION
		) {
			throw badRequest(
				"PI_CLIENT_UNSUPPORTED",
				`Client "${clientId}" does not support Pi`,
			);
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

	private requestForClient(clientId: string, request: PiRequest): Promise<unknown> {
		return this.withReconciledClient(clientId, (lease) =>
			this.requestOnce(lease, request),
		);
	}

	private async assertSessionOwner(jobId: string, actor: ActorContext): Promise<void> {
		try {
			await this.runs.assertSessionOwner(jobId, actor.identityId);
		} catch (err) {
			if (isPiError(err)) throw badRequest(err.code, err.message);
			throw err;
		}
	}

	private async assertActiveOwner(jobId: string, runId: string, actor: ActorContext): Promise<void> {
		try {
			await this.runs.assertCurrentRunOwner(jobId, runId, actor.identityId);
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
		return (data as { models: unknown[] }).models;
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
		return (data as { sessions: unknown[] }).sessions;
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
		await this.assertSessionOwner(sessionId, actor);
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
			const reservation = await this.runs.beginDelete(sessionId, actor.identityId);
			let response;
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
				await this.runs.commitDelete(sessionId, reservation.deleteToken);
				return { ok: true };
			}
			if (["PI_PROTOCOL_INVALID", "PI_PROJECT_NOT_ALLOWED", "PI_PROJECT_BUSY"].includes(response.error.code)) {
				await this.runs.rollbackDelete(sessionId, reservation.deleteToken);
				throw badRequest(response.error.code, response.error.message);
			}

			let confirmation;
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
				await this.runs.commitDelete(sessionId, reservation.deleteToken);
				return { ok: true };
			}
			if (confirmation.ok) {
				await this.runs.rollbackDelete(sessionId, reservation.deleteToken);
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
				await this.runs.ensureSession(actor, { clientId, sessionId });
				return { sessionId, jobId: sessionId };
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
			await this.runs.ensureSession(actor, { clientId, sessionId });
			const snapshot = await this.runs.snapshot(sessionId, actor.identityId);
			const agentState = parsePiAgentState(await this.requestOnce(lease, {
				requestId: randomUUID(), action: "agent.state", cwdRef, sessionId,
				jobId: snapshot.runId ? sessionId : undefined,
				runId: snapshot.runId ?? undefined,
			}));
			if (snapshot.runId) await this.runs.reconcileOpen(sessionId, snapshot.runId, agentState);
			return { job: await this.runs.snapshot(sessionId, actor.identityId), agentState };
		});
	}

	@Post("agent/:sessionId/complete")
	async completeSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: unknown,
		@Actor() actor: ActorContext,
	): Promise<PiSessionJobSnapshot> {
		await this.requirePiClient(clientId);
		const requestedRunId = optionalRunId(body);
		return this.withReconciledClient(clientId, async (lease) => {
			await this.runs.assertSessionOwner(sessionId, actor.identityId);
			const before = await this.runs.snapshot(sessionId, actor.identityId);
			if (requestedRunId && before.runId !== requestedRunId) throw new ConflictException({ code: "PI_CONTROL_FORBIDDEN", message: "Run is no longer current" });
			const runId = before.runId ?? requestedRunId;
			if ((before.status === "running" || before.status === "waiting_input") && runId) {
				await this.requestOnce(lease, { requestId: randomUUID(), action: "agent.abort", sessionId, jobId: sessionId, runId });
			}
			if (!await this.runs.completeSession(sessionId, runId)) {
				const current = await this.runs.snapshot(sessionId, actor.identityId);
				if (current.runId !== runId) throw new ConflictException({ code: "PI_CONTROL_FORBIDDEN", message: "Session run changed during completion" });
			}
			return this.runs.snapshot(sessionId, actor.identityId);
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
		if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
			throw badRequest("PI_PROTOCOL_INVALID", "prompt required");
		}

		return this.withReconciledClient(clientId, async (lease) => {
			const [projectKey] = await Promise.all([
				this.resolveProjectKey(lease, { rootDir, relativePath }),
				this.runs.ensureSession(actor, { clientId, sessionId }),
			]);
			let run: { jobId: string; runId: string };
			try {
				run = await this.runs.startRun(actor, { clientId, sessionId, projectKey });
			} catch (err) {
				if (!isPiError(err) || err.code !== "PI_PROJECT_BUSY") throw err;
				const previous = await this.runs.snapshot(sessionId, actor.identityId);
				if (!previous.runId) throw new ConflictException({ code: err.code, message: err.message });
				const state = parsePiAgentState(await this.requestOnce(lease, {
					requestId: randomUUID(), action: "agent.state", cwdRef: { rootDir, relativePath },
					sessionId, jobId: sessionId, runId: previous.runId,
				}));
				await this.runs.reconcileOpen(sessionId, previous.runId, state);
				try {
					run = await this.runs.startRun(actor, { clientId, sessionId, projectKey });
				} catch (retryError) {
					if (isPiError(retryError) && retryError.code === "PI_PROJECT_BUSY") {
						throw new ConflictException({ code: retryError.code, message: retryError.message });
					}
					throw retryError;
				}
			}
			const { jobId, runId } = run;

			// 先发布 run_created（submissionId 绑定），再 dispatch，保证首个 Agent 事件不丢
			await this.events.publish({
				clientId,
				sessionId,
				jobId,
				runId,
				event: { type: "run_created", sessionId, submissionId, runId },
			});

			let dispatchError: unknown;
			try {
				const response = await this.requests.request(lease, {
					requestId: randomUUID(),
					action: "agent.prompt",
					cwdRef: { rootDir, relativePath },
					sessionId,
					jobId,
					runId,
					payload: {
						prompt: body.prompt,
						submissionId,
						...(Array.isArray(body.images) && body.images.length > 0
							? { attachments: body.images }
							: {}),
					},
				});
				if (!response.ok) {
					await this.runs.finishRun(jobId, runId);
					dispatchError = badRequest(response.error.code, response.error.message);
				} else {
					await this.runs.accept(jobId, runId);
				}
			} catch (error) {
				dispatchError = error;
				const code = error instanceof Error && "code" in error
					? String((error as { code: unknown }).code)
					: undefined;
				if (code === "PI_CLIENT_DISCONNECTED") {
					await this.runs.markRunDisconnected(jobId, runId);
				} else if (code === "PI_REQUEST_TIMEOUT") {
					try {
						const stateResponse = await this.requests.request(lease, {
							requestId: randomUUID(), action: "agent.state",
							cwdRef: { rootDir, relativePath }, sessionId, jobId, runId,
						});
						if (stateResponse.ok) {
							const state = parsePiAgentState(stateResponse.data);
							if (isPiAgentIdle(state)) {
								await this.runs.finishRun(jobId, runId);
							} else {
								await this.runs.accept(jobId, runId);
								await this.runs.reconcileOpen(jobId, runId, state);
							}
						}
					} catch (stateError) {
						if (stateError instanceof Error && "code" in stateError
							&& String((stateError as { code: unknown }).code) === "PI_CLIENT_DISCONNECTED") {
							await this.runs.markRunDisconnected(jobId, runId);
						}
					}
				}
			}

			const current = await this.runs.snapshot(sessionId, actor.identityId);
			if (current.status === "done" || current.status === "cancelled") {
				try {
					await this.requests.request(lease, {
						requestId: randomUUID(), action: "agent.abort",
						sessionId, jobId, runId,
					});
				} catch { /* best effort: only the dispatched run is addressed */ }
				throw new ConflictException({
					code: "PI_CONTROL_FORBIDDEN",
					message: "Session completed while the prompt was dispatching",
				});
			}
			if (dispatchError) throw dispatchError;
			return { jobId, runId, sessionId };
		});
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
		return this.runs.listActiveByClient(clientId);
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
			jobId: sessionId,
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
		await this.requestForClient(clientId, {
			requestId: randomUUID(),
			action: "agent.abort",
			sessionId,
			jobId: sessionId,
			runId,
		});
		await this.runs.finishRun(sessionId, runId);
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
			jobId: sessionId,
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
