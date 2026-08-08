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
	isPiThinkingLevel,
	type ActorContext,
	type PiCwdRef,
	type PiPromptAccepted,
	type PiRequest,
} from "@vcpdeck/shared";
import { Actor } from "../auth/actor.decorator.js";
import { ClientService } from "../client/client.service.js";
import { PiEventBroker } from "./pi-event-broker.js";
import { PiRequestBroker } from "./pi-request-broker.js";
import { PiRunService } from "./pi-run.service.js";
import { PiAttachmentService } from "./pi-attachment.service.js";

function badRequest(code: string, message: string): BadRequestException {
	return new BadRequestException({ code, message });
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
		if (!client.capabilities.includes("agent.pi")) {
			throw badRequest(
				"PI_CLIENT_UNSUPPORTED",
				`Client "${clientId}" does not support Pi`,
			);
		}
	}

	/** 每次写操作先解析不透明 projectKey（不持久化） */
	private async resolveProjectKey(
		clientId: string,
		cwdRef: PiCwdRef,
	): Promise<string> {
		const response = await this.requests.request(clientId, {
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
		clientId: string,
		request: PiRequest,
	): Promise<unknown> {
		const response = await this.requests.request(clientId, request);
		if (!response.ok) {
			throw badRequest(response.error.code, response.error.message);
		}
		return response.data;
	}

	private async assertActiveOwner(jobId: string, actor: ActorContext): Promise<void> {
		try {
			await this.runs.assertOwner(jobId, actor.identityId);
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
		const data = await this.requestOnce(clientId, {
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
		const data = await this.requestOnce(clientId, {
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
		return this.requestOnce(clientId, {
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
		return this.requestOnce(clientId, {
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
		return this.requestOnce(clientId, {
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
		@Body() body: { rootDir?: string; relativePath?: string; name?: string }
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, name } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof name !== "string" || name.trim() === "") {
			throw badRequest("PI_PROTOCOL_INVALID", "name required");
		}
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.rename",
			cwdRef: { rootDir, relativePath },
			sessionId,
			payload: { name },
		});
		return { ok: true };
	}

	@Delete("sessions/:sessionId")
	@HttpCode(200)
	async deleteSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string }
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath } = body ?? {};
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.delete",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
		return { ok: true };
	}

	@Post("sessions/:sessionId/fork")
	async forkSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; messageId?: string },
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, messageId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof messageId !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "messageId required");
		}
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		const data = await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.fork",
			cwdRef: { rootDir, relativePath },
			sessionId,
			payload: { messageId },
		});
		return data;
	}

	@Post("sessions/:sessionId/clone")
	async cloneSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string },
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		const data = await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.clone",
			cwdRef: { rootDir, relativePath },
			sessionId,
		});
		return data;
	}

	@Post("sessions/:sessionId/navigate")
	async navigateSession(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; targetId?: string },
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath, targetId } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		if (typeof targetId !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "targetId required");
		}
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		const data = await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.navigate",
			cwdRef: { rootDir, relativePath },
			sessionId,
			payload: { targetId },
		});
		return data;
	}

	// ── agent ──

	@Post("agent/new")
	async newSession(
		@Param("clientId") clientId: string,
		@Body() body: { rootDir?: string; relativePath?: string },
	) {
		await this.requirePiClient(clientId);
		const { rootDir, relativePath } = body;
		if (typeof rootDir !== "string" || typeof relativePath !== "string") {
			throw badRequest("PI_PROTOCOL_INVALID", "rootDir/relativePath required");
		}
		const data = await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "session.new",
			cwdRef: { rootDir, relativePath },
		});
		return data as { sessionId: string };
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
		return this.requestOnce(clientId, {
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

		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		let run: { jobId: string; runId: string };
		try {
			run = await this.runs.createRun(actor, {
				clientId,
				sessionId,
				projectKey,
				imageCount: Array.isArray(body.images) ? body.images.length : 0,
			});
		} catch (err) {
			if (
				err instanceof Error &&
				(err as { code?: unknown }).code === "PI_PROJECT_BUSY"
			) {
				throw new ConflictException({
					code: "PI_PROJECT_BUSY",
					message: err.message,
				});
			}
			throw err;
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

		try {
			const response = await this.requests.request(clientId, {
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
				await this.runs.fail(jobId, response.error.code, response.error.message);
				throw badRequest(response.error.code, response.error.message);
			}
			await this.runs.accept(jobId);
		} catch (err) {
			if (err instanceof Error && "code" in err) {
				const code = String((err as { code: unknown }).code);
				if (code === "PI_REQUEST_TIMEOUT" || code === "PI_CLIENT_DISCONNECTED") {
					await this.runs.fail(jobId, code, err.message);
				}
			}
			throw err;
		}
		return { jobId, runId, sessionId };
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
		jobId: string,
		action: PiRequest["action"],
		actor: ActorContext,
		payload?: Record<string, unknown>,
	): Promise<unknown> {
		await this.assertActiveOwner(jobId, actor);
		return this.requestOnce(clientId, {
			requestId: randomUUID(),
			action,
			sessionId,
			jobId,
			runId: jobId,
			...(payload ? { payload } : {}),
		});
	}

	@Post("agent/:sessionId/steer")
	async steer(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string; message?: string },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		if (typeof body.message !== "string") throw badRequest("PI_PROTOCOL_INVALID", "message required");
		return this.controlAction(clientId, sessionId, body.jobId, "agent.steer", actor, {
			message: body.message,
		});
	}

	@Post("agent/:sessionId/follow-up")
	async followUp(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string; message?: string },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		if (typeof body.message !== "string") throw badRequest("PI_PROTOCOL_INVALID", "message required");
		return this.controlAction(clientId, sessionId, body.jobId, "agent.followUp", actor, {
			message: body.message,
		});
	}

	@Post("agent/:sessionId/abort")
	async abort(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		await this.assertActiveOwner(body.jobId, actor);
		await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "agent.abort",
			sessionId,
			jobId: body.jobId,
			runId: body.jobId,
		});
		await this.runs.cancel(body.jobId);
		return { ok: true };
	}

	@Post("agent/:sessionId/compact")
	async compact(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string; customInstructions?: string },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		return this.controlAction(clientId, sessionId, body.jobId, "agent.compact", actor, {
			...(typeof body.customInstructions === "string"
				? { customInstructions: body.customInstructions }
				: {}),
		});
	}

	@Post("agent/:sessionId/abort-compact")
	async abortCompact(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		return this.controlAction(clientId, sessionId, body.jobId, "agent.abortCompact", actor);
	}

	@Post("agent/:sessionId/extension-response")
	async extensionResponse(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { jobId?: string; requestId?: string; value?: string; confirmed?: boolean; cancelled?: boolean },
		@Actor() actor: ActorContext,
	) {
		if (typeof body.jobId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "jobId required");
		if (typeof body.requestId !== "string") throw badRequest("PI_PROTOCOL_INVALID", "requestId required");
		await this.assertActiveOwner(body.jobId, actor);
		await this.requestOnce(clientId, {
			requestId: randomUUID(),
			action: "extension.respond",
			sessionId,
			jobId: body.jobId,
			runId: body.jobId,
			payload: {
				requestId: body.requestId,
				...(body.value !== undefined ? { value: body.value } : {}),
				...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
				...(body.cancelled === true ? { cancelled: true } : {}),
			},
		});
		await this.runs.resume(body.jobId);
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
	): Promise<unknown> {
		const projectKey = await this.resolveProjectKey(clientId, { rootDir, relativePath });
		await this.assertIdle(clientId, projectKey);
		return this.requestOnce(clientId, {
			requestId: randomUUID(),
			action,
			cwdRef: { rootDir, relativePath },
			...(sessionId ? { sessionId } : {}),
			...(payload ? { payload } : {}),
		});
	}

	@Post("agent/:sessionId/model")
	async setModel(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; provider?: string; modelId?: string },
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
		});
	}

	@Post("agent/:sessionId/thinking")
	async setThinking(
		@Param("clientId") clientId: string,
		@Param("sessionId") sessionId: string,
		@Body() body: { rootDir?: string; relativePath?: string; level?: string },
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
		});
	}
}
