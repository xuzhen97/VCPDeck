import { afterEach, describe, expect, it } from "vitest";
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
			JSON.stringify({ type: "session", version: 3, id: "test-1", timestamp, cwd }) + "\n",
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
				const sessions = (msg.data as { sessions: Array<{ id: string }> }).sessions;
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
					const sessions = (listed.data as { sessions: Array<{ id: string }> }).sessions;
					expect(sessions.some((session) => session.id === sessionId)).toBe(true);
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
