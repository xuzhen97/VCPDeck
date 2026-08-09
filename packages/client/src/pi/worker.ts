/**
 * 单项目 Pi Worker 子进程入口。
 * 通过 IPC 与 parent（Supervisor）通信；只服务一个 canonical cwd。
 * 主进程不静态 import Pi SDK；本文件由 fork 启动，运行时才动态加载 SDK。
 */
import type { PiAttachmentDescriptor, PiErrorCode, PiRequest } from "@vcpdeck/shared";
import {
	createPiSessionReader,
	type PiSessionReader,
} from "./session-reader.js";
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

const reader: PiSessionReader = createPiSessionReader(cwd);
let wrapper: PiAgentSessionWrapper | null = null;
interface ActivePrompt {
	jobId: string;
	runId: string;
	sessionId: string;
	cancelToken: { cancelled: boolean };
}
let active: ActivePrompt | null = null;
let promptPipeline: Promise<void> | null = null;
let lastActivity = Date.now();

function send(msg: PiWorkerOutboundMessage): void {
	if (process.send) process.send(msg);
}

function normalizeError(err: unknown): { code: PiErrorCode; message: string } {
	if (typeof err === "object" && err !== null && "code" in err) {
		return {
			code: String((err as { code: unknown }).code) as PiErrorCode,
			message: err instanceof Error ? err.message : "Request failed",
		};
	}
	if (err instanceof Error)
		return { code: "PI_RUNTIME_UNAVAILABLE", message: err.message };
	return { code: "PI_RUNTIME_UNAVAILABLE", message: String(err) };
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
	const sessions = await (await getSdk()).SessionManager.list(cwd);
	const found = sessions.find((s) => s.id === sessionId);
	if (!found) {
		throw Object.assign(new Error("Session not found"), {
			code: "PI_SESSION_NOT_FOUND",
		});
	}
	const w = await startPiAgentSession({ cwd, sessionFile: found.path });
	w.onEvent((event) => {
		const run = active;
		if (!run || event.sessionId !== run.sessionId) return;
		if (event.type === "agent_settled" || event.type === "prompt_error") {
			run.cancelToken.cancelled = true;
			active = null;
			promptPipeline = null;
		}
		send({
			type: "event",
			sessionId: run.sessionId,
			jobId: run.jobId,
			runId: run.runId,
			event,
		});
	});
	wrapper = w;
	return w;
}

function isCurrentRun(run: ActivePrompt): boolean {
	return active === run && !run.cancelToken.cancelled;
}

function emitPromptError(run: ActivePrompt, error: unknown): void {
	if (!isCurrentRun(run)) return;
	active = null;
	promptPipeline = null;
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
	if (!isCurrentRun(run)) {
		await w.shutdown();
		return;
	}
	const trusted = await w.ensureProjectTrust();
	if (!isCurrentRun(run)) {
		await w.shutdown();
		if (wrapper === w) wrapper = null;
		return;
	}
	if (trusted) {
		await w.shutdown();
		if (wrapper === w) wrapper = null;
		if (!isCurrentRun(run)) return;
		w = await ensureWrapper(run.sessionId);
		if (!isCurrentRun(run)) {
			await w.shutdown();
			return;
		}
	}
	const payload = { ...(request.payload ?? {}) };
	if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
		const downloaded = await downloadPromptImages(payload.attachments as PiAttachmentDescriptor[]);
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
			// 项目级模型列表：可用模型 ∩ enabledModels（无 session 依赖）
			const settings = (await getSdk()).SettingsManager.create(
				cwd,
				(await getSdk()).getAgentDir(),
			);
			const runtime = await (await getSdk()).ModelRuntime.create();
			const available = await runtime.getAvailable();
			const enabled = settings.getEnabledModels();
			if (!enabled || enabled.length === 0) {
				return {
					models: available.map((m) => ({
						provider: m.provider,
						modelId: m.id,
					})),
				};
			}
			const { resolveModelScopeWithDiagnostics } = await import(
				"@earendil-works/pi-coding-agent"
			);
			const { scopedModels } = await resolveModelScopeWithDiagnostics(
				enabled,
				runtime,
			);
			const allowed = new Set(
				scopedModels.map((s) => `${s.model.provider}/${s.model.id}`),
			);
			return {
				models: available
					.filter((m) => allowed.has(`${m.provider}/${m.id}`))
					.map((m) => ({ provider: m.provider, modelId: m.id })),
			};
		}
		default: {
			const sessionId = request.sessionId ?? active?.sessionId;
			if (!sessionId) throw Object.assign(new Error("sessionId required"), { code: "PI_PROTOCOL_INVALID" });
			if (request.action === "agent.state" && !request.runId) return reader.state(sessionId);
			if (request.action === "agent.prompt") {
				if (active) throw Object.assign(new Error("Pi project is busy"), { code: "PI_PROJECT_BUSY" });
				const run: ActivePrompt = {
					jobId: request.jobId ?? "",
					runId: request.runId ?? "",
					sessionId,
					cancelToken: { cancelled: false },
				};
				active = run;
				promptPipeline = runPrompt(run, request);
				void promptPipeline.catch((error) => emitPromptError(run, error));
				return { accepted: true };
			}
			if (!active || (request.runId && request.runId !== active.runId)) {
				throw Object.assign(new Error("No matching active run"), { code: "PI_CONTROL_FORBIDDEN" });
			}
			if (request.action === "agent.abort") {
				const run = active;
				run.cancelToken.cancelled = true;
				active = null;
				const pipeline = promptPipeline;
				promptPipeline = null;
				const w = wrapper;
				if (w) await w.send("agent.abort", request.payload ?? {});
				await pipeline?.catch(() => {});
				return null;
			}
			const w = await ensureWrapper(sessionId);
			if (!active || (request.runId && request.runId !== active.runId)) throw Object.assign(new Error("No matching active run"), { code: "PI_CONTROL_FORBIDDEN" });
			return request.action === "agent.state" ? w.getState() : w.send(request.action, request.payload ?? {});
		}
	}
}

async function handleMessage(msg: PiWorkerRequestMessage): Promise<void> {
	lastActivity = Date.now();
	try {
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
