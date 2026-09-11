"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_js_1 = require("./index.js");
const pi_js_1 = require("./pi.js");
(0, vitest_1.describe)("Pi thinking levels", () => {
    (0, vitest_1.it)("只接受 Pi SDK 原生思考深度", () => {
        (0, vitest_1.expect)((0, pi_js_1.isPiThinkingLevel)("high")).toBe(true);
        (0, vitest_1.expect)((0, pi_js_1.isPiThinkingLevel)("auto")).toBe(false);
        (0, vitest_1.expect)((0, pi_js_1.isPiThinkingLevel)("unknown")).toBe(false);
    });
});
(0, vitest_1.describe)("isPiAgentIdle", () => {
    const base = {
        status: "idle",
        streaming: false,
        prompting: false,
        compacting: false,
        thinkingLevel: "off",
        queuedMessages: { steering: [], followUp: [] },
    };
    (0, vitest_1.it)("四标志空闲且无扩展/排队才返回 true", () => {
        (0, vitest_1.expect)((0, pi_js_1.isPiAgentIdle)(base)).toBe(true);
    });
    vitest_1.it.each([
        ["status running", { status: "running" }],
        ["streaming", { streaming: true }],
        ["prompting", { prompting: true }],
        ["compacting", { compacting: true }],
        ["waitingForExtensionInput", { waitingForExtensionInput: true }],
    ])("%s 不算空闲", (_name, patch) => {
        (0, vitest_1.expect)((0, pi_js_1.isPiAgentIdle)({ ...base, ...patch })).toBe(false);
    });
    (0, vitest_1.it)("pendingExtension 或排队 steering/followUp 不算空闲", () => {
        (0, vitest_1.expect)((0, pi_js_1.isPiAgentIdle)({
            ...base,
            pendingExtension: {
                requestId: "u1",
                extensionId: "e",
                kind: "confirm",
            },
        })).toBe(false);
        (0, vitest_1.expect)((0, pi_js_1.isPiAgentIdle)({
            ...base,
            queuedMessages: { steering: ["s"], followUp: [] },
        })).toBe(false);
        (0, vitest_1.expect)((0, pi_js_1.isPiAgentIdle)({
            ...base,
            queuedMessages: { steering: [], followUp: ["f"] },
        })).toBe(false);
    });
});
(0, vitest_1.describe)("Session Job 协议", () => {
    (0, vitest_1.it)("导出协议版本和 Job 枚举", () => {
        (0, vitest_1.expect)(index_js_1.JobType.AGENT_SESSION).toBe("agent.session");
        (0, vitest_1.expect)(index_js_1.JobStatus.IDLE).toBe("idle");
        (0, vitest_1.expect)(pi_js_1.PI_SESSION_JOB_PROTOCOL_VERSION).toBe(1);
        (0, vitest_1.expect)(pi_js_1.PI_ERROR_CODES).toContain("PI_STATE_PENDING");
    });
});
(0, vitest_1.describe)("parsePiRequest", () => {
    (0, vitest_1.it)("允许 Session Job 使用独立 Prompt runId", () => {
        const request = (0, pi_js_1.parsePiRequest)({
            requestId: "request-1",
            action: "agent.prompt",
            cwdRef: { rootDir: "D:\\", relativePath: "repo" },
            sessionId: "session-1",
            jobId: "session-1",
            runId: "run-1",
            payload: { prompt: "hello" },
        });
        (0, vitest_1.expect)(request.jobId).toBe("session-1");
        (0, vitest_1.expect)(request.runId).toBe("run-1");
    });
    (0, vitest_1.it)("拒绝 jobId 与 sessionId 不一致", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "request-1",
            action: "agent.prompt",
            cwdRef: { rootDir: "D:\\", relativePath: "repo" },
            sessionId: "session-1",
            jobId: "other-job",
            runId: "run-1",
            payload: { prompt: "hello" },
        })).toThrow(/jobId.*sessionId/);
    });
    (0, vitest_1.it)("拒绝未知 action", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({ requestId: "r1", action: "agent.unknown" })).toThrow();
    });
    (0, vitest_1.it)("拒绝未知顶层字段", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "agent.state",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            evil: true,
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝缺失 requestId", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({ action: "agent.state" })).toThrow();
    });
    (0, vitest_1.it)("拒绝 prompt 缺 session/job/run 关联 ID", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({ requestId: "r1", action: "agent.prompt" })).toThrow();
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "agent.prompt",
            sessionId: "s1",
        })).toThrow();
    });
    vitest_1.it.each([
        "agent.prompt",
        "agent.steer",
        "agent.followUp",
        "agent.abort",
        "agent.compact",
        "agent.abortCompact",
        "extension.respond",
    ])("拒绝 run-scoped action %s 缺完整关联 ID", (action) => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action,
            sessionId: "s1",
            jobId: "s1",
        })).toThrow(/runId/);
    });
    (0, vitest_1.it)("拒绝图片数量超限的 prompt", () => {
        const attachments = Array.from({ length: pi_js_1.MAX_PI_IMAGES_PER_PROMPT + 1 }, () => ({
            fileId: "f",
            sha256: "a".repeat(64),
            size: 1024,
            mimeType: "image/png",
        }));
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "agent.prompt",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            payload: { prompt: "hi", attachments },
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝单图超限的 prompt", () => {
        const attachments = [
            {
                fileId: "f",
                sha256: "a".repeat(64),
                size: 11 * 1024 * 1024,
                mimeType: "image/png",
            },
        ];
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "agent.prompt",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            payload: { prompt: "hi", attachments },
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝总量超限的 prompt", () => {
        const attachments = Array.from({ length: pi_js_1.MAX_PI_IMAGES_PER_PROMPT }, () => ({
            fileId: "f",
            sha256: "a".repeat(64),
            size: 11 * 1024 * 1024,
            mimeType: "image/png",
        }));
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "agent.prompt",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            payload: { prompt: "hi", attachments },
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝畸形 cwdRef", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiRequest)({
            requestId: "r1",
            action: "sessions.list",
            cwdRef: { rootDir: 42, relativePath: "repo" },
        })).toThrow();
    });
});
(0, vitest_1.describe)("parsePiAgentState", () => {
    const state = {
        status: "waiting_for_extension_input",
        streaming: false,
        prompting: true,
        compacting: false,
        thinkingLevel: "off",
        queuedMessages: { steering: [], followUp: [] },
    };
    (0, vitest_1.it)("严格解析 pendingExtension", () => {
        (0, vitest_1.expect)((0, pi_js_1.parsePiAgentState)({
            ...state,
            pendingExtension: {
                requestId: "ui-1",
                extensionId: "project-trust",
                kind: "confirm",
                title: "Project Trust",
                message: "是否信任？",
            },
        }).pendingExtension?.requestId).toBe("ui-1");
    });
    (0, vitest_1.it)("拒绝畸形 Agent State 和非交互 pending kind", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiAgentState)({ ...state, streaming: "yes" })).toThrow(/streaming/);
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiAgentState)({
            ...state,
            pendingExtension: {
                requestId: "ui-1",
                extensionId: "e",
                kind: "notify",
            },
        })).toThrow(/pendingExtension.kind/);
    });
});
(0, vitest_1.describe)("parsePiResponse", () => {
    (0, vitest_1.it)("接受 ok 响应", () => {
        const res = (0, pi_js_1.parsePiResponse)({ requestId: "r1", ok: true, data: { ok: 1 } });
        (0, vitest_1.expect)(res.ok).toBe(true);
    });
    (0, vitest_1.it)("拒绝未知字段", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiResponse)({ requestId: "r1", ok: true, evil: 1 })).toThrow();
    });
    (0, vitest_1.it)("拒绝错误响应缺字段、未知 code 和超长 message", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiResponse)({ requestId: "r1", ok: false })).toThrow();
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiResponse)({ requestId: "r1", ok: false, error: { code: "X" } })).toThrow();
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiResponse)({
            requestId: "r1",
            ok: false,
            error: { code: "UNKNOWN", message: "bad" },
        })).toThrow(/error.code/);
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiResponse)({
            requestId: "r1",
            ok: false,
            error: { code: "PI_PROTOCOL_INVALID", message: "x".repeat(4097) },
        })).toThrow(/error.message/);
    });
});
(0, vitest_1.describe)("parsePiEvent", () => {
    (0, vitest_1.it)("接受合法事件包装", () => {
        const ev = (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "s1",
            runId: "run-1",
            event: { type: "agent_end", sessionId: "s1" },
        });
        (0, vitest_1.expect)(ev.event.type).toBe("agent_end");
    });
    (0, vitest_1.it)("接受并严格校验 extension_resolved", () => {
        const event = (0, pi_js_1.parsePiEvent)({
            clientId: "client-1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: "run-1",
            event: {
                type: "extension_resolved",
                sessionId: "session-1",
                requestId: "ui-1",
                reason: "timeout",
                hasPending: false,
            },
        });
        (0, vitest_1.expect)(event.event.type).toBe("extension_resolved");
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "client-1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: "run-1",
            event: {
                type: "extension_resolved",
                sessionId: "session-1",
                requestId: "ui-1",
                reason: "unknown",
                hasPending: false,
            },
        })).toThrow(/reason/);
    });
    (0, vitest_1.it)("拒绝外层与内层 sessionId 不一致", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "client-1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: "run-1",
            event: { type: "agent_end", sessionId: "other-session" },
        })).toThrow(/sessionId/);
    });
    (0, vitest_1.it)("拒绝非交互式 extension_request", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "s1",
            runId: "r1",
            event: {
                type: "extension_request",
                sessionId: "s1",
                ui: { requestId: "ui", extensionId: "e", kind: "notify" },
            },
        })).toThrow(/ui.kind/);
    });
    (0, vitest_1.it)("拒绝畸形事件专属字段和 Extension UI", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "s1",
            runId: "r1",
            event: { type: "prompt_error", sessionId: "s1", code: "UNKNOWN", message: "bad" },
        })).toThrow(/code/);
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "s1",
            runId: "r1",
            event: {
                type: "extension_request",
                sessionId: "s1",
                ui: { requestId: "ui", extensionId: "e", kind: "bad" },
            },
        })).toThrow(/ui.kind/);
    });
    (0, vitest_1.it)("限制 thinking_progress 单次正文大小", () => {
        const ev = (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "s1",
            runId: "run-1",
            event: {
                type: "thinking_progress",
                sessionId: "s1",
                stage: "delta",
                text: "x".repeat(16_385),
            },
        });
        (0, vitest_1.expect)(ev.event.text?.length).toBeLessThanOrEqual(16_384);
    });
    (0, vitest_1.it)("拒绝未知 event 类型", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({
            clientId: "c1",
            sessionId: "s1",
            jobId: "j1",
            runId: "j1",
            event: { type: "totally_unknown" },
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝缺失关联 ID", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiEvent)({ clientId: "c1", event: { type: "agent_end" } })).toThrow();
    });
});
(0, vitest_1.describe)("parsePiStateReport", () => {
    (0, vitest_1.it)("接受空报告", () => {
        const report = (0, pi_js_1.parsePiStateReport)({ clientId: "c1", runs: [] });
        (0, vitest_1.expect)(report.runs).toEqual([]);
    });
    (0, vitest_1.it)("接受活动状态、独立 runId 和无 projectKey 的 idle/error", () => {
        const report = (0, pi_js_1.parsePiStateReport)({
            clientId: "c1",
            runs: [
                {
                    jobId: "s1",
                    runId: "run-1",
                    sessionId: "s1",
                    status: "running",
                    projectKey: "a".repeat(64),
                },
                { jobId: "s2", runId: "run-2", sessionId: "s2", status: "idle" },
                { jobId: "s3", runId: "run-3", sessionId: "s3", status: "error" },
            ],
        });
        (0, vitest_1.expect)(report.runs.map((run) => run.status)).toEqual([
            "running",
            "idle",
            "error",
        ]);
    });
    (0, vitest_1.it)("要求活动状态携带 projectKey", () => {
        for (const status of ["running", "waiting_input"]) {
            (0, vitest_1.expect)(() => (0, pi_js_1.parsePiStateReport)({
                clientId: "c1",
                runs: [{ jobId: "s1", runId: "r1", sessionId: "s1", status }],
            })).toThrow(/projectKey/);
        }
    });
    (0, vitest_1.it)("拒绝未知 run 状态", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiStateReport)({
            clientId: "c1",
            runs: [
                { jobId: "j1", runId: "j1", sessionId: "s1", status: "mystery" },
            ],
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝非法 projectKey 长度", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiStateReport)({
            clientId: "c1",
            runs: [
                {
                    jobId: "j1",
                    runId: "j1",
                    sessionId: "s1",
                    status: "running",
                    projectKey: "short",
                },
            ],
        })).toThrow();
    });
    (0, vitest_1.it)("拒绝 jobId 与 sessionId 不一致", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiStateReport)({
            clientId: "c1",
            runs: [{ jobId: "j1", runId: "r1", sessionId: "s1", status: "done" }],
        })).toThrow(/jobId.*sessionId/);
    });
    (0, vitest_1.it)("拒绝 runs 超过 1,000 项", () => {
        (0, vitest_1.expect)(() => (0, pi_js_1.parsePiStateReport)({
            clientId: "c1",
            runs: Array.from({ length: 1001 }, (_, index) => ({
                jobId: `s${index}`,
                runId: `r${index}`,
                sessionId: `s${index}`,
                status: "idle",
            })),
        })).toThrow(/runs/);
    });
});
