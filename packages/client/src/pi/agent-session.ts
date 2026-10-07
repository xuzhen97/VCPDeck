import type {
	AgentSession,
	AgentSessionEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import {
	PI_BUILTIN_TOOL_IDS,
	isPiThinkingLevel,
	type PiAction,
	type PiAgentState,
	type PiClientEvent,
	type PiExtensionCommand,
	type PiExtensionCommands,
	type PiExtensionUiRequest,
	type PiExtensionUiSnapshot,
	type PiExtensionUiUpdate,
	type PiExtensionWidgetPlacement,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { projectPiEvent } from "./event-projector.js";
import { activateRuntimeTools } from "./extension-host.js";
import { PiExtensionUiState } from "./extension-ui.js";
import type { PiExtensionUiView } from "./extension-ui.js";
import { filterShellTools, resolvePiShells } from "./shell.js";
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
	/** Server 下发的工具执行模式（ADR-0039 两值）：决定监督/自动如何执行。 */
	toolExecutionMode: PiToolExecutionMode;
	/** 已校验通过的 Bundle 扩展入口（为空表示不加载任何 Bundle 资源）。 */
	bundleExtensionPaths?: string[];
	sessionFile?: string;
	initialModel?: { provider: string; modelId: string };
	thinkingLevel?: ThinkingLevel;
	/** 运行时实例身份（Spec 的 specId）：命令与 UI 快照必须绑定到具体换代。 */
	runtimeInstanceId?: string | null;
	/** 运行时换代 revision；晚到的旧状态不得覆盖新状态（ADR-0040 决策 4）。 */
	runtimeRevision?: string | null;
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

/** UI 通知等级归一化：无法识别的等级按 info 处理，不把等级拼进正文。 */
function toNotifyLevel(type: string | undefined): "info" | "warning" | "error" {
	return type === "warning" || type === "error" ? type : "info";
}

/** Widget 位置归一化：未知值不带出，交由状态层使用缺省值。 */
function toWidgetPlacement(
	placement: string | undefined,
): PiExtensionWidgetPlacement | undefined {
	return placement === "aboveEditor" || placement === "belowEditor"
		? placement
		: undefined;
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
		// 模式必须在绑定扩展之前进入进程内桥接：Bundle 扩展在 factory 阶段读它。
		installToolPolicyBridge(options.toolExecutionMode);
		// shell 解析一次，同时用于两处：
		// 1. `Settings.shellPath`：SDK 构造 bash 工具时读它（`createAllToolDefinitions` →
		//    `bash: { shellPath }`），因此 bash 工具用绝对路径，不依赖宿主 PATH；
		// 2. 工具集合按平台可用性过滤：Windows 无 bash 时不能把 bash 留给模型（每次调用都报错）。
		const shells = await resolvePiShells();
		// ADR-0039：不再用 Server 逐工具目录缩小能力面。可用集合 = 平台可用内置工具 +
		// 已启用受信扩展实际注册的工具。这里只算出“平台不存在”的内置工具名，
		// 在会话构建完成后从激活集合中剔除。
		const availableBuiltins = filterShellTools(
			[...PI_BUILTIN_TOOL_IDS],
			shells,
			process.platform,
		);
		const unavailableBuiltinNames = new Set(
			PI_BUILTIN_TOOL_IDS.filter((name) => !availableBuiltins.includes(name)),
		);
		const services = await (await getSdk()).createAgentSessionServices({
			cwd: sessionManager.getCwd(),
			agentDir,
			modelRuntime: options.modelRuntime as never,
			// VCPDeck 不持久化 Pi settings，也不读用户 settings.json；但会把本机解析到的
			// bash 绝对路径注入内存 settings（SDK 的 bash 工具会直接采用）。
			settingsManager: sdk.SettingsManager.inMemory(
				shells.bash ? { shellPath: shells.bash } : {},
			),
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
			// 不传 `tools` 白名单：SDK 的 `tools` 是**全工具 allowlist**，只列内置工具会把
			// 扩展注册的工具整体过滤掉（已由 extension-host.integration.test.ts 实测锁定）。
			// 也不传 `excludeTools`：平台不可用的内置 shell 由下方 activateRuntimeTools 剔除。
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

		wrapper = new PiAgentSessionWrapperImpl(
			inner,
			options.runtimeInstanceId ?? null,
			options.runtimeRevision ?? null,
		);
		// 按运行时实际注册集合激活（内置 + 扩展），仅剔除平台不存在的 shell。
		// 两模式共用同一能力面；差别只在监督模式逐次审批（ADR-0039 决策 1）。
		activateRuntimeTools(inner, unavailableBuiltinNames);
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
	/** 扩展命令处理器是否仍在执行（期间不得把 agent_settled 当作可结算终态）。 */
	private commandRunning = false;
	/** 按会话运行时保存的 status/widget/title 有界快照（ADR-0040 决策 4）。 */
	private readonly extensionUiState = new PiExtensionUiState();
	/** 当前扩展 UI 写入句柄；运行时换代时重建，使旧句柄自动失效。 */
	private extensionUiView: PiExtensionUiView | null = null;
	private extensionsBound = false;
	private extensionBindingPromise: Promise<void> | null = null;
	private unsubscribe: (() => void) | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private onDestroyCallback: (() => void) | null = null;
	private shutdownPromise: Promise<void> | null = null;
	private _alive = true;

	constructor(
		public readonly inner: AgentSession,
		private readonly runtimeInstanceId: string | null = null,
		private readonly runtimeRevision: string | null = null,
	) {}

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
				this.commandRunning ||
				this.inner.isStreaming ||
				this.inner.isCompacting ||
				this.pendingUi !== null ||
				this.extensionUiQueue.length > 0)
		);
	}

	start(): void {
		this.unsubscribe = this.inner.subscribe((event: AgentSessionEvent) => {
			// 命令运行期间不得透传 agent_settled：那只是命令内部启动的 Agent 工作结束了，
			// 命令处理器本身可能仍在执行。把它当终态会让 Worker/Server 提前释放项目锁，
			// 下一条消息就会撞上 ``Project has an active turn``（ADR-0040 决策 2）。
			// 命令真正完成时由 `agent.command` 分支在 `waitForIdle()` 后补发 prompt_done。
			if (this.commandRunning && event.type === "agent_settled") return;
			const projected = projectPiEvent(event, this.sessionId);
			if (!projected) return;
			if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
			this.emit(projected);
		});
		this.resetIdleTimer();
		// 会话建立即绑定当前运行时换代；之后 Worker 换代会重建会话并重新绑定。
		this.bindExtensionUiRuntime(this.runtimeInstanceId, this.runtimeRevision);
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
						// 普通 Prompt 不展开模板：网页上未注册的 `/xxx` 必须被当普通文本或直接拒绝，
						// 不能在这里静默变成扩展命令（ADR-0040 决策 2）。
						expandPromptTemplates: false,
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
			case "agent.command": {
				// 只接受已注册的调用名：未注册的斜杠输入不得回退为普通模型请求
				// （真实 SDK 下那会变成一次缺凭据的模型调用，见 extension-host 集成测试）。
				const name = payload.name as string;
				const args = typeof payload.args === "string" ? payload.args : "";
				if (!this.inner.extensionRunner.getCommand(name)) {
					return {
						ok: false,
						error: {
							code: "PI_EXTENSION_COMMAND_NOT_FOUND",
							message: `Unknown Pi command: ${name}`,
						},
					};
				}
				this.commandRunning = true;
				this.promptRunning = true;
				void (async () => {
					try {
						await this.inner.prompt(args ? `/${name} ${args}` : `/${name}`, {
							source: "rpc",
						});
						// 命令处理器返回不等于回合结束：它可能还启动了 Agent 工作或有待回答问题。
						// 必须等到权威空闲才能对外宣称完成（ADR-0040 决策 2）。
						await this.inner.waitForIdle();
						this.promptRunning = false;
						this.commandRunning = false;
						this.resetIdleTimer();
						this.emit({ type: "prompt_done", sessionId: this.sessionId });
					} catch (error: unknown) {
						this.promptRunning = false;
						this.commandRunning = false;
						this.resetIdleTimer();
						this.emit({
							type: "prompt_error",
							sessionId: this.sessionId,
							code: "PI_RUNTIME_UNAVAILABLE",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				})();
				return { accepted: true };
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
			case "extension.ui.get":
				// 拉取式投影：网页重连后读取最新有界快照，不重放历史更新。
				return this.extensionUiSnapshot();
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

	private async getCommands(): Promise<PiExtensionCommands> {
		const { runtimeInstanceId, runtimeRevision } = this;
		// ADR-0040 决策 2：命令必须绑定到具体运行时换代，否则网页可能对已换代的会话
		// 误执行旧命令。身份未就绪时不得编造占位值，直接报稳定的运行时不可用错误。
		if (runtimeInstanceId === null || runtimeRevision === null) {
			throw Object.assign(new Error("Pi runtime identity unavailable"), {
				code: "PI_RUNTIME_UNAVAILABLE",
			});
		}
		const commands: PiExtensionCommand[] = [];
		// 等扩展注册完成：刚建好的会话可能在异步绑定中，此时查会得到空清单，
		// 让网页误以为"没有任何命令"。
		await this.ensureExtensionsBound().catch(() => {});
		for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
			commands.push({
				name: registered.invocationName,
				description:
					typeof registered.description === "string" ? registered.description : "",
			});
		}
		// ADR-0040 决策 2：只投影扩展实际注册的调用名与描述。
		// - 不含 Skills 与 Prompt 模板（本期不顺带开放）；
		// - 丢弃 sourceInfo（内含本地来源路径，属敏感信息）。
		return {
			runtimeInstanceId,
			runtimeRevision,
			commands,
		};
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
				// 等级必须走 `level` 字段；不得拼进正文（否则网页无法区分样式，也无法过滤）。
				this.applyExtensionUiUpdate({
					kind: "notify",
					message,
					level: toNotifyLevel(type),
				});
			},
			setStatus: (key: string, text?: string) => {
				// 省略 text 即清除该 key；空串是合法文本，两者语义不同。
				this.applyExtensionUiUpdate({
					kind: "setStatus",
					key,
					...(text === undefined ? {} : { text }),
				});
			},
			setWidget: (
				key: string,
				content?: unknown,
				options?: { placement?: string },
			) => {
				// 非字符串数组内容无法映射为有界文本行，按 SDK 非终端模式降级为清除。
				const lines = Array.isArray(content)
					? content.filter((line): line is string => typeof line === "string")
					: undefined;
				const placement = toWidgetPlacement(options?.placement);
				this.applyExtensionUiUpdate({
					kind: "setWidget",
					key,
					...(content === undefined ? {} : { lines: lines ?? [] }),
					...(placement ? { placement } : {}),
				});
			},
			setTitle: (title: string) => {
				this.applyExtensionUiUpdate({ kind: "setTitle", title });
			},
			pasteToEditor: (text: string) => {
				this.applyExtensionUiUpdate({
					kind: "set_editor_text",
					requestId: randomUUID(),
					text,
				});
			},
			setEditorText: (text: string) => {
				this.applyExtensionUiUpdate({
					kind: "set_editor_text",
					requestId: randomUUID(),
					text,
				});
			},
			custom: () => {
				// ADR-0040 决策 3：custom 返回 undefined，不承诺任意终端布局。
				// 以 notify 告警说明降级，不伪造一个看似成功的 status。
				this.applyExtensionUiUpdate({
					kind: "notify",
					message: "custom UI 在网页不受支持，已按非终端模式降级",
					level: "warning",
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

	/**
	 * 绑定扩展 UI 状态的运行时换代。
	 *
	 * Worker 在运行时初始化时调用；传入新的身份/revision 会使旧句柄失效，
	 * 从而阻止换代后迟到的旧状态覆盖新状态（ADR-0040 决策 4）。
	 */
	bindExtensionUiRuntime(instanceId: string | null, revision: string | null): void {
		this.extensionUiView = this.extensionUiState.bind(instanceId, revision);
	}

	/** 当前持续 UI 快照（浏览器重连时拉取最新值，不重放历史更新）。 */
	extensionUiSnapshot(): PiExtensionUiSnapshot {
		return this.extensionUiState.snapshot();
	}

	/**
	 * 应用一条扩展 UI 更新。
	 *
	 * status/widget/title 是持续状态，写入有界快照；notify/set_editor_text 是一次性投影，
	 * 不入快照，直接转发。被拒绝的状态变更不伪造成功，也不报告为已应用。
	 */
	private applyExtensionUiUpdate(update: PiExtensionUiUpdate): void {
		this.extensionUiView ??= this.extensionUiState.bind(this.sessionId, null);
		const result = this.extensionUiView.apply(update);
		if (result.applied || result.reason !== "TRANSIENT") return;
		switch (update.kind) {
			case "notify":
				this.emitUi({
					kind: "notify",
					title: undefined,
					message: update.message,
				});
				return;
			case "set_editor_text":
				this.emitUi({
					kind: "set_editor_text",
					title: undefined,
					message: update.text,
				});
				return;
			default:
				return;
		}
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
