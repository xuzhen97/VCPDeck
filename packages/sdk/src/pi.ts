import type {
	PiCwdRef,
	PiModelInfo,
	PiPromptAccepted,
	PiThinkingLevel,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

function cwdQuery(cwdRef: PiCwdRef): string {
	const params = new URLSearchParams();
	params.set("rootDir", cwdRef.rootDir);
	params.set("relativePath", cwdRef.relativePath);
	return params.toString();
}

export interface PiSessionsApi {
	list(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<unknown>;
	get(clientId: string, sessionId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<unknown>;
	context(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		options?: { leafId?: string; cursor?: string },
		signal?: AbortSignal,
	): Promise<unknown>;
	entryContent(
		clientId: string,
		sessionId: string,
		entryId: string,
		cwdRef: PiCwdRef,
		blockIndex: number,
		signal?: AbortSignal,
	): Promise<unknown>;
	rename(clientId: string, sessionId: string, cwdRef: PiCwdRef, name: string): Promise<unknown>;
	delete(clientId: string, sessionId: string, cwdRef: PiCwdRef): Promise<unknown>;
	fork(clientId: string, sessionId: string, cwdRef: PiCwdRef, messageId: string): Promise<unknown>;
	clone(clientId: string, sessionId: string, cwdRef: PiCwdRef): Promise<unknown>;
	navigate(clientId: string, sessionId: string, cwdRef: PiCwdRef, targetId: string): Promise<unknown>;
}

export interface PiAgentApi {
	newSession(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<{ sessionId: string }>;
	state(clientId: string, sessionId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<unknown>;
	prompt(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		input: { submissionId: string; prompt: string; images?: unknown[] },
		signal?: AbortSignal,
	): Promise<PiPromptAccepted>;
	steer(clientId: string, sessionId: string, jobId: string, message: string): Promise<unknown>;
	followUp(clientId: string, sessionId: string, jobId: string, message: string): Promise<unknown>;
	abort(clientId: string, sessionId: string, jobId: string): Promise<unknown>;
	compact(clientId: string, sessionId: string, jobId: string, customInstructions?: string): Promise<unknown>;
	abortCompact(clientId: string, sessionId: string, jobId: string): Promise<unknown>;
	setModel(clientId: string, sessionId: string, cwdRef: PiCwdRef, provider: string, modelId: string): Promise<unknown>;
	setThinking(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		level: PiThinkingLevel,
	): Promise<unknown>;
	extensionResponse(
		clientId: string,
		sessionId: string,
		jobId: string,
		response: { requestId: string; value?: string; confirmed?: boolean; cancelled?: boolean },
	): Promise<unknown>;
	/** SSE path（session 级；cookie 认证浏览器用 EventSource 连接） */
	eventsPath(clientId: string, sessionId: string): string;
}

export interface PiAttachmentsApi {
	create(
		clientId: string,
		images: Array<{ filename: string; size: number; mimeType: string }>,
		signal?: AbortSignal,
	): Promise<Array<{ fileId: string; uploadUrl: string; expiresAt: number }>>;
	complete(
		clientId: string,
		attachmentId: string,
		signal?: AbortSignal,
	): Promise<import("@vcpdeck/shared").PiAttachmentRef>;
	delete(clientId: string, attachmentId: string): Promise<unknown>;
}

export interface PiApi {
	capability(clientId: string, signal?: AbortSignal): Promise<unknown>;
	models(clientId: string, cwdRef: PiCwdRef, signal?: AbortSignal): Promise<PiModelInfo[]>;
	sessions: PiSessionsApi;
	agent: PiAgentApi;
	attachments: PiAttachmentsApi;
	running(clientId: string, signal?: AbortSignal): Promise<unknown>;
}

function enc(s: string): string {
	return encodeURIComponent(s);
}

/** 创建远程 Pi REST API（机器命名空间） */
export function createPiApi(client: Pick<VcpDeckClient, "request">): PiApi {
	return {
		capability: (clientId, signal) =>
			client.request("GET", `/api/clients/${enc(clientId)}/pi/capability`, undefined, signal),

		models: (clientId, cwdRef, signal) =>
			client.request(
				"GET",
				`/api/clients/${enc(clientId)}/pi/models?${cwdQuery(cwdRef)}`,
				undefined,
				signal,
			),

		sessions: {
			list: (clientId, cwdRef, signal) =>
				client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				),
			get: (clientId, sessionId, cwdRef, signal) =>
				client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				),
			context: (clientId, sessionId, cwdRef, options, signal) => {
				const params = new URLSearchParams(cwdQuery(cwdRef));
				if (options?.leafId) params.set("leafId", options.leafId);
				if (options?.cursor) params.set("cursor", options.cursor);
				return client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/context?${params.toString()}`,
					undefined,
					signal,
				);
			},
			entryContent: (clientId, sessionId, entryId, cwdRef, blockIndex, signal) => {
				const params = new URLSearchParams(cwdQuery(cwdRef));
				params.set("blockIndex", String(blockIndex));
				return client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/entries/${enc(entryId)}/content?${params.toString()}`,
					undefined,
					signal,
				);
			},
			rename: (clientId, sessionId, cwdRef, name) =>
				client.request("PATCH", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
					...cwdRef,
					name,
				}),
			delete: (clientId, sessionId, cwdRef) =>
				client.request("DELETE", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
					...cwdRef,
				}),
			fork: (clientId, sessionId, cwdRef, messageId) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/fork`, {
					...cwdRef,
					messageId,
				}),
			clone: (clientId, sessionId, cwdRef) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/clone`, {
					...cwdRef,
				}),
			navigate: (clientId, sessionId, cwdRef, targetId) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/navigate`, {
					...cwdRef,
					targetId,
				}),
		},

		agent: {
			newSession: (clientId, cwdRef, signal) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/new`, { ...cwdRef }, signal),
			state: (clientId, sessionId, cwdRef, signal) =>
				client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				),
			prompt: (clientId, sessionId, cwdRef, input, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}`,
					{
						...cwdRef,
						type: "prompt",
						submissionId: input.submissionId,
						prompt: input.prompt,
						...(input.images?.length ? { images: input.images } : {}),
					},
					signal,
				),
			steer: (clientId, sessionId, jobId, message) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/steer`, {
					jobId,
					message,
				}),
			followUp: (clientId, sessionId, jobId, message) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/follow-up`, {
					jobId,
					message,
				}),
			abort: (clientId, sessionId, jobId) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort`, {
					jobId,
				}),
			compact: (clientId, sessionId, jobId, customInstructions) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/compact`, {
					jobId,
					...(customInstructions ? { customInstructions } : {}),
				}),
			abortCompact: (clientId, sessionId, jobId) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort-compact`, {
					jobId,
				}),
			setModel: (clientId, sessionId, cwdRef, provider, modelId) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/model`, {
					...cwdRef,
					provider,
					modelId,
				}),
			setThinking: (clientId, sessionId, cwdRef, level) =>
				client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/thinking`, {
					...cwdRef,
					level,
				}),
			extensionResponse: (clientId, sessionId, jobId, response) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/extension-response`,
					{ jobId, ...response },
				),
			eventsPath: (clientId, sessionId) =>
				`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/events`,
		},

		attachments: {
			create: (clientId, images, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/attachments`,
					{ images },
					signal,
				),
			complete: (clientId, attachmentId, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}/complete`,
					undefined,
					signal,
				),
			delete: (clientId, attachmentId) =>
				client.request(
					"DELETE",
					`/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}`,
				),
		},

		running: (clientId, signal) =>
			client.request("GET", `/api/clients/${enc(clientId)}/pi/running`, undefined, signal),
	};
}
