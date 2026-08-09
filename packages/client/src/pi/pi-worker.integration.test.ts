import { afterEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiWorkerOutboundMessage } from "./worker-protocol.js";

/**
 * 真实 Worker 子进程集成：临时 PI_CODING_AGENT_DIR + 真实 Session JSONL。
 * 依赖已构建的 dist/pi/worker.js；构建缺失时跳过。
 */
const workerPath = join(__dirname, "../../dist/pi/worker.js");
const hasWorker = existsSync(workerPath);

let roots: string[] = [];
let seq = 0;

afterEach(async () => {
	for (const c of children) c.kill();
	children = [];
	await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
	roots = [];
	delete process.env.PI_CODING_AGENT_DIR;
});

let children: ChildProcess[] = [];

function spawnWorker(cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
	const child = fork(workerPath, [cwd], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { ...process.env, ...env },
	});
	children.push(child);
	return child;
}

function requestOnce(
	child: ChildProcess,
	request: Record<string, unknown>,
): Promise<PiWorkerOutboundMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("worker timeout")), 10_000);
		const onMessage = (msg: PiWorkerOutboundMessage) => {
			if (msg.type === "response" && msg.requestId === request.requestId) {
				clearTimeout(timer);
				child.removeListener("message", onMessage);
				resolve(msg);
			}
		};
		child.on("message", onMessage);
		child.send({ type: "request", projectKey: "k", request });
	});
}

function waitForEvent(
	child: ChildProcess,
	predicate: (message: PiWorkerOutboundMessage) => boolean,
): Promise<PiWorkerOutboundMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("worker event timeout")), 10_000);
		const onMessage = (message: PiWorkerOutboundMessage) => {
			if (!predicate(message)) return;
			clearTimeout(timer);
			child.removeListener("message", onMessage);
			resolve(message);
		};
		child.on("message", onMessage);
	});
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe.skipIf(!hasWorker)("Pi Worker 子进程集成", () => {
	it("真实 Worker 列出临时 agent 目录下的 Session", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);

		// 用真实 SDK 在临时 agent 目录创建 Session（create 延迟写盘，需手动 flush header）
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sm = SessionManager.create(cwd);
		const sessionDir = sm.getSessionDir();
		const timestamp = new Date().toISOString();
		await writeFile(
			join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_test-session.jsonl`),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-1",
				timestamp,
				cwd,
			}) + "\n",
			"utf8",
		);

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const msg = await requestOnce(child, {
			requestId: "r-list",
			action: "sessions.list",
			cwdRef: { rootDir: agentDir, relativePath: "project" },
		});
		expect(msg.type).toBe("response");
		if (msg.type === "response") {
			expect(msg.ok).toBe(true);
			if (msg.ok) {
				const sessions = (msg.data as { sessions: Array<{ id: string }> })
					.sessions;
				expect(sessions.length).toBeGreaterThanOrEqual(1);
			}
		}
	});

	it("新建 Session 返回可继续打开的真实 sessionId", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const msg = await requestOnce(child, {
			requestId: "r-new",
			action: "session.new",
			cwdRef: { rootDir: agentDir, relativePath: "project" },
		});

		expect(msg.type).toBe("response");
		if (msg.type === "response") {
			expect(msg.ok).toBe(true);
			if (msg.ok) {
				const sessionId = (msg.data as { sessionId: string }).sessionId;
				expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

				const listed = await requestOnce(child, {
					requestId: "r-new-list",
					action: "sessions.list",
					cwdRef: { rootDir: agentDir, relativePath: "project" },
				});
				expect(listed.type).toBe("response");
				if (listed.type === "response" && listed.ok) {
					const sessions = (listed.data as { sessions: Array<{ id: string }> })
						.sessions;
					expect(sessions.some((session) => session.id === sessionId)).toBe(
						true,
					);
				}

				const detail = await requestOnce(child, {
					requestId: "r-new-get",
					action: "session.get",
					sessionId,
					cwdRef: { rootDir: agentDir, relativePath: "project" },
				});
				expect(detail.type).toBe("response");
				if (detail.type === "response") expect(detail.ok).toBe(true);
			}
		}
	});
	it("已有 Session 重建时保留 JSONL 中的模型与思考深度", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					AxonHub: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "gpt-5.5",
								name: "GPT-5.5",
								reasoning: true,
								input: ["text"],
								contextWindow: 128000,
								maxTokens: 8192,
								thinkingLevelMap: { off: "none", max: "max" },
							},
							{
								id: "deepseek-v4-flash",
								name: "DeepSeek Flash",
								reasoning: true,
								input: ["text"],
								contextWindow: 128000,
								maxTokens: 8192,
								thinkingLevelMap: { off: "none", max: "max" },
							},
						],
					},
				},
			}),
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sm = SessionManager.create(cwd);
		const sessionDir = sm.getSessionDir();
		const sessionFile = join(
			sessionDir,
			`${new Date().toISOString().replace(/[:.]/g, "-")}_restore.jsonl`,
		);
		await writeFile(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "restore-session",
					timestamp: new Date().toISOString(),
					cwd,
				}),
				JSON.stringify({
					type: "model_change",
					id: "model-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					provider: "AxonHub",
					modelId: "deepseek-v4-flash",
				}),
				JSON.stringify({
					type: "thinking_level_change",
					id: "thinking-1",
					parentId: "model-1",
					timestamp: new Date().toISOString(),
					thinkingLevel: "max",
				}),
				JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: "thinking-1",
					timestamp: new Date().toISOString(),
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
						timestamp: Date.now(),
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const msg = await requestOnce(child, {
			requestId: "r-state-restore",
			action: "agent.state",
			sessionId: "restore-session",
			cwdRef: { rootDir: agentDir, relativePath: "project" },
		});

		expect(msg).toMatchObject({
			type: "response",
			ok: true,
			data: {
				model: { provider: "AxonHub", modelId: "deepseek-v4-flash" },
				thinkingLevel: "max",
			},
		});
	});

	it("只有模型与思考记录的 Session 也保留持久化偏好", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					AxonHub: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "gpt-5.5",
								reasoning: true,
								input: ["text"],
								thinkingLevelMap: { off: "none", max: "max" },
							},
							{
								id: "deepseek-v4-flash",
								reasoning: true,
								input: ["text"],
								thinkingLevelMap: { off: "none", max: "max" },
							},
						],
					},
				},
			}),
			"utf8",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sm = SessionManager.create(cwd);
		const sessionFile = join(
			sm.getSessionDir(),
			`${new Date().toISOString().replace(/[:.]/g, "-")}_prefs-only.jsonl`,
		);
		await writeFile(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "prefs-only",
					timestamp: new Date().toISOString(),
					cwd,
				}),
				JSON.stringify({
					type: "model_change",
					id: "model-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					provider: "AxonHub",
					modelId: "deepseek-v4-flash",
				}),
				JSON.stringify({
					type: "thinking_level_change",
					id: "thinking-1",
					parentId: "model-1",
					timestamp: new Date().toISOString(),
					thinkingLevel: "max",
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const msg = await requestOnce(child, {
			requestId: "r-prefs-only",
			action: "agent.state",
			sessionId: "prefs-only",
			cwdRef: { rootDir: agentDir, relativePath: "project" },
		});
		expect(msg).toMatchObject({
			type: "response",
			ok: true,
			data: {
				model: { provider: "AxonHub", modelId: "deepseek-v4-flash" },
				thinkingLevel: "max",
			},
		});
	});

	it("trust pending 可 abort，控制请求必须匹配完整 envelope", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(join(cwd, ".pi", "extensions", "test.ts"), "export default {};\n", "utf8");
		roots.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sm = SessionManager.create(cwd);
		const sessionId = sm.getSessionId();
		await writeFile(
			sm.getSessionFile()!,
			JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }) + "\n",
			"utf8",
		);

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const trustRequest = waitForEvent(child, (message) =>
			message.type === "event" && message.runId === "run-1" && message.event.type === "extension_request",
		);
		await expect(requestOnce(child, {
			requestId: "prompt-1", action: "agent.prompt", jobId: sessionId,
			sessionId, runId: "run-1", payload: { prompt: "do not run" },
		})).resolves.toMatchObject({ type: "response", ok: true, data: { accepted: true } });
		await trustRequest;

		await expect(requestOnce(child, {
			requestId: "state-wrong", action: "agent.state", jobId: sessionId,
			sessionId, runId: "run-wrong",
		})).resolves.toMatchObject({ type: "response", ok: false, error: { code: "PI_CONTROL_FORBIDDEN" } });
		await expect(requestOnce(child, {
			requestId: "state-right", action: "agent.state", jobId: sessionId,
			sessionId, runId: "run-1",
		})).resolves.toMatchObject({ type: "response", ok: true, data: { status: "waiting_for_extension_input" } });
		await expect(requestOnce(child, {
			requestId: "abort-1", action: "agent.abort", jobId: sessionId,
			sessionId, runId: "run-1",
		})).resolves.toMatchObject({ type: "response", ok: true });
		await expect(requestOnce(child, {
			requestId: "state-after", action: "agent.state", jobId: sessionId,
			sessionId, runId: "run-1",
		})).resolves.toMatchObject({ type: "response", ok: false, error: { code: "PI_CONTROL_FORBIDDEN" } });
	});

	it("parent disconnect 后 Worker 退出", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
		const exited = new Promise<number | null>((resolve) => {
			child.on("exit", (code) => resolve(code));
		});
		// 模拟 parent 进程消失：断开 IPC 通道
		child.disconnect();
		const code = await Promise.race([
			exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
		]);
		expect(code).not.toBeNull();
	});
});

describe("Pi Worker prompt pipeline seam", () => {
	it("覆盖 wrapper/trust/附件/旧事件/abort retry 的竞态矩阵", async () => {
		type EventListener = (event: {
			type: string;
			sessionId: string;
			code?: string;
			message?: string;
		}) => void;
		interface WrapperStub {
			sessionId: string;
			alive: boolean;
			listeners: EventListener[];
			send: ReturnType<typeof vi.fn>;
			getState: ReturnType<typeof vi.fn>;
			ensureProjectTrust: ReturnType<typeof vi.fn>;
			shutdown: ReturnType<typeof vi.fn>;
			isAlive: () => boolean;
			onEvent: (listener: EventListener) => () => void;
		}
		const makeWrapper = (trust: boolean | Promise<boolean> = false): WrapperStub => {
			const stub: WrapperStub = {
				sessionId: "session-1",
				alive: true,
				listeners: [],
				send: vi.fn().mockResolvedValue(null),
				getState: vi.fn(() => ({ status: "running" })),
				ensureProjectTrust: vi.fn(() => Promise.resolve(trust)),
				shutdown: vi.fn(async () => { stub.alive = false; }),
				isAlive: () => stub.alive,
				onEvent: (listener) => {
					stub.listeners.push(listener);
					return () => {
						const index = stub.listeners.indexOf(listener);
						if (index !== -1) stub.listeners.splice(index, 1);
					};
				},
			};
			return stub;
		};

		const wrapperStarts: Array<Promise<WrapperStub>> = [];
		const startPiAgentSession = vi.fn(() => {
			const next = wrapperStarts.shift();
			if (!next) throw new Error("unexpected wrapper start");
			return next;
		});
		const downloadPromptImages = vi.fn().mockResolvedValue([]);
		vi.doMock("@earendil-works/pi-coding-agent", () => ({
			SessionManager: { list: vi.fn().mockResolvedValue([{ id: "session-1", path: "session.jsonl" }]) },
		}));
		vi.doMock("./agent-session.js", () => ({ startPiAgentSession }));
		vi.doMock("./images.js", () => ({
			downloadPromptImages,
			toSdkImages: vi.fn(() => []),
		}));

		const sent: PiWorkerOutboundMessage[] = [];
		const originalArg = process.argv[2];
		const originalSend = process.send;
		const beforeMessageListeners = new Set(process.listeners("message"));
		process.argv[2] = "/tmp/pi-worker-seam";
		Object.defineProperty(process, "send", {
			configurable: true,
			value: vi.fn((message: PiWorkerOutboundMessage) => sent.push(message)),
		});
		await import("./worker.js");
		const workerListener = process.listeners("message").find(
			(listener) => !beforeMessageListeners.has(listener),
		);
		expect(workerListener).toBeDefined();

		let requestSeq = 0;
		const request = async (
			action: string,
			runId: string,
			payload?: Record<string, unknown>,
		): Promise<PiWorkerOutboundMessage> => {
			const requestId = `seam-${++requestSeq}`;
			workerListener?.({
				type: "request",
				projectKey: "project",
				request: {
					requestId,
					action,
					jobId: "session-1",
					sessionId: "session-1",
					runId,
					...(payload ? { payload } : {}),
				},
			}, {} as never);
			await vi.waitFor(() => {
				expect(sent.some((message) =>
					message.type === "response" && message.requestId === requestId,
				)).toBe(true);
			});
			return sent.find((message) =>
				message.type === "response" && message.requestId === requestId,
			)!;
		};
		const fireAndGetId = (
			action: string,
			runId: string,
			payload?: Record<string, unknown>,
		): string => {
			const requestId = `seam-${++requestSeq}`;
			workerListener?.({
				type: "request",
				projectKey: "project",
				request: { requestId, action, jobId: "session-1", sessionId: "session-1", runId, ...(payload ? { payload } : {}) },
			}, {} as never);
			return requestId;
		};

		try {
			// accepted 先于 wrapper；abort 使唯一 pipeline 失效，晚到 wrapper 只 shutdown。
			const firstWrapper = deferred<WrapperStub>();
			wrapperStarts.push(firstWrapper.promise);
			await expect(request("agent.prompt", "run-wrapper", { prompt: "never" })).resolves.toMatchObject({ ok: true, data: { accepted: true } });
			await expect(request("agent.prompt", "run-busy", { prompt: "never" })).resolves.toMatchObject({ ok: false, error: { code: "PI_PROJECT_BUSY" } });
			const abortPendingId = fireAndGetId("agent.abort", "run-wrapper");
			const wrapper = makeWrapper();
			firstWrapper.resolve(wrapper);
			await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ type: "response", requestId: abortPendingId, ok: true })));
			expect(wrapper.shutdown).toHaveBeenCalledOnce();
			expect(wrapper.send).not.toHaveBeenCalledWith("agent.prompt", expect.anything());
			await expect(request("agent.state", "run-wrapper")).resolves.toMatchObject({ ok: false, error: { code: "PI_CONTROL_FORBIDDEN" } });

			// trust=true 后重建 pending 时 abort：新 wrapper 晚到后 shutdown，不 prompt。
			const trust = deferred<boolean>();
			const restricted = makeWrapper(trust.promise);
			const rebuilt = deferred<WrapperStub>();
			wrapperStarts.push(Promise.resolve(restricted), rebuilt.promise);
			await request("agent.prompt", "run-rebuild", { prompt: "never" });
			await vi.waitFor(() => expect(restricted.ensureProjectTrust).toHaveBeenCalledOnce());
			trust.resolve(true);
			await vi.waitFor(() => expect(startPiAgentSession).toHaveBeenCalledTimes(3));
			const abortRebuildId = fireAndGetId("agent.abort", "run-rebuild");
			const rebuiltWrapper = makeWrapper();
			rebuilt.resolve(rebuiltWrapper);
			await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ type: "response", requestId: abortRebuildId, ok: true })));
			expect(rebuiltWrapper.shutdown).toHaveBeenCalledOnce();
			expect(rebuiltWrapper.send).not.toHaveBeenCalledWith("agent.prompt", expect.anything());

			// 附件失败清 matching envelope；后续 run 可进入。
			const attachmentWrapper = makeWrapper();
			wrapperStarts.push(Promise.resolve(attachmentWrapper));
			downloadPromptImages.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "PI_IMAGE_INVALID" }));
			await request("agent.prompt", "run-attachment", {
				prompt: "never",
				attachments: [{ url: "https://invalid", mimeType: "image/png", size: 1, sha256: "0".repeat(64) }],
			});
			await vi.waitFor(() => expect(sent).toContainEqual(expect.objectContaining({
				type: "event", runId: "run-attachment", event: expect.objectContaining({ type: "prompt_error", code: "PI_IMAGE_INVALID" }),
			})));
			await expect(request("agent.state", "run-attachment")).resolves.toMatchObject({ ok: false, error: { code: "PI_CONTROL_FORBIDDEN" } });

			// 旧 wrapper listener 不能清理/重标当前新 run。
			await request("agent.prompt", "run-old", { prompt: "ok" });
			await vi.waitFor(() => expect(attachmentWrapper.send).toHaveBeenCalledWith("agent.prompt", expect.anything()));
			const oldListener = attachmentWrapper.listeners[0]!;
			oldListener({ type: "agent_settled", sessionId: "session-1" });
			await request("agent.prompt", "run-current", { prompt: "ok" });
			oldListener({ type: "agent_settled", sessionId: "session-1" });
			await expect(request("agent.state", "run-current")).resolves.toMatchObject({ ok: true, data: { status: "running" } });

			// abort 失败保留 run；第二次仍到达同 wrapper 并最终清理。
			attachmentWrapper.send.mockImplementationOnce(async (action: string) => {
				if (action === "agent.abort") throw Object.assign(new Error("failed"), { code: "PI_REQUEST_TIMEOUT" });
				return null;
			});
			await expect(request("agent.abort", "run-current")).resolves.toMatchObject({ ok: false, error: { code: "PI_REQUEST_TIMEOUT" } });
			await expect(request("agent.abort", "run-current")).resolves.toMatchObject({ ok: true });
			expect(attachmentWrapper.send.mock.calls.filter(([action]) => action === "agent.abort")).toHaveLength(2);
			await expect(request("agent.state", "run-current")).resolves.toMatchObject({ ok: false, error: { code: "PI_CONTROL_FORBIDDEN" } });
		} finally {
			if (workerListener) process.removeListener("message", workerListener);
			process.argv[2] = originalArg;
			Object.defineProperty(process, "send", { configurable: true, value: originalSend });
			vi.doUnmock("@earendil-works/pi-coding-agent");
			vi.doUnmock("./agent-session.js");
			vi.doUnmock("./images.js");
		}
	});
});
