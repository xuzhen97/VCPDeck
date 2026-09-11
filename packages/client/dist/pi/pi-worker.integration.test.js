"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/**
 * 真实 Worker 子进程集成：临时 PI_CODING_AGENT_DIR + 真实 Session JSONL。
 * 依赖已构建的 dist/pi/worker.js；构建缺失时跳过。
 */
const workerPath = (0, node_path_1.join)(__dirname, "../../dist/pi/worker.js");
const hasWorker = (0, node_fs_1.existsSync)(workerPath);
let roots = [];
let seq = 0;
(0, vitest_1.afterEach)(async () => {
    for (const c of children)
        c.kill();
    children = [];
    await Promise.all(roots.map((r) => (0, promises_1.rm)(r, { recursive: true, force: true })));
    roots = [];
    delete process.env.PI_CODING_AGENT_DIR;
});
let children = [];
function spawnWorker(cwd, env) {
    const child = (0, node_child_process_1.fork)(workerPath, [cwd], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ...env },
    });
    children.push(child);
    return child;
}
function requestOnce(child, request) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker timeout")), 10_000);
        const onMessage = (msg) => {
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
function waitForEvent(child, predicate) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker event timeout")), 10_000);
        const onMessage = (message) => {
            if (!predicate(message))
                return;
            clearTimeout(timer);
            child.removeListener("message", onMessage);
            resolve(message);
        };
        child.on("message", onMessage);
    });
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
vitest_1.describe.skipIf(!hasWorker)("Pi Worker 子进程集成", () => {
    (0, vitest_1.it)("真实 Worker 列出临时 agent 目录下的 Session", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)(cwd, { recursive: true });
        roots.push(agentDir);
        // 用真实 SDK 在临时 agent 目录创建 Session（create 延迟写盘，需手动 flush header）
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        const sm = SessionManager.create(cwd);
        const sessionDir = sm.getSessionDir();
        const timestamp = new Date().toISOString();
        await (0, promises_1.writeFile)((0, node_path_1.join)(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_test-session.jsonl`), JSON.stringify({
            type: "session",
            version: 3,
            id: "test-1",
            timestamp,
            cwd,
        }) + "\n", "utf8");
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const msg = await requestOnce(child, {
            requestId: "r-list",
            action: "sessions.list",
            cwdRef: { rootDir: agentDir, relativePath: "project" },
        });
        (0, vitest_1.expect)(msg.type).toBe("response");
        if (msg.type === "response") {
            (0, vitest_1.expect)(msg.ok).toBe(true);
            if (msg.ok) {
                const sessions = msg.data
                    .sessions;
                (0, vitest_1.expect)(sessions.length).toBeGreaterThanOrEqual(1);
            }
        }
    });
    (0, vitest_1.it)("新建 Session 返回可继续打开的真实 sessionId", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)(cwd, { recursive: true });
        roots.push(agentDir);
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const msg = await requestOnce(child, {
            requestId: "r-new",
            action: "session.new",
            cwdRef: { rootDir: agentDir, relativePath: "project" },
        });
        (0, vitest_1.expect)(msg.type).toBe("response");
        if (msg.type === "response") {
            (0, vitest_1.expect)(msg.ok).toBe(true);
            if (msg.ok) {
                const sessionId = msg.data.sessionId;
                (0, vitest_1.expect)(sessionId).toMatch(/^[0-9a-f-]{36}$/);
                const listed = await requestOnce(child, {
                    requestId: "r-new-list",
                    action: "sessions.list",
                    cwdRef: { rootDir: agentDir, relativePath: "project" },
                });
                (0, vitest_1.expect)(listed.type).toBe("response");
                if (listed.type === "response" && listed.ok) {
                    const sessions = listed.data
                        .sessions;
                    (0, vitest_1.expect)(sessions.some((session) => session.id === sessionId)).toBe(true);
                }
                const detail = await requestOnce(child, {
                    requestId: "r-new-get",
                    action: "session.get",
                    sessionId,
                    cwdRef: { rootDir: agentDir, relativePath: "project" },
                });
                (0, vitest_1.expect)(detail.type).toBe("response");
                if (detail.type === "response")
                    (0, vitest_1.expect)(detail.ok).toBe(true);
            }
        }
    });
    (0, vitest_1.it)("已有 Session 重建时保留 JSONL 中的模型与思考深度", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)(cwd, { recursive: true });
        roots.push(agentDir);
        await (0, promises_1.writeFile)((0, node_path_1.join)(agentDir, "models.json"), JSON.stringify({
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
        }), "utf8");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        const sm = SessionManager.create(cwd);
        const sessionDir = sm.getSessionDir();
        const sessionFile = (0, node_path_1.join)(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_restore.jsonl`);
        await (0, promises_1.writeFile)(sessionFile, [
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
        ].join("\n") + "\n", "utf8");
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const msg = await requestOnce(child, {
            requestId: "r-state-restore",
            action: "agent.state",
            sessionId: "restore-session",
            cwdRef: { rootDir: agentDir, relativePath: "project" },
        });
        (0, vitest_1.expect)(msg).toMatchObject({
            type: "response",
            ok: true,
            data: {
                model: { provider: "AxonHub", modelId: "deepseek-v4-flash" },
                thinkingLevel: "max",
            },
        });
    });
    (0, vitest_1.it)("只有模型与思考记录的 Session 也保留持久化偏好", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)(cwd, { recursive: true });
        roots.push(agentDir);
        await (0, promises_1.writeFile)((0, node_path_1.join)(agentDir, "models.json"), JSON.stringify({
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
        }), "utf8");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        const sm = SessionManager.create(cwd);
        const sessionFile = (0, node_path_1.join)(sm.getSessionDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}_prefs-only.jsonl`);
        await (0, promises_1.writeFile)(sessionFile, [
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
        ].join("\n") + "\n", "utf8");
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const msg = await requestOnce(child, {
            requestId: "r-prefs-only",
            action: "agent.state",
            sessionId: "prefs-only",
            cwdRef: { rootDir: agentDir, relativePath: "project" },
        });
        (0, vitest_1.expect)(msg).toMatchObject({
            type: "response",
            ok: true,
            data: {
                model: { provider: "AxonHub", modelId: "deepseek-v4-flash" },
                thinkingLevel: "max",
            },
        });
    });
    (0, vitest_1.it)("trust pending 可 abort，控制请求必须匹配完整 envelope", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)((0, node_path_1.join)(cwd, ".pi", "extensions"), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(cwd, ".pi", "extensions", "test.ts"), "export default {};\n", "utf8");
        roots.push(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        const sm = SessionManager.create(cwd);
        const sessionId = sm.getSessionId();
        await (0, promises_1.writeFile)(sm.getSessionFile(), JSON.stringify({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: new Date().toISOString(),
            cwd,
        }) + "\n", "utf8");
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const trustRequest = waitForEvent(child, (message) => message.type === "event" &&
            message.runId === "run-1" &&
            message.event.type === "extension_request");
        await (0, vitest_1.expect)(requestOnce(child, {
            requestId: "prompt-1",
            action: "agent.prompt",
            jobId: sessionId,
            sessionId,
            runId: "run-1",
            payload: { prompt: "do not run" },
        })).resolves.toMatchObject({
            type: "response",
            ok: true,
            data: { accepted: true },
        });
        await trustRequest;
        await (0, vitest_1.expect)(requestOnce(child, {
            requestId: "state-wrong",
            action: "agent.state",
            jobId: sessionId,
            sessionId,
            runId: "run-wrong",
        })).resolves.toMatchObject({
            type: "response",
            ok: false,
            error: { code: "PI_CONTROL_FORBIDDEN" },
        });
        await (0, vitest_1.expect)(requestOnce(child, {
            requestId: "state-right",
            action: "agent.state",
            jobId: sessionId,
            sessionId,
            runId: "run-1",
        })).resolves.toMatchObject({
            type: "response",
            ok: true,
            data: { status: "waiting_for_extension_input" },
        });
        await (0, vitest_1.expect)(requestOnce(child, {
            requestId: "abort-1",
            action: "agent.abort",
            jobId: sessionId,
            sessionId,
            runId: "run-1",
        })).resolves.toMatchObject({ type: "response", ok: true });
        await (0, vitest_1.expect)(requestOnce(child, {
            requestId: "state-after",
            action: "agent.state",
            jobId: sessionId,
            sessionId,
            runId: "run-1",
        })).resolves.toMatchObject({
            type: "response",
            ok: false,
            error: { code: "PI_CONTROL_FORBIDDEN" },
        });
    });
    (0, vitest_1.it)("parent disconnect 后 Worker 退出", async () => {
        const agentDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), `pi-agent-${++seq}-`));
        const cwd = (0, node_path_1.join)(agentDir, "project");
        await (0, promises_1.mkdir)(cwd, { recursive: true });
        roots.push(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const child = spawnWorker(cwd, { PI_CODING_AGENT_DIR: agentDir });
        const exited = new Promise((resolve) => {
            child.on("exit", (code) => resolve(code));
        });
        // 模拟 parent 进程消失：断开 IPC 通道
        child.disconnect();
        const code = await Promise.race([
            exited,
            new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
        ]);
        (0, vitest_1.expect)(code).not.toBeNull();
    });
});
(0, vitest_1.describe)("Pi Worker prompt pipeline seam", () => {
    (0, vitest_1.it)("覆盖 wrapper/trust/附件/旧事件/abort retry 的竞态矩阵", async () => {
        const makeWrapper = (trust = false) => {
            const stub = {
                sessionId: "session-1",
                alive: true,
                listeners: [],
                send: vitest_1.vi.fn().mockResolvedValue(null),
                getState: vitest_1.vi.fn(() => ({ status: "running" })),
                ensureProjectTrust: vitest_1.vi.fn(() => Promise.resolve(trust)),
                shutdown: vitest_1.vi.fn(async () => {
                    stub.alive = false;
                }),
                isAlive: () => stub.alive,
                onEvent: (listener) => {
                    stub.listeners.push(listener);
                    return () => {
                        const index = stub.listeners.indexOf(listener);
                        if (index !== -1)
                            stub.listeners.splice(index, 1);
                    };
                },
            };
            return stub;
        };
        const wrapperStarts = [];
        const startPiAgentSession = vitest_1.vi.fn(() => {
            const next = wrapperStarts.shift();
            if (!next)
                throw new Error("unexpected wrapper start");
            return next;
        });
        const downloadPromptImages = vitest_1.vi.fn().mockResolvedValue([]);
        vitest_1.vi.doMock("@earendil-works/pi-coding-agent", () => ({
            SessionManager: {
                list: vitest_1.vi
                    .fn()
                    .mockResolvedValue([{ id: "session-1", path: "session.jsonl" }]),
            },
        }));
        vitest_1.vi.doMock("./agent-session.js", () => ({ startPiAgentSession }));
        vitest_1.vi.doMock("./session-reader.js", () => ({
            createPiSessionReader: () => ({
                state: vitest_1.vi.fn().mockResolvedValue({ status: "idle" }),
            }),
        }));
        vitest_1.vi.doMock("./images.js", () => ({
            downloadPromptImages,
            toSdkImages: vitest_1.vi.fn(() => []),
        }));
        const sent = [];
        const originalArg = process.argv[2];
        const originalSend = process.send;
        const beforeMessageListeners = new Set(process.listeners("message"));
        process.argv[2] = "/tmp/pi-worker-seam";
        Object.defineProperty(process, "send", {
            configurable: true,
            value: vitest_1.vi.fn((message) => sent.push(message)),
        });
        await import("./worker.js");
        const workerListener = process
            .listeners("message")
            .find((listener) => !beforeMessageListeners.has(listener));
        (0, vitest_1.expect)(workerListener).toBeDefined();
        let requestSeq = 0;
        const request = async (action, runId, payload) => {
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
            }, {});
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(sent.some((message) => message.type === "response" && message.requestId === requestId)).toBe(true);
            });
            return sent.find((message) => message.type === "response" && message.requestId === requestId);
        };
        const fireAndGetId = (action, runId, payload) => {
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
            }, {});
            return requestId;
        };
        try {
            // accepted 先于 wrapper；abort 使唯一 pipeline 失效，晚到 wrapper 只 shutdown。
            const firstWrapper = deferred();
            wrapperStarts.push(firstWrapper.promise);
            await (0, vitest_1.expect)(request("agent.prompt", "run-wrapper", { prompt: "never" })).resolves.toMatchObject({ ok: true, data: { accepted: true } });
            await (0, vitest_1.expect)(request("agent.prompt", "run-busy", { prompt: "never" })).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_PROJECT_BUSY" },
            });
            const abortPendingId = fireAndGetId("agent.abort", "run-wrapper");
            const wrapper = makeWrapper();
            firstWrapper.resolve(wrapper);
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(sent).toContainEqual(vitest_1.expect.objectContaining({
                type: "response",
                requestId: abortPendingId,
                ok: true,
            })));
            (0, vitest_1.expect)(wrapper.shutdown).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(wrapper.send).not.toHaveBeenCalledWith("agent.prompt", vitest_1.expect.anything());
            await (0, vitest_1.expect)(request("agent.state", "run-wrapper")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_CONTROL_FORBIDDEN" },
            });
            // trust=true 后重建 pending 时 abort：新 wrapper 晚到后 shutdown，不 prompt。
            const trust = deferred();
            const restricted = makeWrapper(trust.promise);
            const rebuilt = deferred();
            wrapperStarts.push(Promise.resolve(restricted), rebuilt.promise);
            await request("agent.prompt", "run-rebuild", { prompt: "never" });
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(restricted.ensureProjectTrust).toHaveBeenCalledOnce());
            trust.resolve(true);
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(startPiAgentSession).toHaveBeenCalledTimes(3));
            const abortRebuildId = fireAndGetId("agent.abort", "run-rebuild");
            const rebuiltWrapper = makeWrapper();
            rebuilt.resolve(rebuiltWrapper);
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(sent).toContainEqual(vitest_1.expect.objectContaining({
                type: "response",
                requestId: abortRebuildId,
                ok: true,
            })));
            (0, vitest_1.expect)(rebuiltWrapper.shutdown).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(rebuiltWrapper.send).not.toHaveBeenCalledWith("agent.prompt", vitest_1.expect.anything());
            // 附件失败清 matching envelope；后续 run 可进入。
            const attachmentWrapper = makeWrapper();
            wrapperStarts.push(Promise.resolve(attachmentWrapper));
            downloadPromptImages.mockRejectedValueOnce(Object.assign(new Error("secret"), { code: "PI_IMAGE_INVALID" }));
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
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(sent).toContainEqual(vitest_1.expect.objectContaining({
                type: "event",
                runId: "run-attachment",
                event: vitest_1.expect.objectContaining({
                    type: "prompt_error",
                    code: "PI_IMAGE_INVALID",
                }),
            })));
            await (0, vitest_1.expect)(request("agent.state", "run-attachment")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_CONTROL_FORBIDDEN" },
            });
            // matching prompt_error 释放 active，但保留该 envelope 的只读 state 权限。
            await request("agent.prompt", "run-old", { prompt: "ok" });
            await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(attachmentWrapper.send).toHaveBeenCalledWith("agent.prompt", vitest_1.expect.anything()));
            const oldListener = attachmentWrapper.listeners[0];
            oldListener({
                type: "prompt_error",
                sessionId: "session-1",
                code: "PI_RUNTIME_UNAVAILABLE",
            });
            await (0, vitest_1.expect)(request("agent.state", "run-old")).resolves.toMatchObject({
                ok: true,
                data: { status: "idle" },
            });
            await (0, vitest_1.expect)(request("agent.state", "run-unknown")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_CONTROL_FORBIDDEN" },
            });
            // agent_settled 同样保留只读 state 权限。
            await request("agent.prompt", "run-settled", { prompt: "ok" });
            const settledListener = attachmentWrapper.listeners[0];
            settledListener({ type: "agent_settled", sessionId: "session-1" });
            await (0, vitest_1.expect)(request("agent.state", "run-settled")).resolves.toMatchObject({ ok: true, data: { status: "idle" } });
            // 新 envelope 不清历史记录，旧 listener 不能清理/重标当前新 run。
            await request("agent.prompt", "run-current", { prompt: "ok" });
            settledListener({ type: "agent_settled", sessionId: "session-1" });
            await (0, vitest_1.expect)(request("agent.state", "run-current")).resolves.toMatchObject({ ok: true, data: { status: "running" } });
            await (0, vitest_1.expect)(request("agent.state", "run-old")).resolves.toMatchObject({
                ok: true,
                data: { status: "idle" },
            });
            // abort 失败保留 run；第二次仍到达同 wrapper 并最终清理。
            attachmentWrapper.send.mockImplementationOnce(async (action) => {
                if (action === "agent.abort")
                    throw Object.assign(new Error("failed"), {
                        code: "PI_REQUEST_TIMEOUT",
                    });
                return null;
            });
            await (0, vitest_1.expect)(request("agent.abort", "run-current")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_REQUEST_TIMEOUT" },
            });
            await (0, vitest_1.expect)(request("agent.abort", "run-current")).resolves.toMatchObject({ ok: true });
            (0, vitest_1.expect)(attachmentWrapper.send.mock.calls.filter(([action]) => action === "agent.abort")).toHaveLength(2);
            await (0, vitest_1.expect)(request("agent.state", "run-current")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_CONTROL_FORBIDDEN" },
            });
            // settled run 缓存按 FIFO 限制为 32 条。
            for (let index = 0; index < 33; index += 1) {
                await request("agent.prompt", `run-bounded-${index}`, { prompt: "ok" });
                await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(attachmentWrapper.listeners).toHaveLength(1));
                attachmentWrapper.listeners[0]({
                    type: "agent_settled",
                    sessionId: "session-1",
                });
            }
            await (0, vitest_1.expect)(request("agent.state", "run-bounded-0")).resolves.toMatchObject({
                ok: false,
                error: { code: "PI_CONTROL_FORBIDDEN" },
            });
            await (0, vitest_1.expect)(request("agent.state", "run-bounded-32")).resolves.toMatchObject({ ok: true, data: { status: "idle" } });
            // 空闲 idle mutation：model.set/thinking.set 无需 active run，直接到达 wrapper。
            const idleSet = async (action, payload) => {
                const requestId = `seam-idle-${++requestSeq}`;
                workerListener?.({
                    type: "request",
                    projectKey: "project",
                    request: {
                        requestId,
                        action,
                        jobId: "session-1",
                        sessionId: "session-1",
                        payload,
                    },
                }, {});
                await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(sent.some((message) => message.type === "response" && message.requestId === requestId)).toBe(true));
                return sent.find((message) => message.type === "response" && message.requestId === requestId);
            };
            await (0, vitest_1.expect)(idleSet("model.set", {
                provider: "AxonHub",
                modelId: "deepseek-v4-flash",
            })).resolves.toMatchObject({ ok: true });
            (0, vitest_1.expect)(attachmentWrapper.send).toHaveBeenCalledWith("model.set", {
                provider: "AxonHub",
                modelId: "deepseek-v4-flash",
            });
            await (0, vitest_1.expect)(idleSet("thinking.set", { level: "high" })).resolves.toMatchObject({ ok: true });
            (0, vitest_1.expect)(attachmentWrapper.send).toHaveBeenCalledWith("thinking.set", {
                level: "high",
            });
        }
        finally {
            if (workerListener)
                process.removeListener("message", workerListener);
            process.argv[2] = originalArg;
            Object.defineProperty(process, "send", {
                configurable: true,
                value: originalSend,
            });
            vitest_1.vi.doUnmock("@earendil-works/pi-coding-agent");
            vitest_1.vi.doUnmock("./agent-session.js");
            vitest_1.vi.doUnmock("./session-reader.js");
            vitest_1.vi.doUnmock("./images.js");
        }
    });
});
