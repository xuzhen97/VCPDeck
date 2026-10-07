/**
 * 单项目 Pi Worker 子进程入口。
 * 通过 IPC 与 parent（Supervisor）通信；只服务一个 canonical cwd。
 * 主进程不静态 import Pi SDK；本文件由 fork 启动，运行时才动态加载 SDK。
 */
import {
	PI_ERROR_CODES,
	safePiErrorMessage,
	isPiToolExecutionMode,
	parsePiRequest,
	type PiAttachmentDescriptor,
	type PiClientEvent,
	type PiErrorCode,
	type PiRequest,
	type PiToolExecutionMode,
} from "@vcpdeck/shared";
import { join } from "node:path";
import {
	createPiSessionReader,
	type PiSessionReader,
} from "./session-reader.js";
import { loadOrCreateInstallSecret, sessionNamespaceFor } from "./install-secret.js";
import {
	createModelRuntimeWithLease,
	effectiveDefaultModel,
	type PiRuntimeConfig,
} from "./runtime-spec.js";
import { canonicalPath } from "./project-path.js";
import { existsSync } from "node:fs";
import { discoverRoots } from "../filesystem-roots.js";
import {
	collectImportableSessions,
	importNativeSessions,
	nativeSessionRoot,
	previewNativeSession,
} from "./native-session-import.js";
import {
	ensureVcpPiRuntimeDirs,
	resolveVcpPiRuntimePaths,
} from "./runtime-paths.js";
import {
	startPiAgentSession,
	type PiAgentSessionWrapper,
} from "./agent-session.js";
import { downloadPromptImages, toSdkImages } from "./images.js";
import type {
	PiWorkerOutboundMessage,
	PiWorkerRequestMessage,
} from "./worker-protocol.js";

const cwd = process.argv[2] ?? "";

if (!cwd) {
	process.exit(1);
}

/** Pi SDK 是 ESM-only；CJS 下必须动态 import */
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
let sdkPromise: Promise<PiSdk> | null = null;
function getSdk(): Promise<PiSdk> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

/**
 * VCPDeck Pi 运行时与 Session reader：惰性初始化（CJS 不支持顶层 await）。
 * sessionDir 由安装级 secret 派生的稳定 namespace 决定，绝不使用 SDK 默认目录。
 */
let runtimePromise: Promise<{
	sessionDir: string;
	reader: PiSessionReader;
}> | null = null;

function getRuntime(): Promise<{ sessionDir: string; reader: PiSessionReader }> {
	if (!runtimePromise) {
		runtimePromise = (async () => {
			const paths = resolveVcpPiRuntimePaths();
			await ensureVcpPiRuntimeDirs(paths);
			const secret = await loadOrCreateInstallSecret(paths.installSecretPath);
			const sessionDir = join(
				paths.sessionsRoot,
				sessionNamespaceFor(canonicalPath(cwd), secret),
			);
			return { sessionDir, reader: createPiSessionReader(cwd, sessionDir) };
		})();
	}
	return runtimePromise;
}

/** Server 下发的运行配置与凭据 lease：只存在于本进程内存，不落盘、不入日志。 */
let runtimeConfig: PiRuntimeConfig | null = null;
/** 已注入的 ModelRuntime（与 runtimeConfig 同生命周期）。 */
let modelRuntimePromise: Promise<unknown> | null = null;
let wrapper: PiAgentSessionWrapper | null = null;
let wrapperExecutionMode: PiToolExecutionMode | null = null;

/** 用 lease 惰性构造 ModelRuntime（凭据只在内存）。 */
function getModelRuntime(): Promise<unknown> {
	if (!modelRuntimePromise) {
		const config = runtimeConfig;
		if (!config) return Promise.reject(new Error("Pi runtime config is unavailable"));
		modelRuntimePromise = createModelRuntimeWithLease(
			{
				issuedAt: new Date().toISOString(),
				entries: config.credentialEntries,
			},
			config.spec.providers,
		).then((created) => created.runtime);
	}
	return modelRuntimePromise;
}
interface ActivePrompt {
	jobId: string;
	runId: string;
	sessionId: string;
	cancelToken: { cancelled: boolean };
	unsubscribe: (() => void) | null;
}
let active: ActivePrompt | null = null;
let promptPipeline: Promise<unknown> | null = null;
const settledRunIds = new Map<string, { jobId: string; sessionId: string }>();
const MAX_SETTLED_RUN_IDS = 32;
let lastActivity = Date.now();

const PI_ERROR_CODE_SET: ReadonlySet<string> = new Set(PI_ERROR_CODES);
const PI_ERROR_MESSAGES: Record<PiErrorCode, string> = {
	PI_PROTOCOL_INVALID: "Invalid Pi request",
	PI_CLIENT_UNSUPPORTED: "Pi client is unsupported",
	PI_NODE_UNSUPPORTED: "Node.js version is unsupported",
	PI_BASH_NOT_FOUND: "Bash is unavailable",
	PI_RUNTIME_UNAVAILABLE: "Pi runtime is unavailable",
	PI_AUTH_UNAVAILABLE: "Pi authentication is unavailable",
	PI_MODEL_NOT_FOUND: "Pi model was not found",
	PI_PROJECT_NOT_ALLOWED: "Pi project is not allowed",
	PI_SESSION_NOT_FOUND: "Pi session was not found",
	PI_PROJECT_BUSY: "Pi project is busy",
	PI_CONTROL_FORBIDDEN: "No matching active Pi run",
	PI_CLIENT_DISCONNECTED: "Pi client is disconnected",
	PI_WORKER_EXITED: "Pi worker exited",
	PI_CLIENT_RESTARTED: "Pi client restarted",
	PI_IMAGE_INVALID: "Pi image is invalid",
	PI_IMAGE_TOO_LARGE: "Pi image is too large",
	PI_REQUEST_TIMEOUT: "Pi request timed out",
	PI_STATE_PENDING: "Pi state is pending",
	PI_CONFIG_UNAVAILABLE: "Pi configuration is unavailable",
	PI_CREDENTIAL_UNAVAILABLE: "Pi credentials are unavailable",
	PI_RUNTIME_SPEC_INCOMPATIBLE: "Pi runtime spec is incompatible",
	PI_PROVIDER_VALIDATION_FAILED: "Pi provider validation failed",
	PI_BUNDLE_UNAVAILABLE: "Pi resource bundle is unavailable",
	PI_POLICY_UNAVAILABLE: "Pi tool policy is unavailable",
	PI_TOOL_POLICY_DENIED: "Tool call was denied by policy",
	PI_TOOL_POLICY_REJECTED: "Tool call was not approved",
	PI_EXECUTION_CONFIRMATION_REQUIRED: "Pi execution mode needs explicit confirmation",
	PI_EXTENSION_COMMAND_NOT_FOUND: "Pi extension command was not found",
	PI_EXTENSION_UNSUPPORTED: "Pi extension operation is unsupported",
	PI_EXTENSION_UI_LIMIT_EXCEEDED: "Pi extension UI state exceeded limits",
};

function send(msg: PiWorkerOutboundMessage): void {

	if (process.send) process.send(msg);
}

function normalizeError(err: unknown): {
	code: PiErrorCode;
	message: string;
} {
	const rawCode =
		typeof err === "object" && err !== null && "code" in err
			? String((err as { code: unknown }).code)
			: "PI_RUNTIME_UNAVAILABLE";
	const code = PI_ERROR_CODE_SET.has(rawCode)
		? (rawCode as PiErrorCode)
		: "PI_RUNTIME_UNAVAILABLE";
	return { code, message: safePiErrorMessage(PI_ERROR_MESSAGES[code]) };
}

async function ensureWrapper(
	sessionId: string,
	executionMode: PiToolExecutionMode = runtimeConfig?.spec.toolExecutionMode ?? "supervised",
): Promise<PiAgentSessionWrapper> {
	if (wrapper && wrapper.sessionId === sessionId && wrapper.isAlive() && wrapperExecutionMode === executionMode) {
		return wrapper;
	}
	if (wrapper) {
		await wrapper.shutdown();
		wrapper = null;
		wrapperExecutionMode = null;
	}
	if (!runtimeConfig || runtimeConfig.resolvedModels.length === 0) {
		throw Object.assign(new Error("Pi runtime config is unavailable"), {
			code: "PI_CONFIG_UNAVAILABLE",
		});
	}
	const { sessionDir } = await getRuntime();
	const sessions = await (await getSdk()).SessionManager.list(cwd, sessionDir);
	const found = sessions.find((s) => s.id === sessionId);
	if (!found) {
		throw Object.assign(new Error("Session not found"), {
			code: "PI_SESSION_NOT_FOUND",
		});
	}
	const defaultModel = effectiveDefaultModel(runtimeConfig);
	wrapper = await startPiAgentSession({
		cwd,
		sessionDir,
		agentDir: resolveVcpPiRuntimePaths().agentDir,
		modelRuntime: await getModelRuntime(),
		modelScope: runtimeConfig.resolvedModels.map((model) => ({
			provider: model.provider,
			modelId: model.modelId,
		})),
		toolExecutionMode: executionMode,
		bundleExtensionPaths: runtimeConfig.bundleExtensionPaths,
		initialModel: defaultModel,
		sessionFile: found.path,
		runtimeInstanceId: runtimeConfig.spec.specId,
		runtimeRevision: runtimeConfig.spec.runtimeRevision,
	});
	wrapperExecutionMode = executionMode;
	return wrapper;
}

function matchesRun(
	run: ActivePrompt | null,
	jobId: string,
	sessionId: string,
	runId: string,
	cancelToken: ActivePrompt["cancelToken"],
): run is ActivePrompt {
	return (
		run !== null &&
		run.jobId === jobId &&
		run.sessionId === sessionId &&
		run.runId === runId &&
		run.cancelToken === cancelToken
	);
}

function matchesRequest(
	run: ActivePrompt | null,
	request: PiRequest,
): run is ActivePrompt {
	return (
		run !== null &&
		request.jobId === run.jobId &&
		request.sessionId === run.sessionId &&
		request.runId === run.runId
	);
}

function isCurrentRun(run: ActivePrompt): boolean {
	return (
		matchesRun(active, run.jobId, run.sessionId, run.runId, run.cancelToken) &&
		!run.cancelToken.cancelled
	);
}

function clearRun(run: ActivePrompt): void {
	if (!matchesRun(active, run.jobId, run.sessionId, run.runId, run.cancelToken))
		return;
	run.unsubscribe?.();
	run.unsubscribe = null;
	active = null;
	promptPipeline = null;
}

function rememberSettledRun(run: ActivePrompt): void {
	settledRunIds.set(run.runId, { jobId: run.jobId, sessionId: run.sessionId });
	if (settledRunIds.size > MAX_SETTLED_RUN_IDS) {
		settledRunIds.delete(settledRunIds.keys().next().value!);
	}
}

function bindWrapperEvents(w: PiAgentSessionWrapper, run: ActivePrompt): void {
	run.unsubscribe?.();
	run.unsubscribe = w.onEvent((rawEvent) => {
		if (rawEvent.sessionId !== run.sessionId) return;
		// 终态集合必须与 Server 的 SETTLEMENT_TRIGGERS 对齐（`prompt_done` + `agent_settled`）：
		// SDK 的 `_runAgentPrompt` 在正常路径上先发 `agent_settled`，随后 wrapper 在
		// `inner.prompt()` resolve 后补 `prompt_done`；但 SDK 在若干早退路径（扩展命令、
		// input handler 接管、`messages` 为空）根本不发 `agent_settled`，此时只有 prompt_done。
		// 若客户端只认 agent_settled，Server 按 prompt_done 收敛并放行下一条消息，客户端却
		// 一直持锁 → 用户看到 `Project has an active turn`，直到 Worker 空闲 10 分钟关闭
		// （实测 gs-local：第一条正常回答，第二条被这样拒掉，且稳定复现）。
		const terminal =
			rawEvent.type === "agent_settled" ||
			rawEvent.type === "prompt_done" ||
			rawEvent.type === "prompt_error";
		const event: PiClientEvent =
			rawEvent.type === "prompt_error"
				? {
						type: "prompt_error",
						sessionId: run.sessionId,
						...normalizeError(rawEvent),
					}
				: rawEvent;
		if (terminal && isCurrentRun(run)) {
			rememberSettledRun(run);
			clearRun(run);
		}
		send({
			type: "event",
			sessionId: run.sessionId,
			jobId: run.jobId,
			runId: run.runId,
			event,
		});
	});
}

function emitPromptError(run: ActivePrompt, error: unknown): void {
	if (!isCurrentRun(run)) return;
	clearRun(run);
	const normalized = normalizeError(error);
	send({
		type: "event",
		sessionId: run.sessionId,
		jobId: run.jobId,
		runId: run.runId,
		event: { type: "prompt_error", sessionId: run.sessionId, ...normalized },
	});
}

async function runPrompt(run: ActivePrompt, request: PiRequest): Promise<void> {
	if (!isPiToolExecutionMode(request.payload?.executionMode)) {
		throw Object.assign(new Error("Execution mode is required"), {
			code: "PI_PROTOCOL_INVALID",
		});
	}
	let w = await ensureWrapper(run.sessionId, request.payload.executionMode);
	bindWrapperEvents(w, run);
	if (!isCurrentRun(run)) {
		await w.shutdown();
		if (wrapper === w) wrapper = null;
		return;
	}
	const payload = { ...(request.payload ?? {}) };
	if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
		const downloaded = await downloadPromptImages(
			payload.attachments as PiAttachmentDescriptor[],
		);
		if (!isCurrentRun(run)) {
			await w.shutdown();
			if (wrapper === w) wrapper = null;
			return;
		}
		payload.images = toSdkImages(downloaded);
	}
	if (isCurrentRun(run)) await w.send("agent.prompt", payload);
}

/**
 * 执行扩展命令（ADR-0040 决策 2）。
 *
 * 与 runPrompt 同生命周期：绑定事件 → 校验注册名 → 发送 → 由权威空闲结算。
 * 区别在于命令处理器可能同步返回 `{ok:false}`（未注册命令），
 * 该拒绝随响应带回给 Server 映射为 400，而不是靠事件回传。
 */
async function runCommand(
	run: ActivePrompt,
	request: PiRequest,
): Promise<unknown> {
	const name = request.payload?.name;
	if (typeof name !== "string" || name.length === 0) {
		throw Object.assign(new Error("name required"), {
			code: "PI_PROTOCOL_INVALID",
		});
	}
	const w = await ensureWrapper(run.sessionId, runtimeConfig?.spec.toolExecutionMode ?? "supervised");
	bindWrapperEvents(w, run);
	if (!isCurrentRun(run)) {
		await w.shutdown();
		if (wrapper === w) wrapper = null;
		return null;
	}
	const result = (await w.send("agent.command", {
		name,
		args: typeof request.payload?.args === "string" ? request.payload.args : "",
	})) as { ok?: boolean; error?: { code: string; message: string } } | null;
	if (!isCurrentRun(run)) return null;
	if (result && result.ok === false) {
		// 未注册等拒绝：立即结算，避免留下悬挂 Run。
		clearRun(run);
		return result;
	}
	return { accepted: true };
}
async function dispatch(request: PiRequest): Promise<unknown> {
	if (request.action === "agent.prompt" && !isPiToolExecutionMode(request.payload?.executionMode)) {
		throw Object.assign(new Error("Execution mode is required"), {
			code: "PI_PROTOCOL_INVALID",
		});
	}
	const { reader } = await getRuntime();
	switch (request.action) {
		case "capability.get":
			return { available: true };
		case "sessions.list":
			return { sessions: await reader.list() };
		case "session.new":
			return await reader.newSession();
		case "session.get":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.get(request.sessionId);
		case "session.context":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.context(
				request.sessionId,
				typeof request.payload?.leafId === "string"
					? request.payload.leafId
					: undefined,
				typeof request.payload?.cursor === "string"
					? request.payload.cursor
					: undefined,
			);
		case "session.entryContent":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.entryContent(
				request.sessionId,
				String(request.payload?.entryId ?? ""),
				Number(request.payload?.blockIndex ?? 0),
			);
		case "session.rename":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			await reader.rename(
				request.sessionId,
				String(request.payload?.name ?? ""),
			);
			return { ok: true };
		case "session.delete":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			await reader.delete(request.sessionId);
			return { ok: true };
		case "session.fork":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.fork(
				request.sessionId,
				String(request.payload?.messageId ?? ""),
			);
		case "session.clone":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.clone(request.sessionId);
		case "session.navigate":
			if (!request.sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			return await reader.navigate(
				request.sessionId,
				String(request.payload?.targetId ?? ""),
			);
		case "models.list": {
			// 只返回 Spec 允许且凭据可用的模型；不得因本机 models.json 扩大（设计 §14）。
			return (runtimeConfig?.resolvedModels ?? []).map((model) => ({
				provider: model.provider,
				modelId: model.modelId,
				...(model.maxThinkingLevel
					? { maxThinkingLevel: model.maxThinkingLevel }
					: {}),
			}));
		}
		case "session.import.list": {
			// 源根固定（ADR-0031 决策 2）；只读列摘要，不读正文、不改源。
			const paths = resolveVcpPiRuntimePaths();
			return await collectImportableSessions({
				sourceRoot: nativeSessionRoot(),
				roots: await discoverRoots(),
				isImported: async (sourceName, importedCwd) => {
					if (!importedCwd) return false;
					const secret = await loadOrCreateInstallSecret(
						paths.installSecretPath,
					);
					return existsSync(
						join(
							paths.sessionsRoot,
							sessionNamespaceFor(canonicalPath(importedCwd), secret),
							sourceName,
						),
					);
				},
			});
		}
		case "session.import.preview": {
			const preview = await previewNativeSession(
				String(request.payload?.sourceName ?? ""),
				{ sourceRoot: nativeSessionRoot() },
			);
			if (!preview) {
				throw Object.assign(new Error("source session not found"), {
					code: "PI_SESSION_NOT_FOUND",
				});
			}
			return preview;
		}
		case "session.import.run": {
			const paths = resolveVcpPiRuntimePaths();
			return await importNativeSessions(
				(request.payload?.sourceNames as string[]) ?? [],
				{
					sourceRoot: nativeSessionRoot(),
					roots: await discoverRoots(),
					sessionsRoot: paths.sessionsRoot,
					installSecretPath: paths.installSecretPath,
				},
			);
		}
		default: {
			const sessionId = request.sessionId ?? active?.sessionId;
			if (!sessionId)
				throw Object.assign(new Error("sessionId required"), {
					code: "PI_PROTOCOL_INVALID",
				});
			if (request.action === "agent.state") {
				// 已接纳的 run 是运行态权威；wrapper 创建/附件准备期间还会报 idle，
				// 不能让 CLI 提前结束，也不能让 Server 在 open 时误结算并放行下一轮。
				if (active?.sessionId === sessionId &&
					(!request.runId || matchesRequest(active, request))) {
					const state = wrapper?.sessionId === sessionId
						? wrapper.getState()
						: await reader.state(sessionId);
					return state.status === "idle"
						? { ...state, status: "running", prompting: true }
						: state;
				}
				if (!request.runId) return reader.state(sessionId);
				const settled = settledRunIds.get(request.runId);
				if (
					!matchesRequest(active, request) &&
					settled &&
					settled.jobId === request.jobId &&
					settled.sessionId === sessionId
				) {
					return reader.state(sessionId);
				}
			}
			if (request.action === "agent.prompt") {
				if (!isPiToolExecutionMode(request.payload?.executionMode)) {
					throw Object.assign(new Error("Execution mode is required"), {
						code: "PI_PROTOCOL_INVALID",
					});
				}
				if (active)
					throw Object.assign(new Error("Pi project is busy"), {
						code: "PI_PROJECT_BUSY",
					});
				const run: ActivePrompt = {
					jobId: request.jobId ?? "",
					runId: request.runId ?? "",
					sessionId,
					cancelToken: { cancelled: false },
					unsubscribe: null,
				};
				active = run;
				promptPipeline = runPrompt(run, request);
				void promptPipeline.catch((error) => emitPromptError(run, error));
				return { accepted: true };
			}
			// 扩展命令与 prompt 同生命周期（ADR-0040 决策 2）：
			// 命令是启动新工作，必须由 Worker 建立 active run，复用项目互斥与结算；
			// 不得要求“已有 active run”或接受调用方自带 runId（否则可绕过互斥）。
			if (request.action === "agent.command") {
				if (typeof request.payload?.name !== "string" || request.payload.name.length === 0) {
					throw Object.assign(new Error("name required"), {
						code: "PI_PROTOCOL_INVALID",
					});
				}
				if (active)
					throw Object.assign(new Error("Pi project is busy"), {
						code: "PI_PROJECT_BUSY",
					});
				const run: ActivePrompt = {
					jobId: request.jobId ?? "",
					runId: request.runId ?? "",
					sessionId,
					cancelToken: { cancelled: false },
					unsubscribe: null,
				};
				active = run;
				promptPipeline = runCommand(run, request).then((result) => {
					// 未注册命令：明确拒绝并立即结算，绝不退化为普通 Prompt。
					return result ?? { ok: false as const, error: { code: "PI_EXTENSION_COMMAND_NOT_FOUND", message: "Unknown Pi command" } };
				}).catch((error) => {
					emitPromptError(run, error);
					throw error;
				});
				const commandResult = (await promptPipeline) as
					| { accepted: true }
					| { ok: false; error: { code: string; message: string } }
					| null;
				if (commandResult !== null && "ok" in commandResult && commandResult.ok === false) {
					return commandResult;
				}
				return { accepted: true };
			}
			// 空闲 idle mutation（model.set/thinking.set）不要求 active run；
			// 带 runId 的异常请求仍走下方严格 envelope 校验。
			if (
				(request.action === "model.set" || request.action === "thinking.set") &&
				!request.runId
			) {
				if (active)
					throw Object.assign(new Error("Pi project is busy"), {
						code: "PI_PROJECT_BUSY",
					});
				const w = await ensureWrapper(sessionId);
				return w.send(request.action, request.payload ?? {});
			}
			// 只读扩展投影（命令清单 / UI 快照）与 idle mutation 同类：
			// 不要求活跃 Run，也不改变运行态；但**不得**在活跃 Run 属于其他会话时
			// 触发 wrapper 换代（ensureWrapper 会关掉现有 wrapper，打断正在跑的回回合）。
			if (
				(request.action === "agent.commands" ||
					request.action === "extension.ui.get") &&
				!request.runId
			) {
				if (active && active.sessionId !== sessionId)
					throw Object.assign(new Error("Pi project is busy"), {
						code: "PI_PROJECT_BUSY",
					});
				const w = await ensureWrapper(sessionId);
				return w.send(request.action, request.payload ?? {});
			}
			if (!matchesRequest(active, request)) {
				throw Object.assign(new Error("No matching active run"), {
					code: "PI_CONTROL_FORBIDDEN",
				});
			}
			if (request.action === "agent.abort") {
				const run = active;
				run.cancelToken.cancelled = true;
				const pipeline = promptPipeline;
				const w = wrapper;
				if (w) await w.send("agent.abort", request.payload ?? {});
				await pipeline?.catch(() => {});
				clearRun(run);
				return null;
			}
			const run = active;
			const w = await ensureWrapper(sessionId);
			if (
				!matchesRun(
					active,
					run.jobId,
					run.sessionId,
					run.runId,
					run.cancelToken,
				)
			)
				throw Object.assign(new Error("No matching active run"), {
					code: "PI_CONTROL_FORBIDDEN",
				});
			return request.action === "agent.state"
				? w.getState()
				: w.send(request.action, request.payload ?? {});
		}
	}
}

/** 应用 Server 下发的运行配置；revision 变化必须换代（关闭现有 wrapper）。 */
function applyRuntimeConfig(config: PiRuntimeConfig | null): void {
	const previousRevision = runtimeConfig?.spec.runtimeRevision ?? null;
	const nextRevision = config?.spec.runtimeRevision ?? null;
	runtimeConfig = config;
	if (previousRevision === nextRevision) return;
	modelRuntimePromise = null;
	const stale = wrapper;
	wrapper = null;
	if (stale) void stale.shutdown().catch(() => {});
}

async function handleMessage(msg: PiWorkerRequestMessage): Promise<void> {
	lastActivity = Date.now();
	try {
		if (msg.type === "runtime-init") {
			applyRuntimeConfig(msg.config);
			return;
		}
		if (msg.type === "request") {
			const request = parsePiRequest(msg.request);
			const result = await dispatch(request);
			send({
				type: "response",
				requestId: msg.request.requestId,
				ok: true,
				data: result,
			});
		} else if (msg.type === "shutdown") {
			await shutdown();
			process.exit(0);
		}
	} catch (err) {
		const { code, message } = normalizeError(err);
		send({
			type: "response",
			requestId: msg.type === "request" ? msg.request.requestId : "",
			ok: false,
			error: { code, message },
		});
	}
}

async function shutdown(): Promise<void> {
	if (wrapper) {
		await wrapper.shutdown();
		wrapper = null;
	}
}

process.on("message", (msg: unknown) => {
	void handleMessage(msg as PiWorkerRequestMessage);
});

// parent IPC 断开 → 优雅退出，避免孤儿进程
process.on("disconnect", () => {
	void shutdown().then(() => process.exit(0));
});

// 空闲 10 分钟优雅关闭（Session 文件保留）
setInterval(() => {
	if (Date.now() - lastActivity > 10 * 60 * 1000) {
		void shutdown().then(() => process.exit(0));
	}
}, 60_000);
