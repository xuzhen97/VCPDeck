/**
 * 单项目 Pi Worker 子进程入口。
 * 通过 IPC 与 parent（Supervisor）通信；只服务一个 canonical cwd。
 * 主进程不静态 import Pi SDK；本文件由 fork 启动，运行时才动态加载 SDK。
 */
import {
	PI_ERROR_CODES,
	safePiErrorMessage,
	type PiAttachmentDescriptor,
	type PiClientEvent,
	type PiErrorCode,
	type PiRequest,
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
let promptPipeline: Promise<void> | null = null;
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
): Promise<PiAgentSessionWrapper> {
	if (wrapper && wrapper.sessionId === sessionId && wrapper.isAlive()) {
		return wrapper;
	}
	if (wrapper) {
		await wrapper.shutdown();
		wrapper = null;
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
		toolPolicy: runtimeConfig.spec.toolPolicy,
		bundleExtensionPaths: runtimeConfig.bundleExtensionPaths,
		initialModel: defaultModel,
		sessionFile: found.path,
	});
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
		const terminal =
			rawEvent.type === "agent_settled" || rawEvent.type === "prompt_error";
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
	let w = await ensureWrapper(run.sessionId);
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

async function dispatch(request: PiRequest): Promise<unknown> {
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
			const result = await dispatch(msg.request);
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
