import type {
	AgentSession,
	AgentSessionEvent,
	SessionEntry,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
	isPiThinkingLevel,
	type PiAction,
	type PiAgentState,
	type PiClientEvent,
	type PiExtensionUiRequest,
	type PiToolExecutionMode,
	type PiToolPolicy,
} from "@vcpdeck/shared";
import { projectPiEvent } from "./event-projector.js";
import { toolSetsFor } from "./runtime-spec.js";
import { installToolPolicyBridge } from "./tool-policy-bridge.js";

/**
 * Pi SDK 是 ESM-only；Client 编译为 CJS，静态 import 会触发
 * ERR_PACKAGE_PATH_NOT_EXPORTED，必须运行时动态 import。
 */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdkPromise: Promise<PiSdk> | null = null;
function getSdk(): Promise<PiSdk> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

/** 空闲 10 分钟后优雅关闭 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Extension dialog 缺省超时（显式 timeout 优先） */
const DEFAULT_UI_TIMEOUT_MS = 30 * 60 * 1000;

const IDLE_RESET_EVENT_TYPES = new Set([
	"agent_end",
	"agent_settled",
	"auto_compaction_end",
	"compaction_end",
]);

/**
 * Bundle 资源加载面：只加载已校验的 Bundle 扩展，并彻底关闭项目/用户资源发现。
 *
 * SDK 语义（已由 `bundle-extension.integration.test.ts` 用真实 SDK 锁定）：
 * `noExtensions: true` 只丢弃「发现来的」扩展，仍保留 `additionalExtensionPaths`。
 * 没有扩展时也不传 `additionalExtensionPaths`（等价于完全不加载扩展）。
 */
export function bundleLoaderOptions(
	extensionPaths: readonly string[],
): Record<string, unknown> {
	const base = {
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	};
	return extensionPaths.length > 0
		? { ...base, additionalExtensionPaths: [...extensionPaths] }
		: base;
}

export interface PiAgentSessionOptions {
	cwd: string;
	/** VCPDeck 专属 Session 根（必填，禁用 SDK 默认目录） */
	sessionDir: string;
	/** VCPDeck 专属 agentDir（必填，禁用 SDK 默认 ~/.pi/agent） */
	agentDir: string;
	/**
	 * 注入的 ModelRuntime（必填）：凭据由 VCPDeck 内存注入，
	 * 不读用户 auth.json / models.json（设计 §8.1）。
	 */
	modelRuntime: unknown;
	/** Server 允许且凭据可用的模型集合（Spec 的 resolvedModels） */
	modelScope: Array<{ provider: string; modelId: string }>;
	/** Server 下发的工具策略（v4 Spec 必带）：决定 tools/excludeTools 与审批面。 */
	toolPolicy: PiToolPolicy;
	/** Server 下发的工具执行模式（ADR-0033）：决定策略如何被执行。 */
	toolExecutionMode: PiToolExecutionMode;
	/** 已校验通过的 Bundle 扩展入口（为空表示不加载任何 Bundle 资源）。 */
	bundleExtensionPaths?: string[];
	sessionFile?: string;
	initialModel?: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
}

export interface PiAgentSessionWrapper {
	readonly sessionId: string;
	isAlive(): boolean;
	isRunning(): boolean;
	onEvent(listener: (event: PiClientEvent) => void): () => void;
	send(action: PiAction, payload?: Record<string, unknown>): Promise<unknown>;
	getState(): PiAgentState;
	shutdown(): Promise<void>;
	destroy(): void;
}

type UiKind = PiExtensionUiRequest["kind"];
interface PendingUi {
	request: PiExtensionUiRequest;
	resolve: (value: unknown) => void;
	timeoutMs: number;
	timer: ReturnType<typeof setTimeout> | null;
}

export function startPiAgentSession(
	options: PiAgentSessionOptions,
): Promise<PiAgentSessionWrapper> {
	return (async () => {
		const agentDir = options.agentDir;
		const sessionManager = options.sessionFile
			? (await getSdk()).SessionManager.open(
					options.sessionFile,
					options.sessionDir,
				)
			: (await getSdk()).SessionManager.create(
					options.cwd,
					options.sessionDir,
				);

		const sdk = await getSdk();
		let wrapper: PiAgentSessionWrapperImpl | null = null;
		// 策略与模式必须在绑定扩展之前进入进程内桥接：Bundle 扩展在 factory 阶段读它。
		installToolPolicyBridge(options.toolPolicy, options.toolExecutionMode);
		const { tools, excludeTools } = toolSetsFor(
			options.toolPolicy,
			options.toolExecutionMode,
		);
		const services = await (await getSdk()).createAgentSessionServices({
			cwd: sessionManager.getCwd(),
			agentDir,
			modelRuntime: options.modelRuntime as never,
			// VCPDeck 不持久化 Pi settings，也不读用户 settings.json。
			settingsManager: sdk.SettingsManager.inMemory(),
			// 只加载已校验的 Bundle 扩展；项目/用户资源恒关。
			resourceLoaderOptions: bundleLoaderOptions(
				options.bundleExtensionPaths ?? [],
			),
			resourceLoaderReloadOptions: {
				// Plan 1：项目本地资源一律不加载，不做信任交互，不读写用户 trust store。
				resolveProjectTrust: async () => false,
			},
		});

		// 模型 scope：只允许 RuntimeSpec 允许且凭据可用的模型。
		// 不读本机 settings/models.json，也不因本机配置扩大范围（设计 §14）。
		const scopedModels: Array<{
			model: unknown;
			thinkingLevel?: ThinkingLevel;
		}> = [];
		for (const ref of options.modelScope) {
			const model = services.modelRuntime.getModel(ref.provider, ref.modelId);
			if (!model) continue;
			scopedModels.push({ model });
		}
		const available = scopedModels.map(
			(entry) => entry.model as { provider: string; id: string },
		);

		const branch = sessionManager.getBranch();
		const hasExistingMessages = branch.some(
			(entry) => entry.type === "message",
		);
		const persistedModel = [...branch]
			.reverse()
			.find((entry) => entry.type === "model_change") as
			| Extract<SessionEntry, { type: "model_change" }>
			| undefined;
		const persistedThinking = [...branch]
			.reverse()
			.find((entry) => entry.type === "thinking_level_change") as
			| Extract<SessionEntry, { type: "thinking_level_change" }>
			| undefined;
		// 历史记录的模型若已不在当前 policy/凭据内则不恢复（Session 仍可读）。
		const restoredModel = persistedModel
			? available.find(
					(model) =>
						model.provider === persistedModel.provider &&
						model.id === persistedModel.modelId,
				)
			: undefined;
		const restoredThinking = persistedThinking?.thinkingLevel;
		const initial: {
			model?: unknown;
			thinkingLevel?: ThinkingLevel;
			scopedModels?: Array<{
				model: unknown;
				thinkingLevel?: ThinkingLevel;
			}>;
		} = hasExistingMessages
			? { scopedModels }
			: restoredModel || isPiThinkingLevel(restoredThinking)
				? {
						...(restoredModel ? { model: restoredModel } : {}),
						...(isPiThinkingLevel(restoredThinking)
							? { thinkingLevel: restoredThinking as ThinkingLevel }
							: {}),
					}
				: selectInitialModel(available, scopedModels, options);
		const { session: inner } = await (
			await getSdk()
		).createAgentSessionFromServices({
			services,
			sessionManager,
			// 工具集合：approval/auto 为策略白名单（allow ∪ confirm，deny 排除）；
			// yolo 为当前 Runtime 已加载的内置工具全集（ADR-0033）。
			tools,
			excludeTools,
			...(initial.model ? { model: initial.model as never } : {}),
			...(initial.thinkingLevel
				? { thinkingLevel: initial.thinkingLevel }
				: {}),
			...(initial.scopedModels?.length
				? { scopedModels: initial.scopedModels as never }
				: scopedModels.length > 0
					? { scopedModels: scopedModels as never }
					: {}),
		});

		wrapper = new PiAgentSessionWrapperImpl(inner);
		wrapper.start();
		return wrapper;
	})();
}

function selectInitialModel(
	available: readonly { provider: string; id: string }[],
	scopedModels: Array<{ model: unknown; thinkingLevel?: ThinkingLevel }>,
	options: PiAgentSessionOptions,
): { model?: unknown; thinkingLevel?: ThinkingLevel } {
	if (options.initialModel) {
		const match = available.find(
			(m) =>
				m.provider === options.initialModel?.provider &&
				m.id === options.initialModel?.modelId,
		);
		if (match) return { model: match };
	}
	const first = scopedModels[0] as
		| { model?: unknown; thinkingLevel?: ThinkingLevel }
		| undefined;
	if (first?.model) {
		return {
			model: first.model,
			thinkingLevel: first.thinkingLevel ?? options.thinkingLevel,
		};
	}
	if (available[0]) return { model: available[0] };
	return { thinkingLevel: options.thinkingLevel };
}

/** confirm 询问通过 Extension UI 事件流交给 Owner */

export class PiAgentSessionWrapperImpl implements PiAgentSessionWrapper {
	private listeners: ((event: PiClientEvent) => void)[] = [];
	private pendingUi: PendingUi | null = null;
	private extensionUiQueue: PendingUi[] = [];
	private promptRunning = false;
	private extensionsBound = false;
	private extensionBindingPromise: Promise<void> | null = null;
	private unsubscribe: (() => void) | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private onDestroyCallback: (() => void) | null = null;
	private shutdownPromise: Promise<void> | null = null;
	private _alive = true;

	constructor(public readonly inner: AgentSession) {}

	get sessionId(): string {
		return this.inner.sessionId;
	}

	isAlive(): boolean {
		return this._alive;
	}

	isRunning(): boolean {
		return (
			this._alive &&
			(this.promptRunning ||
				this.inner.isStreaming ||
				this.inner.isCompacting ||
				this.pendingUi !== null ||
				this.extensionUiQueue.length > 0)
		);
	}

	start(): void {
		this.unsubscribe = this.inner.subscribe((event: AgentSessionEvent) => {
			const projected = projectPiEvent(event, this.sessionId);
			if (!projected) return;
			if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
			this.emit(projected);
		});
		this.resetIdleTimer();
		this.beginExtensionBinding();
	}

	onEvent(listener: (event: PiClientEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const i = this.listeners.indexOf(listener);
			if (i !== -1) this.listeners.splice(i, 1);
		};
	}

	private emit(event: PiClientEvent): void {
		const withSession = {
			...event,
			sessionId: this.sessionId,
		} as PiClientEvent;
		for (const l of this.listeners) l(withSession);
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (this.isRunning()) {
				this.resetIdleTimer();
				return;
			}
			void this.shutdown().catch(() => {});
		}, IDLE_TIMEOUT_MS);
	}

	private beginExtensionBinding(): void {
		void this.ensureExtensionsBound().catch(() => {});
	}

	private ensureExtensionsBound(): Promise<void> {
		if (this.extensionsBound) return Promise.resolve();
		if (this.extensionBindingPromise) return this.extensionBindingPromise;
		this.extensionBindingPromise = (async () => {
			if (!this._alive) return;
			const uiContext = this.createExtensionUiContext();
			if (typeof this.inner.bindExtensions === "function") {
				await (
					this.inner.bindExtensions as (bindings: {
						uiContext?: unknown;
						mode?: "rpc";
						onError?: (error: {
							extensionPath: string;
							event: string;
							error: string;
						}) => void;
					}) => Promise<void>
				).call(this.inner, {
					uiContext,
					mode: "rpc",
					onError: (error) => {
						this.emit({
							type: "status_update",
							sessionId: this.sessionId,
							status: `extension_error: ${error.extensionPath}`,
						});
					},
				});
			} else {
				this.inner.extensionRunner.setUIContext?.(uiContext as never, "rpc");
			}
			this.extensionsBound = true;
		})().catch((err) => {
			throw err;
		});
		return this.extensionBindingPromise;
	}

	async send(
		action: PiAction,
		payload: Record<string, unknown> = {},
	): Promise<unknown> {
		if (!this._alive) throw new Error("Session is closed");
		this.resetIdleTimer();
		switch (action) {
			case "agent.prompt": {
				const message = payload.prompt as string;
				const images = Array.isArray(payload.images)
					? (payload.images as Array<{
							type: "image";
							data: string;
							mimeType: string;
						}>)
					: undefined;
				const streamingBehavior = payload.streamingBehavior as
					| "steer"
					| "followUp"
					| undefined;
				this.promptRunning = true;
				this.inner
					.prompt(message, {
						...(images?.length ? { images } : {}),
						...(streamingBehavior ? { streamingBehavior } : {}),
						source: "rpc",
					})
					.then(() => {
						this.promptRunning = false;
						this.resetIdleTimer();
						this.emit({ type: "prompt_done", sessionId: this.sessionId });
					})
					.catch((error: unknown) => {
						this.promptRunning = false;
						this.resetIdleTimer();
						this.emit({
							type: "prompt_error",
							sessionId: this.sessionId,
							code: "PI_RUNTIME_UNAVAILABLE",
							message: error instanceof Error ? error.message : String(error),
						});
					});
				return null;
			}
			case "agent.steer":
				await this.inner.steer(payload.message as string);
				return null;
			case "agent.followUp":
				await this.inner.followUp(payload.message as string);
				return null;
			case "agent.abort": {
				const queued = this.extensionUiQueue.splice(0);
				for (const pending of queued) {
					pending.resolve(
						pending.request.kind === "confirm" ? false : undefined,
					);
				}
				if (this.pendingUi) {
					this.finishExtensionUi(
						this.pendingUi.request.requestId,
						"cancelled",
						this.pendingUi.request.kind === "confirm" ? false : undefined,
					);
				}
				await this.inner.abort();
				await this.waitForStopped(5_000);
				return null;
			}
			case "agent.compact":
				return this.inner.compact(
					typeof payload.customInstructions === "string"
						? payload.customInstructions
						: undefined,
				);
			case "agent.abortCompact":
				this.inner.abortCompaction();
				return null;
			case "agent.state":
				return this.getState();
			case "agent.stats":
				return this.inner.getSessionStats();
			case "agent.commands":
				return this.getCommands();
			case "models.list":
				return this.listModels();
			case "model.set": {
				const provider = payload.provider as string;
				const modelId = payload.modelId as string;
				const models = (await this.listModels()) as Array<{
					provider: string;
					modelId: string;
				}>;
				const allowed = models.some(
					(m) => m.provider === provider && m.modelId === modelId,
				);
				if (!allowed) {
					return {
						ok: false,
						error: {
							code: "PI_MODEL_NOT_FOUND",
							message: `Model not found: ${provider}/${modelId}`,
						},
					};
				}
				const model = this.inner.modelRuntime.getModel(provider, modelId);
				if (!model) {
					return {
						ok: false,
						error: {
							code: "PI_MODEL_NOT_FOUND",
							message: `Model not found: ${provider}/${modelId}`,
						},
					};
				}
				await this.inner.setModel(model as never);
				return { ok: true, data: { provider, modelId } };
			}
			case "thinking.set": {
				if (!isPiThinkingLevel(payload.level)) {
					return {
						ok: false,
						error: {
							code: "PI_PROTOCOL_INVALID",
							message: "Invalid thinking level",
						},
					};
				}
				this.inner.setThinkingLevel(payload.level as ThinkingLevel);
				return null;
			}
			case "session.rename": {
				const name = (payload.name as string | undefined)?.trim();
				if (!name) {
					return {
						ok: false,
						error: {
							code: "PI_PROTOCOL_INVALID",
							message: "Session name cannot be empty",
						},
					};
				}
				this.inner.setSessionName(name);
				return { ok: true };
			}
			case "session.fork":
				return this.fork(payload.entryId as string);
			case "session.clone":
				return this.clone();
			case "session.navigate": {
				const result = await this.inner.navigateTree(
					payload.targetId as string,
					{},
				);
				return { cancelled: result.cancelled };
			}
			case "extension.respond": {
				this.resolveExtensionUiResponse(payload);
				return null;
			}
			default:
				return {
					ok: false,
					error: {
						code: "PI_PROTOCOL_INVALID",
						message: `Unsupported action: ${action}`,
					},
				};
		}
	}

	private async listModels(): Promise<unknown[]> {
		const available =
			(await this.inner.modelRuntime.getAvailable()) as readonly {
				provider: string;
				id: string;
			}[];
		const enabled = this.inner.settingsManager.getEnabledModels();
		if (!enabled || enabled.length === 0) {
			return available.map((m) => ({ provider: m.provider, modelId: m.id }));
		}
		const { scopedModels } = await (
			await getSdk()
		).resolveModelScopeWithDiagnostics(enabled, this.inner.modelRuntime);
		const allowed = new Set(
			scopedModels.map((s) => `${s.model.provider}/${s.model.id}`),
		);
		return available
			.filter((m) => allowed.has(`${m.provider}/${m.id}`))
			.map((m) => ({ provider: m.provider, modelId: m.id }));
	}

	private async getCommands(): Promise<unknown> {
		const commands: SlashCommandInfo[] = [];
		for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: registered.invocationName,
				description: registered.description,
				source: "extension",
				sourceInfo: registered.sourceInfo,
			});
		}
		for (const template of this.inner.promptTemplates) {
			commands.push({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			});
		}
		for (const skill of this.inner.resourceLoader.getSkills().skills) {
			commands.push({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			});
		}
		return { commands };
	}

	getState(): PiAgentState {
		const waiting = this.pendingUi !== null;
		let status: PiAgentState["status"];
		if (this.inner.isCompacting) {
			status = "compacting";
		} else if (waiting) {
			status = "waiting_for_extension_input";
		} else if (this.isRunning()) {
			status = "running";
		} else {
			status = "idle";
		}
		return {
			status,
			streaming: this.inner.isStreaming,
			prompting: this.promptRunning,
			compacting: this.inner.isCompacting,
			thinkingLevel: this.inner.thinkingLevel,
			queuedMessages: {
				steering: [...this.inner.getSteeringMessages()],
				followUp: [...this.inner.getFollowUpMessages()],
			},
			...(this.inner.model
				? {
						model: {
							provider: this.inner.model.provider,
							modelId: this.inner.model.id,
						},
					}
				: {}),
			waitingForExtensionInput: waiting,
			...(this.pendingUi
				? { pendingExtension: { ...this.pendingUi.request } }
				: {}),
		};
	}

	private async fork(
		entryId: string,
	): Promise<{ cancelled: boolean; newSessionId?: string }> {
		if (this.inner.isCompacting) return { cancelled: true };
		const sessionManager = this.inner.sessionManager;
		const currentSessionFile = this.inner.sessionFile;
		if (!sessionManager.isPersisted() || !currentSessionFile)
			return { cancelled: true };

		const entry = sessionManager.getEntry(entryId);
		if (!entry) return { cancelled: true };

		const sessionDir = sessionManager.getSessionDir();
		let newSessionFile: string;
		if (entry.parentId) {
			// 历史中 fork：复制到 fork 点之前
			const sourceManager = (await getSdk()).SessionManager.open(
				currentSessionFile,
				sessionDir,
			);
			const forkedPath = sourceManager.createBranchedSession(entry.parentId);
			if (!forkedPath) return { cancelled: true };
			newSessionFile = forkedPath;
		} else {
			// 首条消息前 fork：创建指向当前 Session 的空 Session
			const newManager = (await getSdk()).SessionManager.create(
				sessionManager.getCwd(),
				sessionDir,
			);
			newManager.newSession({ parentSession: currentSessionFile });
			newSessionFile = newManager.getSessionFile() as string;
		}

		const newSessionId = (await getSdk()).SessionManager.open(
			newSessionFile,
			sessionDir,
		).getSessionId();
		await this.shutdown();
		return { cancelled: false, newSessionId };
	}

	private async clone(): Promise<{
		cancelled: boolean;
		newSessionId?: string;
	}> {
		const sessionManager = this.inner.sessionManager;
		const currentSessionFile = this.inner.sessionFile;
		if (!sessionManager.isPersisted() || !currentSessionFile)
			return { cancelled: true };
		const leafId = sessionManager.getLeafId();
		if (!leafId) return { cancelled: true };
		const newPath = sessionManager.createBranchedSession(leafId);
		if (!newPath) return { cancelled: true };
		const newSessionId = (await getSdk()).SessionManager.open(
			newPath,
			sessionManager.getSessionDir(),
		).getSessionId();
		await this.shutdown();
		return { cancelled: false, newSessionId };
	}

	// ── Extension UI ──

	private createExtensionUiContext(): Record<string, unknown> {
		const ctx: Record<string, unknown> = {
			select: (title: string, options: string[], opts?: { timeout?: number }) =>
				this.requestExtensionUi("select", title, { options }, opts?.timeout),
			confirm: (title: string, message: string, opts?: { timeout?: number }) =>
				this.requestExtensionUi("confirm", title, { message }, opts?.timeout),
			input: (
				title: string,
				placeholder?: string,
				opts?: { timeout?: number },
			) =>
				this.requestExtensionUi("input", title, { placeholder }, opts?.timeout),
			editor: (title: string, prefill?: string, opts?: { timeout?: number }) =>
				this.requestExtensionUi("editor", title, { prefill }, opts?.timeout),
			notify: (message: string, type?: string) => {
				this.emitUi({
					kind: "notify",
					title: undefined,
					message,
					...(type ? { message: `${type}: ${message}` } : {}),
				});
			},
			setStatus: (key: string, text?: string) => {
				this.emitUi({ kind: "setStatus", title: key, message: text });
			},
			setWidget: (
				key: string,
				content?: unknown,
				options?: { placement?: string },
			) => {
				if (content !== undefined && !Array.isArray(content)) return;
				this.emitUi({
					kind: "setWidget",
					title: key,
					message: Array.isArray(content) ? content.join("\n") : undefined,
					...(options?.placement ? { options: [options.placement] } : {}),
				});
			},
			setTitle: (title: string) => {
				this.emitUi({ kind: "setTitle", title, message: undefined });
			},
			pasteToEditor: (text: string) => {
				this.emitUi({
					kind: "set_editor_text",
					title: undefined,
					message: text,
				});
			},
			setEditorText: (text: string) => {
				this.emitUi({
					kind: "set_editor_text",
					title: undefined,
					message: text,
				});
			},
			custom: () => {
				this.emitUi({
					kind: "notify",
					title: "Custom UI",
					message: "custom UI 不支持",
				});
				return Promise.resolve(undefined);
			},
			getEditorText: () => "",
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "unsupported" }),
		};
		return ctx;
	}

	private emitUi(req: {
		kind: UiKind;
		title: string | undefined;
		message: string | undefined;
		options?: string[];
	}): void {
		const ui: PiExtensionUiRequest = {
			requestId: randomUUID(),
			// 宿主桥发出的 UI 请求：扩展调用方 ID 不可从 SDK 回调取得，用稳定的桥接标识满足协议非空约束
			extensionId: "vcp.host-bridge",
			kind: req.kind,
			...(req.title ? { title: req.title } : {}),
			...(req.message ? { message: req.message } : {}),
			...(req.options?.length ? { options: req.options } : {}),
		};
		this.emit({ type: "extension_request", sessionId: this.sessionId, ui });
	}

	private requestExtensionUi(
		kind: UiKind,
		title: string,
		extra: Record<string, unknown>,
		explicitTimeout?: number,
	): Promise<unknown> {
		const requestId = randomUUID();
		const timeoutMs = explicitTimeout ?? DEFAULT_UI_TIMEOUT_MS;
		const ui: PiExtensionUiRequest = {
			requestId,
			extensionId: "vcp.host-bridge",
			kind,
			title,
			...(typeof extra.message === "string" ? { message: extra.message } : {}),
			...(Array.isArray(extra.options)
				? { options: extra.options as string[] }
				: {}),
			...(typeof extra.placeholder === "string"
				? { message: extra.placeholder }
				: {}),
			...(typeof extra.prefill === "string" ? { message: extra.prefill } : {}),
			timeoutMs,
		};
		return new Promise((resolve) => {
			this.extensionUiQueue.push({
				request: ui,
				resolve,
				timeoutMs,
				timer: null,
			});
			this.activateNextExtensionUi();
		});
	}

	private activateNextExtensionUi(): void {
		if (this.pendingUi || this.extensionUiQueue.length === 0) return;
		const pending = this.extensionUiQueue.shift()!;
		this.pendingUi = pending;
		pending.timer = setTimeout(() => {
			this.finishExtensionUi(
				pending.request.requestId,
				"timeout",
				pending.request.kind === "confirm" ? false : undefined,
			);
		}, pending.timeoutMs);
		this.emit({
			type: "extension_request",
			sessionId: this.sessionId,
			ui: pending.request,
		});
	}

	private finishExtensionUi(
		requestId: string,
		reason: "answered" | "cancelled" | "timeout",
		value: unknown,
	): void {
		const pending = this.pendingUi;
		if (!pending || pending.request.requestId !== requestId) return;
		this.pendingUi = null;
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = null;
		pending.resolve(value);
		this.emit({
			type: "extension_resolved",
			sessionId: this.sessionId,
			requestId,
			reason,
			hasPending: this.extensionUiQueue.length > 0,
		});
		this.activateNextExtensionUi();
	}

	private resolveExtensionUiResponse(payload: Record<string, unknown>): void {
		const requestId = payload.requestId as string | undefined;
		const pending = this.pendingUi;
		if (!requestId || !pending || pending.request.requestId !== requestId)
			return;
		if (payload.cancelled === true) {
			this.finishExtensionUi(
				requestId,
				"cancelled",
				pending.request.kind === "confirm" ? false : undefined,
			);
			return;
		}
		this.finishExtensionUi(
			requestId,
			"answered",
			pending.request.kind === "confirm"
				? payload.confirmed === true
				: typeof payload.value === "string"
					? payload.value
					: undefined,
		);
	}

	// ── 生命周期 ──

	private async waitForStopped(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (
			this.promptRunning ||
			this.inner.isStreaming ||
			this.inner.isCompacting ||
			this.pendingUi ||
			this.extensionUiQueue.length > 0
		) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw Object.assign(new Error("Pi session did not stop in time"), {
					code: "PI_REQUEST_TIMEOUT",
				});
			}
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(25, remaining)),
			);
		}
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		if (!this._alive) return;
		this.shutdownPromise = (async () => {
			try {
				try {
					if (this.extensionBindingPromise) await this.extensionBindingPromise;
				} catch {
					// 忽略绑定失败，继续销毁
				}
				await this.inner.extensionRunner.emit?.({
					type: "session_shutdown",
					reason: "quit",
				});
			} finally {
				this.destroy();
			}
		})();
		return this.shutdownPromise;
	}

	destroy(): void {
		if (!this._alive) return;
		this._alive = false;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.unsubscribe?.();
		const queued = this.extensionUiQueue.splice(0);
		for (const pending of queued) {
			pending.resolve(pending.request.kind === "confirm" ? false : undefined);
		}
		if (this.pendingUi) {
			this.finishExtensionUi(
				this.pendingUi.request.requestId,
				"cancelled",
				this.pendingUi.request.kind === "confirm" ? false : undefined,
			);
		}
		try {
			this.inner.dispose();
		} finally {
			this.onDestroyCallback?.();
		}
	}

	onDestroy(cb: () => void): void {
		this.onDestroyCallback = cb;
	}
}
