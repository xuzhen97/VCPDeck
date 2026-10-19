import {
	type AcpAdapterEvent,
	type AcpPermissionOutcome,
	type AcpPermissionRequest,
	parseAcpPermissionRequest,
	parseAcpPromptResult,
	parseAcpSessionUpdate,
} from "@vcpdeck/shared";
import {
	spawnAcpProcess,
	type AcpProcess,
} from "./acp-process.js";

export interface AcpHostOptions {
	command: string;
	args: string[];
	cwd: string;
	/** 续接既有 ACP 会话；存在时 start() 走 `session/resume` 而不是 `session/new`。 */
	resumeSessionId?: string;
	env?: NodeJS.ProcessEnv;
	onEvent: (event: AcpAdapterEvent) => void;
	onPermission?: (
		request: AcpPermissionRequest,
	) => Promise<AcpPermissionOutcome>;
	onExit?: (info: {
		code: number | null;
		signal: NodeJS.Signals | null;
	}) => void;
}

export interface AcpHost {
	start(): Promise<{
		sessionId: string;
		agentInfo?: unknown;
		capabilities?: unknown;
	}>;
	prompt(text: string): Promise<{ stopReason: string }>;
	cancel(): Promise<void>;
	close(): Promise<void>;
}

function acpError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelled(): AcpPermissionOutcome {
	return { outcome: "cancelled" };
}

/** 单会话 ACP Host：只声明 v1 基础能力，不声明 fs/terminal。 */
export function createAcpHost(options: AcpHostOptions): AcpHost {
	let process: AcpProcess | null = null;
	let sessionId: string | null = null;
	let activePrompt = false;
	let closed = false;

	const handleNotification = (message: {
		method: string;
		params?: unknown;
	}): void => {
		if (message.method !== "session/update") return;
		if (!isRecord(message.params)) return;
		try {
			const event = parseAcpSessionUpdate(message.params.update);
			if (event !== null) options.onEvent(event);
		} catch {
			// 已知 variant 的非法载荷不把会话杀掉；保留进程供后续 Turn。
			options.onEvent({
				type: "session.ended",
				reason: "error",
			});
		}
	};

	const handleRequest = async (request: {
		id: string | number;
		method: string;
		params?: unknown;
	}): Promise<unknown> => {
		if (request.method !== "session/request_permission") {
			throw acpError("ACP_METHOD_UNSUPPORTED", "ACP method unsupported");
		}
		const permission = parseAcpPermissionRequest(
			request.params,
			String(request.id),
		);
		const callback = options.onPermission;
		if (!callback) return { outcome: cancelled() };
		const timeout = new Promise<AcpPermissionOutcome>((resolve) => {
			setTimeout(() => resolve(cancelled()), 5 * 60_000);
		});
		const outcome = await Promise.race([
			callback(permission).catch(() => cancelled()),
			timeout,
		]);
		return { outcome };
	};

	const onExit = (info: {
		code: number | null;
		signal: NodeJS.Signals | null;
	}): void => {
		sessionId = null;
		if (!closed) {
			closed = true;
			options.onEvent({ type: "session.ended", reason: "exited" });
		}
		options.onExit?.(info);
	};

	const ensureProcess = (): AcpProcess => {
		if (!process) {
			throw acpError("ACP_NOT_STARTED", "ACP host is not started");
		}
		return process;
	};

	return {
		async start() {
			if (sessionId) return { sessionId };
			if (closed) throw acpError("ACP_CLOSED", "ACP host is closed");
			process = spawnAcpProcess({
				command: options.command,
				args: options.args,
				cwd: options.cwd,
				env: options.env,
				onNotification: handleNotification,
				onRequest: handleRequest,
				onExit,
			});
			const initialized = await process.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "vcpdeck", version: "1.0.0" },
			});
			if (!isRecord(initialized) || initialized.protocolVersion !== 1) {
				await process.kill();
				process = null;
				throw acpError(
					"ACP_VERSION_UNSUPPORTED",
					"ACP agent does not support protocol version 1",
				);
			}
			let createdSessionId: string;
			if (options.resumeSessionId) {
				try {
					const resumed = await process.request("session/resume", {
						sessionId: options.resumeSessionId,
						cwd: options.cwd,
						mcpServers: [],
					});
					// DSH 的 resume 回包不含 sessionId，按请求值兜底
					createdSessionId =
						isRecord(resumed) && typeof resumed.sessionId === "string"
							? resumed.sessionId
							: options.resumeSessionId;
				} catch (cause) {
					await process.kill();
					process = null;
					throw acpError(
						"ACP_RESUME_FAILED",
						cause instanceof Error
							? cause.message
							: "ACP session/resume failed",
					);
				}
			} else {
				const created = await process.request("session/new", {
					cwd: options.cwd,
					mcpServers: [],
				});
				if (
					!isRecord(created) ||
					typeof created.sessionId !== "string" ||
					created.sessionId.length === 0
				) {
					await process.kill();
					process = null;
					throw acpError(
						"ACP_SESSION_INVALID",
						"ACP session/new returned no sessionId",
					);
				}
				createdSessionId = created.sessionId;
			}
			sessionId = createdSessionId;
			return {
				sessionId,
				agentInfo: initialized.agentInfo,
				capabilities: initialized.agentCapabilities,
			};
		},

		async prompt(text: string) {
			const current = ensureProcess();
			if (!sessionId) throw acpError("ACP_NOT_STARTED", "ACP session is not ready");
			if (activePrompt) throw acpError("ACP_BUSY", "ACP prompt is already running");
			activePrompt = true;
			try {
				const result = await current.request(
					"session/prompt",
					{
						sessionId,
						prompt: [{ type: "text", text }],
					},
					10 * 60_000,
				);
				return parseAcpPromptResult(result);
			} finally {
				activePrompt = false;
			}
		},

		async cancel() {
			if (!process || !sessionId) return;
			process.notify("session/cancel", { sessionId });
		},

		async close() {
			closed = true;
			if (!process) return;
			if (sessionId) {
				await process
					.request("session/close", { sessionId }, 5_000)
					.catch(() => undefined);
			}
			sessionId = null;
			await process.kill();
			process = null;
		},
	};
}
