import { afterEach, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { probePiCapability } from "./capability.js";
import { loadOrCreateInstallSecret, sessionNamespaceFor } from "./install-secret.js";
import { canonicalPath } from "./project-path.js";
import {
	ensureVcpPiRuntimeDirs,
	resolveVcpPiRuntimePaths,
} from "./runtime-paths.js";
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
	delete process.env.VCPDECK_CLIENT_DATA_DIR;
});

let children: ChildProcess[] = [];

function spawnWorker(cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
	const child = fork(workerPath, [cwd], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: {
			...process.env,
			...env,
			// 未显式指定时使用该 cwd 的测试数据根，避免 Worker 写入仓库或用户目录。
			VCPDECK_CLIENT_DATA_DIR: env.VCPDECK_CLIENT_DATA_DIR ?? dataRootFor(cwd),
		},
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
		const timer = setTimeout(
			() => reject(new Error("worker event timeout")),
			10_000,
		);
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

/**
 * 每个 cwd 固定一个测试数据根：spawnWorker 与 prepareVcpSessionDir 共用同值，
 * 因此 worker 与测试夹具必然落在同一个 namespace 目录。
 */
const dataRootByCwd = new Map<string, string>();

function dataRootFor(cwd: string): string {
	let dir = dataRootByCwd.get(cwd);
	if (!dir) {
		dir = mkdtempSync(join(tmpdir(), `pi-data-${++seq}-`));
		dataRootByCwd.set(cwd, dir);
		roots.push(dir);
	}
	return dir;
}

async function prepareVcpSessionDir(cwd: string): Promise<string> {
	const paths = resolveVcpPiRuntimePaths({
		env: { VCPDECK_CLIENT_DATA_DIR: dataRootFor(cwd) },
	});
	await ensureVcpPiRuntimeDirs(paths);
	const secret = await loadOrCreateInstallSecret(paths.installSecretPath);
	const sessionDir = join(
		paths.sessionsRoot,
		sessionNamespaceFor(canonicalPath(cwd), secret),
	);
	await mkdir(sessionDir, { recursive: true });
	return sessionDir;
}

/** VCPDeck 数据根下的 Session namespace 目录名（应只有不透明 64 位 hex）。 */
function vcpSessionDirNames(dataRoot: string): Promise<string[]> {
	return readdir(join(dataRoot, "pi", "sessions"));
}

/** 递归清单 + 内容 hash：用于 native Pi 零污染门禁。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			const content = await readFile(full);
			out[relative(root, full).replace(/\\/g, "/")] = createHash("sha256")
				.update(content)
				.digest("hex");
		}
	};
	await walk(root);
	return out;
}

/**
 * 子进程集成：fork 真实 Worker 并等待 IPC 往返，
 * 在 `pnpm -r test` 并行负载下会明显慢于单元测试，故放宽单测超时。
 */
describe.skipIf(!hasWorker)("Pi Worker 子进程集成", { timeout: 30_000 }, () => {
	it("真实 Worker 列出临时 agent 目录下的 Session", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), `pi-agent-${++seq}-`));
		const cwd = join(agentDir, "project");
		await mkdir(cwd, { recursive: true });
		roots.push(agentDir);

		// 在 VCPDeck 数据根的 namespace 目录创建 Session（create 延迟写盘，需手动 flush header）
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sessionDir = await prepareVcpSessionDir(cwd);
		const sm = SessionManager.create(cwd, sessionDir);
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

	it("Session 写入 VCPDeck 数据根的 namespace 目录，且不碰用户 Pi", async () => {
		const userPi = await mkdtemp(join(tmpdir(), `pi-user-${++seq}-`));
		roots.push(userPi);
		const cwd = join(userPi, "project");
		await mkdir(cwd, { recursive: true });
		const dataRoot = dataRootFor(cwd);

		const child = spawnWorker(cwd, {
			PI_CODING_AGENT_DIR: join(userPi, "native-agent"),
			VCPDECK_CLIENT_DATA_DIR: dataRoot,
		});
		const msg = await requestOnce(child, {
			requestId: "r-vcp-new",
			action: "session.new",
			cwdRef: { rootDir: userPi, relativePath: "project" },
		});
		expect(msg.type).toBe("response");
		if (msg.type !== "response" || !msg.ok) {
			throw new Error(`session.new 未成功: ${JSON.stringify(msg)}`);
		}

		const namespaces = await vcpSessionDirNames(dataRoot);
		expect(namespaces).toHaveLength(1);
		expect(namespaces[0]).toMatch(/^[0-9a-f]{64}$/);
		const files = await readdir(join(dataRoot, "pi", "sessions", namespaces[0]));
		expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
		// 用户 Pi agentDir 不得被创建或写入
		expect(existsSync(join(userPi, "native-agent"))).toBe(false);
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
		const sessionDir = await prepareVcpSessionDir(cwd);
		const sm = SessionManager.create(cwd, sessionDir);
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
		const sessionDir = await prepareVcpSessionDir(cwd);
		const sm = SessionManager.create(cwd, sessionDir);
		const sessionFile = join(
			sessionDir,
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

	it("项目含本地扩展时不再询问信任，且不写用户 Pi agentDir", async () => {
		const nativeAgent = await mkdtemp(join(tmpdir(), `pi-native-${++seq}-`));
		roots.push(nativeAgent);
		const cwd = join(nativeAgent, "project");
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "extensions", "test.ts"),
			"export default {};\n",
			"utf8",
		);

		// 测试夹具写入 VCPDeck namespace 目录（与 worker 同源）
		const sessionDir = await prepareVcpSessionDir(cwd);
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const sm = SessionManager.create(cwd, sessionDir);
		const sessionId = sm.getSessionId();
		await writeFile(
			sm.getSessionFile()!,
			JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: new Date().toISOString(),
				cwd,
			}) + "\n",
			"utf8",
		);

		// PI_CODING_AGENT_DIR 指向哨兵目录：worker 必须忽略它，改用 VCPDeck agentDir。
		const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: nativeAgent });
		const seen: PiWorkerOutboundMessage[] = [];
		child.on("message", (message) =>
			seen.push(message as PiWorkerOutboundMessage),
		);

		const settled = waitForEvent(
			child,
			(message) =>
				message.type === "event" &&
				message.runId === "run-1" &&
				(message.event.type === "prompt_error" ||
					message.event.type === "prompt_done"),
		);
		await requestOnce(child, {
			requestId: "prompt-1",
			action: "agent.prompt",
			jobId: sessionId,
			sessionId,
			runId: "run-1",
			payload: { prompt: "hello" },
		});
		await settled;

		// 未询问项目信任
		expect(
			seen.some(
				(message) =>
					message.type === "event" &&
					message.event.type === "extension_request",
			),
		).toBe(false);
		// 用户 Pi agentDir 只应有项目目录，没有任何 VCPDeck 写入
		expect(await readdir(nativeAgent)).toEqual(["project"]);
	});

	it("native Pi 零污染：capability + Session 新建/列表 + Prompt 全程不改动用户 ~/.pi", async () => {
		const fakeHome = await mkdtemp(join(tmpdir(), `pi-home-${++seq}-`));
		roots.push(fakeHome);
		const nativeRoot = join(fakeHome, ".pi");
		const nativeAgent = join(nativeRoot, "agent");
		await mkdir(join(nativeAgent, "sessions"), { recursive: true });
		await mkdir(join(nativeAgent, "extensions"), { recursive: true });
		await writeFile(
			join(nativeAgent, "settings.json"),
			JSON.stringify({ shellPath: "C:\\tools\\bash.exe" }),
			"utf8",
		);
		await writeFile(
			join(nativeAgent, "models.json"),
			JSON.stringify({ providers: {} }),
			"utf8",
		);
		await writeFile(join(nativeAgent, "credentials-sentinel"), "sentinel", "utf8");
		await writeFile(
			join(nativeAgent, "sessions", "native-only.jsonl"),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "native-only",
				timestamp: new Date().toISOString(),
				cwd: nativeAgent,
			}) + "\n",
			"utf8",
		);
		await writeFile(
			join(nativeAgent, "sessions", "importable-native.jsonl"),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "importable-native",
					timestamp: new Date().toISOString(),
					cwd: join(fakeHome, "project"),
				}),
				JSON.stringify({
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "user",
						content: [{ type: "text", text: "用户原生 Pi 的历史问题" }],
					},
				}),
			].join("\n") + "\n",
			"utf8",
		);
		// 哨兵扩展：一旦被加载执行就会写下 loaded-sentinel
		const sentinelPath = join(nativeAgent, "extensions", "loaded-sentinel");
		await writeFile(
			join(nativeAgent, "extensions", "should-never-load.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinelPath)}, "loaded");\nexport default {};\n`,
			"utf8",
		);

		const before = await snapshotTree(nativeRoot);

		const cwd = join(fakeHome, "project");
		await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
		const projectSentinel = join(cwd, "loaded-sentinel");
		await writeFile(
			join(cwd, ".pi", "extensions", "should-never-load.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(projectSentinel)}, "loaded");\nexport default {};\n`,
			"utf8",
		);

		// 1) capability 探测（数据根指向临时目录，HOME 指向 fakeHome，不得读其 .pi）
		// probe worker 在 src 下无 .js 入口，真实 fork 由 probe-worker.real.test.ts 覆盖；
		// 本门禁关注的是「整个序列不触碰用户 Pi」。
		const capability = await probePiCapability({
			nodeVersion: process.versions.node,
			platform: process.platform,
			existsGitBash: async () => true,
			findBashInPath: async () => true,
			forkProbeWorker: async () => ({ sdkVersion: "0.86.0", providerIds: ["anthropic"], error: null }),
			ensureDataRootWritable: async () => true,
			resolveBundle: async () => null,
		});
		expect(capability.available).toBe(true);

		// 2) Session 新建 + 列表 + Prompt
		const child = spawnWorker(cwd, { HOME: fakeHome, USERPROFILE: fakeHome });
		const created = await requestOnce(child, {
			requestId: "r-new",
			action: "session.new",
			cwdRef: { rootDir: fakeHome, relativePath: "project" },
		});
		expect(created).toMatchObject({ type: "response", ok: true });
		const sessionId = (created as { data: { sessionId: string } }).data.sessionId;

		const listed = await requestOnce(child, {
			requestId: "r-list",
			action: "sessions.list",
			cwdRef: { rootDir: fakeHome, relativePath: "project" },
		});
		const ids = (
			listed as { data: { sessions: Array<{ id: string }> } }
		).data.sessions.map((s) => s.id);
		expect(ids).toContain(sessionId);
		expect(ids).not.toContain("native-only");

		const settled = waitForEvent(
			child,
			(message) =>
				message.type === "event" &&
				message.runId === "run-1" &&
				(message.event.type === "prompt_error" ||
					message.event.type === "prompt_done"),
		);
		await requestOnce(child, {
			requestId: "r-prompt",
			action: "agent.prompt",
			jobId: sessionId,
			sessionId,
			runId: "run-1",
			payload: { prompt: "hello" },
		});
		await settled;

		// 3) 导入链路（ADR-0031）：list → preview → run，源目录全程只读
		const nativeImport = "importable-native.jsonl";
		const listedImport = await requestOnce(child, {
			requestId: "i-list",
			action: "session.import.list",
		});
		expect(listedImport).toMatchObject({ type: "response", ok: true });
		const importable = (
			listedImport as { data: { sessions: Array<Record<string, unknown>> } }
		).data.sessions.find((item) => item.sourceName === nativeImport);
		expect(importable).toMatchObject({
			imported: false,
			cwdNotAllowed: false,
			unreadable: false,
			entryCount: 1,
		});
		// 摘要 canary：正文不得出现在列表响应里
		expect(JSON.stringify(listedImport)).not.toContain("用户原生 Pi 的历史问题");

		const previewed = await requestOnce(child, {
			requestId: "i-preview",
			action: "session.import.preview",
			payload: { sourceName: nativeImport },
		});
		expect(previewed).toMatchObject({
			type: "response",
			ok: true,
			data: { previewText: "用户原生 Pi 的历史问题", truncated: false },
		});

		const runFirst = await requestOnce(child, {
			requestId: "i-run",
			action: "session.import.run",
			payload: { sourceNames: [nativeImport] },
		});
		expect(runFirst).toMatchObject({ type: "response", ok: true });
		expect(runFirst).toMatchObject({
			data: { results: [{ sourceName: nativeImport, status: "imported" }] },
		});

		// 幂等：副本已存在 → alreadyImported（同时证明副本落在 VCPDeck 数据根而非源目录）
		const runSecond = await requestOnce(child, {
			requestId: "i-run-2",
			action: "session.import.run",
			payload: { sourceNames: [nativeImport] },
		});
		expect(runSecond).toMatchObject({
			data: { results: [{ sourceName: nativeImport, status: "alreadyImported" }] },
		});

		// 4) 门禁：用户 Pi 目录 0 created / 0 modified / 0 deleted
		expect(await snapshotTree(nativeRoot)).toEqual(before);
		expect(existsSync(sentinelPath)).toBe(false);
		expect(existsSync(projectSentinel)).toBe(false);
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
	it("覆盖 wrapper/附件/旧事件/abort retry 的竞态矩阵", async () => {
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
			shutdown: ReturnType<typeof vi.fn>;
			isAlive: () => boolean;
			onEvent: (listener: EventListener) => () => void;
		}
		const makeWrapper = (): WrapperStub => {
			const stub: WrapperStub = {
				sessionId: "session-1",
				alive: true,
				listeners: [],
				send: vi.fn().mockResolvedValue(null),
				getState: vi.fn(() => ({ status: "running" })),
				shutdown: vi.fn(async () => {
					stub.alive = false;
				}),
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
			SessionManager: {
				list: vi
					.fn()
					.mockResolvedValue([{ id: "session-1", path: "session.jsonl" }]),
			},
		}));
		vi.doMock("./agent-session.js", () => ({ startPiAgentSession }));
		vi.doMock("./session-reader.js", () => ({
			createPiSessionReader: () => ({
				state: vi.fn().mockResolvedValue({ status: "idle" }),
			}),
		}));
		vi.doMock("./images.js", () => ({
			downloadPromptImages,
			toSdkImages: vi.fn(() => []),
		}));
		// 凭据注入走真实模块会构造真实 ModelRuntime：本用例只关心流水线竞态，故打桩。
		vi.doMock("./runtime-spec.js", async () => {
			const actual = await vi.importActual<typeof import("./runtime-spec.js")>(
				"./runtime-spec.js",
			);
			return {
				...actual,
				createModelRuntimeWithLease: vi.fn(async () => ({
					getAvailable: async () => [],
				})),
			};
		});

		const sent: PiWorkerOutboundMessage[] = [];
		const originalArg = process.argv[2];
		const originalSend = process.send;
		const beforeMessageListeners = new Set(process.listeners("message"));
		process.argv[2] = "/tmp/pi-worker-seam";
		// 本用例在测试进程内 import 真实 worker：数据根必须显式指向临时目录，
		// 否则 getRuntime() 会落到仓库内的 fallback（packages/client/data）。
		process.env.VCPDECK_CLIENT_DATA_DIR = dataRootFor("/tmp/pi-worker-seam");
		Object.defineProperty(process, "send", {
			configurable: true,
			value: vi.fn((message: PiWorkerOutboundMessage) => sent.push(message)),
		});
		await import("./worker.js");
		const workerListener = process
			.listeners("message")
			.find((listener) => !beforeMessageListeners.has(listener));
		expect(workerListener).toBeDefined();

		// 先下发运行配置：未就绪时 WORKER_ACTION 会被 fail closed 拒绝。
		// process 的 message 监听器类型带 sendHandle，这里只按消息驱动。
		(workerListener as (message: unknown) => void)?.(
			{
				type: "runtime-init",
				config: {
					spec: {
						schemaVersion: 1,
						specId: "s1",
						profileId: "p1",
						profileRevision: 1,
						modelPolicy: {
							defaultModel: { provider: "anthropic", modelId: "claude-x" },
							allowedModels: [{ provider: "anthropic", modelId: "claude-x" }],
							defaultThinkingLevel: "medium",
						},
						runtimeRevision: "0123456789abcdef",
					},
					credentialEntries: [{ provider: "anthropic", apiKey: "sk-test" }],
					resolvedModels: [{ provider: "anthropic", modelId: "claude-x" }],
					unavailableModels: [],
				},
			} as never,
		);

		let requestSeq = 0;
		const request = async (
			action: string,
			runId: string,
			payload?: Record<string, unknown>,
		): Promise<PiWorkerOutboundMessage> => {
			const requestId = `seam-${++requestSeq}`;
			workerListener?.(
				{
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
				},
				{} as never,
			);
			await vi.waitFor(() => {
				expect(
					sent.some(
						(message) =>
							message.type === "response" && message.requestId === requestId,
					),
				).toBe(true);
			});
			return sent.find(
				(message) =>
					message.type === "response" && message.requestId === requestId,
			)!;
		};
		const fireAndGetId = (
			action: string,
			runId: string,
			payload?: Record<string, unknown>,
		): string => {
			const requestId = `seam-${++requestSeq}`;
			workerListener?.(
				{
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
				},
				{} as never,
			);
			return requestId;
		};

		try {
			// accepted 先于 wrapper；abort 使唯一 pipeline 失效，晚到 wrapper 只 shutdown。
			const firstWrapper = deferred<WrapperStub>();
			wrapperStarts.push(firstWrapper.promise);
			await expect(
				request("agent.prompt", "run-wrapper", { prompt: "never" }),
			).resolves.toMatchObject({ ok: true, data: { accepted: true } });
			await expect(
				request("agent.prompt", "run-busy", { prompt: "never" }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_PROJECT_BUSY" },
			});
			const abortPendingId = fireAndGetId("agent.abort", "run-wrapper");
			const wrapper = makeWrapper();
			firstWrapper.resolve(wrapper);
			await vi.waitFor(() =>
				expect(sent).toContainEqual(
					expect.objectContaining({
						type: "response",
						requestId: abortPendingId,
						ok: true,
					}),
				),
			);
			expect(wrapper.shutdown).toHaveBeenCalledOnce();
			expect(wrapper.send).not.toHaveBeenCalledWith(
				"agent.prompt",
				expect.anything(),
			);
			await expect(
				request("agent.state", "run-wrapper"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_CONTROL_FORBIDDEN" },
			});

			// 附件失败清 matching envelope；后续 run 可进入。
			const attachmentWrapper = makeWrapper();
			wrapperStarts.push(Promise.resolve(attachmentWrapper));
			downloadPromptImages.mockRejectedValueOnce(
				Object.assign(new Error("secret"), { code: "PI_IMAGE_INVALID" }),
			);
			await request("agent.prompt", "run-attachment", {
				prompt: "never",
				attachments: [
					{
						url: "https://invalid",
						mimeType: "image/png",
						size: 1,
						sha256: "0".repeat(64),
					},
				],
			});
			await vi.waitFor(() =>
				expect(sent).toContainEqual(
					expect.objectContaining({
						type: "event",
						runId: "run-attachment",
						event: expect.objectContaining({
							type: "prompt_error",
							code: "PI_IMAGE_INVALID",
						}),
					}),
				),
			);
			await expect(
				request("agent.state", "run-attachment"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_CONTROL_FORBIDDEN" },
			});

			// matching prompt_error 释放 active，但保留该 envelope 的只读 state 权限。
			await request("agent.prompt", "run-old", { prompt: "ok" });
			await vi.waitFor(() =>
				expect(attachmentWrapper.send).toHaveBeenCalledWith(
					"agent.prompt",
					expect.anything(),
				),
			);
			const oldListener = attachmentWrapper.listeners[0]!;
			oldListener({
				type: "prompt_error",
				sessionId: "session-1",
				code: "PI_RUNTIME_UNAVAILABLE",
			});
			await expect(request("agent.state", "run-old")).resolves.toMatchObject({
				ok: true,
				data: { status: "idle" },
			});
			await expect(
				request("agent.state", "run-unknown"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_CONTROL_FORBIDDEN" },
			});

			// agent_settled 同样保留只读 state 权限。
			await request("agent.prompt", "run-settled", { prompt: "ok" });
			const settledListener = attachmentWrapper.listeners[0]!;
			settledListener({ type: "agent_settled", sessionId: "session-1" });
			await expect(
				request("agent.state", "run-settled"),
			).resolves.toMatchObject({ ok: true, data: { status: "idle" } });

			// 新 envelope 不清历史记录，旧 listener 不能清理/重标当前新 run。
			await request("agent.prompt", "run-current", { prompt: "ok" });
			settledListener({ type: "agent_settled", sessionId: "session-1" });
			await expect(
				request("agent.state", "run-current"),
			).resolves.toMatchObject({ ok: true, data: { status: "running" } });
			await expect(request("agent.state", "run-old")).resolves.toMatchObject({
				ok: true,
				data: { status: "idle" },
			});

			// abort 失败保留 run；第二次仍到达同 wrapper 并最终清理。
			attachmentWrapper.send.mockImplementationOnce(async (action: string) => {
				if (action === "agent.abort")
					throw Object.assign(new Error("failed"), {
						code: "PI_REQUEST_TIMEOUT",
					});
				return null;
			});
			await expect(
				request("agent.abort", "run-current"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_REQUEST_TIMEOUT" },
			});
			await expect(
				request("agent.abort", "run-current"),
			).resolves.toMatchObject({ ok: true });
			expect(
				attachmentWrapper.send.mock.calls.filter(
					([action]) => action === "agent.abort",
				),
			).toHaveLength(2);
			await expect(
				request("agent.state", "run-current"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_CONTROL_FORBIDDEN" },
			});

			// settled run 缓存按 FIFO 限制为 32 条。
			for (let index = 0; index < 33; index += 1) {
				await request("agent.prompt", `run-bounded-${index}`, { prompt: "ok" });
				await vi.waitFor(() =>
					expect(attachmentWrapper.listeners).toHaveLength(1),
				);
				attachmentWrapper.listeners[0]!({
					type: "agent_settled",
					sessionId: "session-1",
				});
			}
			await expect(
				request("agent.state", "run-bounded-0"),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "PI_CONTROL_FORBIDDEN" },
			});
			await expect(
				request("agent.state", "run-bounded-32"),
			).resolves.toMatchObject({ ok: true, data: { status: "idle" } });

			// 空闲 idle mutation：model.set/thinking.set 无需 active run，直接到达 wrapper。
			const idleSet = async (
				action: string,
				payload: Record<string, unknown>,
			) => {
				const requestId = `seam-idle-${++requestSeq}`;
				workerListener?.(
					{
						type: "request",
						projectKey: "project",
						request: {
							requestId,
							action,
							jobId: "session-1",
							sessionId: "session-1",
							payload,
						},
					},
					{} as never,
				);
				await vi.waitFor(() =>
					expect(
						sent.some(
							(message) =>
								message.type === "response" && message.requestId === requestId,
						),
					).toBe(true),
				);
				return sent.find(
					(message) =>
						message.type === "response" && message.requestId === requestId,
				)!;
			};
			await expect(
				idleSet("model.set", {
					provider: "AxonHub",
					modelId: "deepseek-v4-flash",
				}),
			).resolves.toMatchObject({ ok: true });
			expect(attachmentWrapper.send).toHaveBeenCalledWith("model.set", {
				provider: "AxonHub",
				modelId: "deepseek-v4-flash",
			});
			await expect(
				idleSet("thinking.set", { level: "high" }),
			).resolves.toMatchObject({ ok: true });
			expect(attachmentWrapper.send).toHaveBeenCalledWith("thinking.set", {
				level: "high",
			});
		} finally {
			if (workerListener) process.removeListener("message", workerListener);
			process.argv[2] = originalArg;
			Object.defineProperty(process, "send", {
				configurable: true,
				value: originalSend,
			});
			vi.doUnmock("@earendil-works/pi-coding-agent");
			vi.doUnmock("./agent-session.js");
			vi.doUnmock("./session-reader.js");
			vi.doUnmock("./images.js");
			vi.doUnmock("./runtime-spec.js");
		}
	});
});
