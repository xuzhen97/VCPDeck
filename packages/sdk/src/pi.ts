import {
	parsePiAgentState,
	parsePiExtensionCommands,
	parsePiExtensionUiSnapshot,
	parsePiSessionJobSnapshot,
	type PaginatedResult,
	type PiAgentState,
	type PiAttachmentRef,
	type PiClientBindingInfo,
	type PiCredentialCreateInput,
	type PiCredentialInfo,
	type PiCredentialUpdateInput,
	type PiCwdRef,
	type PiExecutionMigrationInput,
	type PiExtensionCommands,
	type PiExtensionUiSnapshot,
	type PiModelInfo,
	type PiProfileCreateInput,
	type PiProfileInfo,
	type PiProfileUpdateInput,
	type PiProviderCreateInput,
	type PiProviderDiscoveryInput,
	type PiProviderDiscoveryResult,
	type PiProviderInfo,
	type PiProviderUpdateInput,
	type PiRuntimeStatus,
	type PiImportListResponse,
	type PiImportPreviewResponse,
	type PiImportRunResponse,
	type PiPromptAccepted,
	type PiSessionCreated,
	type PiSessionJobSnapshot,
	type PiSessionOpenResult,
	type PiThinkingLevel,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

function cwdQuery(cwdRef: PiCwdRef): string {
	const params = new URLSearchParams();
	params.set("rootDir", cwdRef.rootDir);
	params.set("relativePath", cwdRef.relativePath);
	return params.toString();
}

export interface PiSessionsApi {
	/** 列出用户原生 Pi 中可显式导入的会话（元数据摘要，不含正文）。 */
	importable(clientId: string, signal?: AbortSignal): Promise<PiImportListResponse>;
	/** 逐条显式预览：首条 user 消息 80 字符截断（正文片段唯一出口）。 */
	previewImportable(
		clientId: string,
		sourceName: string,
		signal?: AbortSignal,
	): Promise<PiImportPreviewResponse>;
	/** 单向导入到 VCPDeck Session root（按文件名幂等，不覆盖）。 */
	import(
		clientId: string,
		sourceNames: string[],
		signal?: AbortSignal,
	): Promise<PiImportRunResponse>;
	list(
		clientId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<unknown>;
	get(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<unknown>;
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
	rename(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		name: string,
	): Promise<unknown>;
	delete(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
	): Promise<unknown>;
	fork(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		messageId: string,
	): Promise<unknown>;
	clone(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
	): Promise<unknown>;
	navigate(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		targetId: string,
	): Promise<unknown>;
}

export interface PiAgentApi {
	newSession(
		clientId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiSessionCreated>;
	open(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiSessionOpenResult>;
	complete(
		clientId: string,
		sessionId: string,
		runId?: string,
		signal?: AbortSignal,
	): Promise<PiSessionJobSnapshot>;
	setExecutionMode(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		mode: PiToolExecutionMode | null,
	): Promise<PiSessionJobSnapshot>;
	state(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiAgentState>;
	prompt(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		input: { submissionId: string; prompt: string; images?: PiAttachmentRef[] },
		signal?: AbortSignal,
	): Promise<PiPromptAccepted>;
	steer(
		clientId: string,
		sessionId: string,
		jobId: string,
		message: string,
	): Promise<unknown>;
	followUp(
		clientId: string,
		sessionId: string,
		jobId: string,
		message: string,
	): Promise<unknown>;
	abort(clientId: string, sessionId: string, jobId: string): Promise<unknown>;
	compact(
		clientId: string,
		sessionId: string,
		jobId: string,
		customInstructions?: string,
	): Promise<unknown>;
	abortCompact(
		clientId: string,
		sessionId: string,
		jobId: string,
	): Promise<unknown>;
	setModel(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		provider: string,
		modelId: string,
	): Promise<unknown>;
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
		response: {
			requestId: string;
			value?: string;
			confirmed?: boolean;
			cancelled?: boolean;
		},
	): Promise<unknown>;
	/**
	 * 调用 Pi 扩展斜杠命令。
	 *
	 * 只接受 Client 已注册的调用名：Client 会先核验注册表，未注册时以
	 * `PI_EXTENSION_COMMAND_NOT_FOUND` 拒绝（Server 映射为 400），
	 * **不会**回退为一次普通模型请求。命令是否真正结束以 `waitForIdle()` 为准。
	 */
	executeCommand(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		submissionId: string,
		name: string,
		args?: string,
	): Promise<PiPromptAccepted>;
	/**
	 * 当前 Session/runtime 实际注册的扩展命令。
	 *
	 * 只含调用名与描述，**不含本地来源路径**（ADR-0040 决策 2）；清单绑定具体
	 * 运行时换代，用于阻止对已换代会话误执行旧命令。
	 */
	commands(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiExtensionCommands>;
	/** 持续 UI 状态快照（status/widget/title 的最新有界值）。 */
	extensionUi(
		clientId: string,
		sessionId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiExtensionUiSnapshot>;
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
	models(
		clientId: string,
		cwdRef: PiCwdRef,
		signal?: AbortSignal,
	): Promise<PiModelInfo[]>;
	sessions: PiSessionsApi;
	agent: PiAgentApi;
	attachments: PiAttachmentsApi;
	running(clientId: string, signal?: AbortSignal): Promise<unknown>;
	runtime(clientId: string, signal?: AbortSignal): Promise<PiRuntimeStatus>;
	/** 集中配置管理（Server 权威） */
	profiles: PiProfilesApi;
	providers: PiProvidersApi;
	credentials: PiCredentialsApi;
	bindings: PiBindingsApi;
}

/** Profile 管理（不含任何凭据材料） */
export interface PiProfilesApi {
	list(
		options?: { page?: number; pageSize?: number },
		signal?: AbortSignal,
	): Promise<PaginatedResult<PiProfileInfo>>;
	get(id: string, signal?: AbortSignal): Promise<PiProfileInfo>;
	create(
		input: PiProfileCreateInput,
		signal?: AbortSignal,
	): Promise<PiProfileInfo>;
	update(
		id: string,
		input: PiProfileUpdateInput,
		signal?: AbortSignal,
	): Promise<PiProfileInfo>;
	/**
	 * 确认新的执行语义（ADR-0039）：这是唯一能解除存量 approval/auto 待确认门控的入口。
	 * 必须携带 `expectedRevision`，服务端按 revision CAS，冲突时返回 409。
	 */
	confirmExecutionMigration(
		id: string,
		input: PiExecutionMigrationInput,
		signal?: AbortSignal,
	): Promise<PiProfileInfo>;
	remove(id: string, signal?: AbortSignal): Promise<{ ok: boolean }>;
}

/** Provider 管理：只返回非秘密配置与模型目录。 */
export interface PiProvidersApi {
	list(
		options?: { page?: number; pageSize?: number },
		signal?: AbortSignal,
	): Promise<PaginatedResult<PiProviderInfo>>;
	get(id: string, signal?: AbortSignal): Promise<PiProviderInfo>;
	create(
		input: PiProviderCreateInput,
		signal?: AbortSignal,
	): Promise<PiProviderInfo>;
	update(
		id: string,
		input: PiProviderUpdateInput,
		signal?: AbortSignal,
	): Promise<PiProviderInfo>;
	remove(id: string, signal?: AbortSignal): Promise<{ ok: boolean }>;
	validate(
		id: string,
		signal?: AbortSignal,
	): Promise<{ ok: true; providerId: string } | { ok: false; code: string }>;
	/** 对已保存 Provider 做模型发现（复用其已存凭据）。 */
	discoverModels(
		id: string,
		signal?: AbortSignal,
	): Promise<PiProviderDiscoveryResult>;
	/** 对尚未保存的目标做只读模型发现；apiKey 只用于本次请求。 */
	discover(input: PiProviderDiscoveryInput, signal?: AbortSignal): Promise<PiProviderDiscoveryResult>;
}

/** Credential 管理：响应只含安全元数据，不回显明文或密文 */
export interface PiCredentialsApi {
	list(
		options?: { page?: number; pageSize?: number },
		signal?: AbortSignal,
	): Promise<PaginatedResult<PiCredentialInfo>>;
	create(
		input: PiCredentialCreateInput,
		signal?: AbortSignal,
	): Promise<PiCredentialInfo>;
	update(
		id: string,
		input: PiCredentialUpdateInput,
		signal?: AbortSignal,
	): Promise<PiCredentialInfo>;
	revoke(id: string, signal?: AbortSignal): Promise<PiCredentialInfo>;
}

/** Client → Profile 绑定管理 */
export interface PiBindingsApi {
	list(signal?: AbortSignal): Promise<PiClientBindingInfo[]>;
	set(
		clientId: string,
		profileId: string,
		signal?: AbortSignal,
	): Promise<{ ok: boolean }>;
	clear(clientId: string, signal?: AbortSignal): Promise<{ ok: boolean }>;
}

function enc(s: string): string {
	return encodeURIComponent(s);
}

/** 创建远程 Pi REST API（机器命名空间） */
export function createPiApi(client: Pick<VcpDeckClient, "request">): PiApi {
	return {
		capability: (clientId, signal) =>
			client.request(
				"GET",
				`/api/clients/${enc(clientId)}/pi/capability`,
				undefined,
				signal,
			),

		models: (clientId, cwdRef, signal) =>
			client.request(
				"GET",
				`/api/clients/${enc(clientId)}/pi/models?${cwdQuery(cwdRef)}`,
				undefined,
				signal,
			),

		sessions: {
			importable: (clientId, signal) =>
				client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions/importable`,
					undefined,
					signal,
				),
			previewImportable: (clientId, sourceName, signal) =>
				client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/sessions/importable/${enc(sourceName)}/preview`,
					undefined,
					signal,
				),
			import: (clientId, sourceNames, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/sessions/import`,
					{ sourceNames },
					signal,
				),
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
			entryContent: (
				clientId,
				sessionId,
				entryId,
				cwdRef,
				blockIndex,
				signal,
			) => {
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
				client.request(
					"PATCH",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`,
					{
						...cwdRef,
						name,
					},
				),
			delete: (clientId, sessionId, cwdRef) =>
				client.request(
					"DELETE",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`,
					{
						...cwdRef,
					},
				),
			fork: (clientId, sessionId, cwdRef, messageId) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/fork`,
					{
						...cwdRef,
						messageId,
					},
				),
			clone: (clientId, sessionId, cwdRef) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/clone`,
					{
						...cwdRef,
					},
				),
			navigate: (clientId, sessionId, cwdRef, targetId) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/navigate`,
					{
						...cwdRef,
						targetId,
					},
				),
		},

		agent: {
			newSession: (clientId, cwdRef, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/new`,
					{ ...cwdRef },
					signal,
				),
			open: (clientId, sessionId, cwdRef, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/open`,
					cwdRef,
					signal,
				),
			complete: (clientId, sessionId, runId, signal) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/complete`,
					runId === undefined ? {} : { runId },
					signal,
				),
			setExecutionMode: async (clientId, sessionId, cwdRef, mode) =>
				parsePiSessionJobSnapshot(await client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/execution-mode`,
					{ ...cwdRef, mode },
				)),
			state: async (clientId, sessionId, cwdRef, signal) =>
				parsePiAgentState(await client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				)),
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
			steer: (clientId, sessionId, runId, message) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/steer`,
					{
						runId,
						message,
					},
				),
			followUp: (clientId, sessionId, runId, message) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/follow-up`,
					{
						runId,
						message,
					},
				),
			abort: (clientId, sessionId, runId) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort`,
					{
						runId,
					},
				),
			compact: (clientId, sessionId, runId, customInstructions) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/compact`,
					{
						runId,
						...(customInstructions ? { customInstructions } : {}),
					},
				),
				abortCompact: (clientId, sessionId, runId) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort-compact`,
					{
						runId,
					},
				),
				commands: async (clientId, sessionId, cwdRef, signal) =>
				parsePiExtensionCommands(await client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/commands?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				)),
			extensionUi: async (clientId, sessionId, cwdRef, signal) =>
				parsePiExtensionUiSnapshot(await client.request(
					"GET",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/extension-ui?${cwdQuery(cwdRef)}`,
					undefined,
					signal,
				)),
			executeCommand: (clientId, sessionId, cwdRef, submissionId, name, args) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/command`,
					{
						...cwdRef,
						submissionId,
						name,
						...(args !== undefined ? { args } : {}),
					},
				),
			setModel: (clientId, sessionId, cwdRef, provider, modelId) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/model`,
					{
						...cwdRef,
						provider,
						modelId,
					},
				),
			setThinking: (clientId, sessionId, cwdRef, level) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/thinking`,
					{
						...cwdRef,
						level,
					},
				),
			extensionResponse: (clientId, sessionId, runId, response) =>
				client.request(
					"POST",
					`/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/extension-response`,
					{ runId, ...response },
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
			client.request(
				"GET",
				`/api/clients/${enc(clientId)}/pi/running`,
				undefined,
				signal,
			),

		runtime: (clientId, signal) =>
			client.request(
				"GET",
				`/api/clients/${enc(clientId)}/pi/runtime`,
				undefined,
				signal,
			),

		providers: {
			list: (options, signal) =>
				client.request(
					"GET",
					`/api/pi/providers${listQuery(options)}`,
					undefined,
					signal,
				),
			get: (id, signal) =>
				client.request("GET", `/api/pi/providers/${enc(id)}`, undefined, signal),
			create: (input, signal) =>
				client.request("POST", "/api/pi/providers", input, signal),
			update: (id, input, signal) =>
				client.request("PATCH", `/api/pi/providers/${enc(id)}`, input, signal),
			remove: (id, signal) =>
				client.request(
					"DELETE",
					`/api/pi/providers/${enc(id)}`,
					undefined,
					signal,
				),
			validate: (id, signal) =>
				client.request(
					"POST",
					`/api/pi/providers/${enc(id)}/validate`,
					{},
					signal,
				),
			discoverModels: (id, signal) =>
				client.request(
					"POST",
					`/api/pi/providers/${enc(id)}/discover-models`,
					{},
					signal,
				),
			discover: (input, signal) =>
				client.request(
					"POST",
					"/api/pi/providers/discover-models",
					input,
					signal,
				),
		},

		profiles: {
			list: (options, signal) =>
				client.request(
					"GET",
					`/api/pi/profiles${listQuery(options)}`,
					undefined,
					signal,
				),
			get: (id, signal) =>
				client.request("GET", `/api/pi/profiles/${enc(id)}`, undefined, signal),
			create: (input, signal) =>
				client.request("POST", "/api/pi/profiles", input, signal),
			update: (id, input, signal) =>
				client.request("PATCH", `/api/pi/profiles/${enc(id)}`, input, signal),
			confirmExecutionMigration: (id, input, signal) =>
				client.request(
					"POST",
					`/api/pi/profiles/${enc(id)}/execution-migration`,
					input,
					signal,
				),
			remove: (id, signal) =>
				client.request(
					"DELETE",
					`/api/pi/profiles/${enc(id)}`,
					undefined,
					signal,
				),
		},

		credentials: {
			list: (options, signal) =>
				client.request(
					"GET",
					`/api/pi/credentials${listQuery(options)}`,
					undefined,
					signal,
				),
			create: (input, signal) =>
				client.request("POST", "/api/pi/credentials", input, signal),
			update: (id, input, signal) =>
				client.request(
					"PATCH",
					`/api/pi/credentials/${enc(id)}`,
					input,
					signal,
				),
			revoke: (id, signal) =>
				client.request(
					"DELETE",
					`/api/pi/credentials/${enc(id)}`,
					undefined,
					signal,
				),
		},

		bindings: {
			list: (signal) =>
				client.request(
					"GET",
					"/api/pi/client-bindings",
					undefined,
					signal,
				),
			set: (clientId, profileId, signal) =>
				client.request(
					"PUT",
					`/api/pi/client-bindings/${enc(clientId)}`,
					{ profileId },
					signal,
				),
			clear: (clientId, signal) =>
				client.request(
					"DELETE",
					`/api/pi/client-bindings/${enc(clientId)}`,
					undefined,
					signal,
				),
		},
	};
}

/** 分页查询串（pageSize 由 Server 限制在 1-100） */
function listQuery(options?: { page?: number; pageSize?: number }): string {
	const params = new URLSearchParams();
	if (options?.page) params.set("page", String(options.page));
	if (options?.pageSize) params.set("pageSize", String(options.pageSize));
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}
