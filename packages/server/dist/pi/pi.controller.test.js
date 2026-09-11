"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const common_1 = require("@nestjs/common");
const pi_controller_js_1 = require("./pi.controller.js");
const cwdRef = { rootDir: "D:\\", relativePath: "repo" };
const idleAgentState = {
    status: "idle",
    streaming: false,
    prompting: false,
    compacting: false,
    thinkingLevel: "medium",
    queuedMessages: { steering: [], followUp: [] },
};
const waitingAgentState = {
    ...idleAgentState,
    status: "waiting_for_extension_input",
    waitingForExtensionInput: true,
};
const idleSnapshot = {
    jobId: "s1",
    sessionId: "s1",
    status: "idle",
    runId: null,
    ownerName: "User",
    isOwner: true,
};
const actor = {
    identityId: "user-1",
    displayName: "User",
    isAdmin: false,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "req-1",
};
function makeController(overrides = {}) {
    const requests = {
        request: vitest_1.vi.fn(async (_lease, _req) => ({
            ok: true,
            data: {},
        })),
        bindEmitter: vitest_1.vi.fn(),
        ...(overrides.requests ?? {}),
    };
    const events = {
        publish: vitest_1.vi.fn(async () => { }),
        stream: vitest_1.vi.fn(() => ({ subscribe: () => () => { } })),
        ...(overrides.events ?? {}),
    };
    const runs = {
        ensureSession: vitest_1.vi.fn(async () => { }),
        snapshot: vitest_1.vi.fn(async () => idleSnapshot),
        startRun: vitest_1.vi.fn(async () => ({ jobId: "s1", runId: "run-1" })),
        accept: vitest_1.vi.fn(async () => true),
        finishRun: vitest_1.vi.fn(async () => true),
        completeSession: vitest_1.vi.fn(async () => true),
        reconcileOpen: vitest_1.vi.fn(async () => true),
        markRunDisconnected: vitest_1.vi.fn(async () => true),
        beginDelete: vitest_1.vi.fn(async () => ({
            deleteToken: "delete-1",
            previousStatus: "idle",
            existingReservation: false,
        })),
        rollbackDelete: vitest_1.vi.fn(async () => true),
        commitDelete: vitest_1.vi.fn(async () => true),
        resume: vitest_1.vi.fn(async () => true),
        assertSessionOwner: vitest_1.vi.fn(async () => { }),
        assertCurrentRunOwner: vitest_1.vi.fn(async () => { }),
        assertIdleMutation: vitest_1.vi.fn(async () => { }),
        listActiveByClient: vitest_1.vi.fn(async () => []),
        withReconciledClient: vitest_1.vi.fn(async (clientId, operation) => operation({ clientId, socketId: "socket-1" })),
        ...(overrides.runs ?? {}),
    };
    const clients = {
        listOnline: vitest_1.vi.fn(async () => [
            {
                clientId: "c1",
                capabilities: ["agent.pi"],
                capabilityDetails: {
                    pi: { available: true, sessionJobProtocolVersion: 1 },
                },
            },
        ]),
        ...(overrides.clients ?? {}),
    };
    const attachments = {
        createPromptUploads: vitest_1.vi.fn(async () => []),
        completePromptUpload: vitest_1.vi.fn(),
        deleteAttachment: vitest_1.vi.fn(async () => { }),
        prepareHistoryUpload: vitest_1.vi.fn(),
        completeHistoryUpload: vitest_1.vi.fn(),
    };
    const controller = new pi_controller_js_1.PiController(requests, events, runs, clients, attachments);
    return { controller, requests, events, runs, clients, attachments };
}
(0, vitest_1.describe)("PiController", () => {
    (0, vitest_1.it)("capability 返回 Client 的 Pi 状态", async () => {
        const { controller } = makeController();
        const result = await controller.capability("c1");
        (0, vitest_1.expect)(result).toMatchObject({ available: true });
    });
    (0, vitest_1.it)("旧 Client 返回 PI_CLIENT_UNSUPPORTED", async () => {
        const { controller, clients } = makeController();
        clients.listOnline.mockResolvedValue([
            { clientId: "c1", capabilities: ["exec"], capabilityDetails: {} },
        ]);
        const result = await controller.capability("c1");
        (0, vitest_1.expect)(result).toMatchObject({ code: "PI_CLIENT_UNSUPPORTED" });
    });
    (0, vitest_1.it)("newSession 创建同 ID Session Job", async () => {
        const { controller, requests, runs } = makeController();
        requests.request.mockResolvedValueOnce({
            ok: true,
            data: { sessionId: "s1" },
        });
        await (0, vitest_1.expect)(controller.newSession("c1", cwdRef, actor)).resolves.toEqual({
            sessionId: "s1",
            jobId: "s1",
        });
        (0, vitest_1.expect)(runs.ensureSession).toHaveBeenCalledWith(actor, {
            clientId: "c1",
            sessionId: "s1",
        });
    });
    (0, vitest_1.it)("open 验证 Session、补建 Job、原子对账并返回双权威状态", async () => {
        const activeSnapshot = {
            ...idleSnapshot,
            status: "running",
            runId: "run-1",
        };
        const { controller, requests, runs } = makeController({
            runs: {
                snapshot: vitest_1.vi
                    .fn()
                    .mockResolvedValueOnce(activeSnapshot)
                    .mockResolvedValueOnce(activeSnapshot),
            },
        });
        requests.request
            .mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
            .mockResolvedValueOnce({ ok: true, data: waitingAgentState });
        await (0, vitest_1.expect)(controller.openSession("c1", "s1", cwdRef, actor)).resolves.toEqual({
            job: activeSnapshot,
            agentState: waitingAgentState,
        });
        (0, vitest_1.expect)(runs.ensureSession).toHaveBeenCalledWith(actor, {
            clientId: "c1",
            sessionId: "s1",
        });
        (0, vitest_1.expect)(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", waitingAgentState);
        (0, vitest_1.expect)(requests.request).toHaveBeenLastCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "agent.state",
            jobId: "s1",
            runId: "run-1",
        }));
    });
    (0, vitest_1.it)("没有活动 run 的 open 使用只读 agent.state", async () => {
        const { controller, requests, runs } = makeController();
        requests.request
            .mockResolvedValueOnce({ ok: true, data: { sessionId: "s1" } })
            .mockResolvedValueOnce({ ok: true, data: idleAgentState });
        await controller.openSession("c1", "s1", cwdRef, actor);
        (0, vitest_1.expect)(runs.reconcileOpen).not.toHaveBeenCalled();
        (0, vitest_1.expect)(requests.request).toHaveBeenLastCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "agent.state",
            sessionId: "s1",
            runId: undefined,
        }));
    });
    (0, vitest_1.it)("complete running 先权威 abort 再完成 matching run", async () => {
        const activeSnapshot = {
            ...idleSnapshot,
            status: "running",
            runId: "run-1",
        };
        const doneSnapshot = { ...idleSnapshot, status: "done" };
        const { controller, requests, runs } = makeController({
            runs: {
                snapshot: vitest_1.vi
                    .fn()
                    .mockResolvedValueOnce(activeSnapshot)
                    .mockResolvedValueOnce(doneSnapshot),
            },
        });
        await (0, vitest_1.expect)(controller.completeSession("c1", "s1", { runId: "run-1" }, actor)).resolves.toEqual(doneSnapshot);
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "agent.abort",
            jobId: "s1",
            runId: "run-1",
        }));
        (0, vitest_1.expect)(runs.completeSession).toHaveBeenCalledWith("s1", "run-1");
    });
    (0, vitest_1.it)("error complete 不请求 Client 并直接完成", async () => {
        const snapshot = { ...idleSnapshot, status: "error" };
        const done = { ...idleSnapshot, status: "done" };
        const { controller, requests, runs } = makeController({
            runs: {
                snapshot: vitest_1.vi
                    .fn()
                    .mockResolvedValueOnce(snapshot)
                    .mockResolvedValueOnce(done),
            },
        });
        await (0, vitest_1.expect)(controller.completeSession("c1", "s1", {}, actor)).resolves.toEqual(done);
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
        (0, vitest_1.expect)(runs.completeSession).toHaveBeenCalledWith("s1", undefined);
    });
    (0, vitest_1.it)("disconnected complete 不请求 Client", async () => {
        const snapshot = {
            ...idleSnapshot,
            status: "disconnected",
            runId: "run-1",
        };
        const { controller, requests } = makeController({
            runs: {
                snapshot: vitest_1.vi.fn().mockResolvedValue(snapshot),
                completeSession: vitest_1.vi.fn(async () => true),
            },
        });
        await controller.completeSession("c1", "s1", { runId: "run-1" }, actor);
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("complete 延迟 abort 时新 run 抢先则稳定冲突且不 abort 新 run", async () => {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const first = {
            ...idleSnapshot,
            status: "running",
            runId: "run-1",
        };
        const next = {
            ...idleSnapshot,
            status: "pending",
            runId: "run-2",
        };
        const { controller, requests } = makeController({
            requests: {
                request: vitest_1.vi.fn(async (_lease, request) => {
                    if (request.action === "agent.abort")
                        await gate;
                    return { ok: true, data: {} };
                }),
            },
            runs: {
                snapshot: vitest_1.vi
                    .fn()
                    .mockResolvedValueOnce(first)
                    .mockResolvedValueOnce(next),
                completeSession: vitest_1.vi.fn(async () => false),
            },
        });
        const completion = controller.completeSession("c1", "s1", { runId: "run-1" }, actor);
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(requests.request).toHaveBeenCalledOnce());
        release();
        await (0, vitest_1.expect)(completion).rejects.toMatchObject({
            response: { code: "PI_CONTROL_FORBIDDEN" },
        });
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({ action: "agent.abort", runId: "run-1" }));
    });
    (0, vitest_1.it)("delete 成功/不存在 commit，执行前拒绝直接 rollback", async () => {
        const { controller, requests, runs } = makeController();
        requests.request
            .mockResolvedValueOnce({ ok: true, data: { ok: true } })
            .mockResolvedValueOnce({
            ok: false,
            error: { code: "PI_SESSION_NOT_FOUND", message: "gone" },
        })
            .mockResolvedValueOnce({
            ok: false,
            error: { code: "PI_PROJECT_NOT_ALLOWED", message: "denied" },
        });
        const remove = () => Reflect.apply(controller.deleteSession, controller, [
            "c1",
            "s1",
            cwdRef,
            actor,
        ]);
        await (0, vitest_1.expect)(remove()).resolves.toEqual({ ok: true });
        await (0, vitest_1.expect)(remove()).resolves.toEqual({ ok: true });
        await (0, vitest_1.expect)(remove()).rejects.toMatchObject({
            response: { code: "PI_PROJECT_NOT_ALLOWED" },
        });
        (0, vitest_1.expect)(runs.beginDelete).toHaveBeenCalledTimes(3);
        (0, vitest_1.expect)(runs.commitDelete).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(runs.rollbackDelete).toHaveBeenCalledTimes(1);
    });
    vitest_1.it.each([
        ["exists", { ok: true, data: { sessionId: "s1" } }, "rollbackDelete"],
        [
            "gone",
            { ok: false, error: { code: "PI_SESSION_NOT_FOUND", message: "gone" } },
            "commitDelete",
        ],
    ])("delete 不确定错误经 session.get 确认 %s", async (_name, confirmation, transition) => {
        const { controller, requests, runs } = makeController();
        requests.request
            .mockResolvedValueOnce({
            ok: false,
            error: { code: "PI_WORKER_EXITED", message: "died" },
        })
            .mockResolvedValueOnce(confirmation);
        const operation = Reflect.apply(controller.deleteSession, controller, [
            "c1",
            "s1",
            cwdRef,
            actor,
        ]);
        if (transition === "commitDelete")
            await (0, vitest_1.expect)(operation).resolves.toEqual({ ok: true });
        else
            await (0, vitest_1.expect)(operation).rejects.toMatchObject({
                response: { code: "PI_WORKER_EXITED" },
            });
        (0, vitest_1.expect)(requests.request).toHaveBeenLastCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "session.get",
            sessionId: "s1",
            cwdRef,
        }));
        (0, vitest_1.expect)(runs[transition]).toHaveBeenCalledWith("s1", "delete-1");
    });
    (0, vitest_1.it)("delete 确认超时保留 reservation", async () => {
        const timeout = Object.assign(new Error("timeout"), {
            code: "PI_REQUEST_TIMEOUT",
        });
        const { controller, requests, runs } = makeController();
        requests.request
            .mockResolvedValueOnce({
            ok: false,
            error: { code: "PI_WORKER_EXITED", message: "died" },
        })
            .mockRejectedValueOnce(timeout);
        await (0, vitest_1.expect)(Reflect.apply(controller.deleteSession, controller, [
            "c1",
            "s1",
            cwdRef,
            actor,
        ])).rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
        (0, vitest_1.expect)(runs.rollbackDelete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(runs.commitDelete).not.toHaveBeenCalled();
    });
    vitest_1.it.each([
        "PI_REQUEST_TIMEOUT",
        "PI_CLIENT_DISCONNECTED",
    ])("delete %s 保留 reservation 供重试", async (code) => {
        const failure = Object.assign(new Error(code), { code });
        const { controller, runs } = makeController({
            requests: {
                request: vitest_1.vi.fn(async () => {
                    throw failure;
                }),
            },
        });
        await (0, vitest_1.expect)(Reflect.apply(controller.deleteSession, controller, [
            "c1",
            "s1",
            cwdRef,
            actor,
        ])).rejects.toMatchObject({
            response: { code },
        });
        (0, vitest_1.expect)(runs.rollbackDelete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(runs.commitDelete).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("delete 未取得 reservation 不请求 Client", async () => {
        const busy = Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" });
        const { controller, requests } = makeController({
            runs: {
                beginDelete: vitest_1.vi.fn(async () => {
                    throw busy;
                }),
            },
        });
        await (0, vitest_1.expect)(Reflect.apply(controller.deleteSession, controller, [
            "c1",
            "s1",
            cwdRef,
            actor,
        ])).rejects.toMatchObject({
            response: { code: "PI_PROJECT_BUSY" },
        });
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("sessions.list 转发 cwdRef", async () => {
        const { controller, requests } = makeController();
        await controller.sessions("c1", "D:\\", "repo");
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "sessions.list",
            cwdRef: { rootDir: "D:\\", relativePath: "repo" },
        }));
    });
    (0, vitest_1.it)("prompt 在单一 generation lease 内 resolve、建 Job 并 dispatch", async () => {
        const { controller, requests, events, runs } = makeController();
        requests.request.mockImplementation(async (_lease, req) => {
            if (req.action === "project.resolve")
                return { ok: true, data: { projectKey: "k".repeat(64) } };
            return { ok: true, data: { accepted: true } };
        });
        const result = await controller.prompt("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor);
        (0, vitest_1.expect)(runs.withReconciledClient).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(runs.startRun).toHaveBeenCalledWith(actor, vitest_1.expect.objectContaining({
            clientId: "c1",
            sessionId: "s1",
            projectKey: "k".repeat(64),
        }));
        (0, vitest_1.expect)(events.publish).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            jobId: "s1",
            event: vitest_1.expect.objectContaining({
                type: "run_created",
                submissionId: "sub-1",
                runId: "run-1",
            }),
        }));
        (0, vitest_1.expect)(result).toEqual({ jobId: "s1", runId: "run-1", sessionId: "s1" });
    });
    (0, vitest_1.it)("pending generation 映射为稳定 PI_STATE_PENDING HTTP 错误且不创建 Job", async () => {
        const pending = Object.assign(new Error("Pi client state reconciliation is pending"), { code: "PI_STATE_PENDING" });
        const { controller, requests, runs } = makeController({
            runs: {
                withReconciledClient: vitest_1.vi.fn(async () => {
                    throw pending;
                }),
            },
        });
        await (0, vitest_1.expect)(controller.prompt("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor)).rejects.toMatchObject({
            response: {
                code: "PI_STATE_PENDING",
                message: "Pi client state reconciliation is pending",
            },
        });
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
        (0, vitest_1.expect)(runs.startRun).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("非 Pi code 保持基础设施错误，不映射为暴露 message 的 400", async () => {
        const prismaError = Object.assign(new Error("secret unique constraint details"), {
            code: "P2002",
        });
        const { controller } = makeController({
            runs: {
                withReconciledClient: vitest_1.vi.fn(async () => {
                    throw prismaError;
                }),
            },
        });
        let caught;
        try {
            await controller.sessions("c1", "D:\\", "repo");
        }
        catch (error) {
            caught = error;
        }
        (0, vitest_1.expect)(caught).toBe(prismaError);
        (0, vitest_1.expect)(caught).not.toBeInstanceOf(common_1.BadRequestException);
        (0, vitest_1.expect)(caught.response).toBeUndefined();
    });
    (0, vitest_1.it)("project mutation 在同一 lease 内 resolve、锁检查并请求", async () => {
        const { controller, requests, runs } = makeController();
        requests.request.mockImplementation(async (_lease, req) => req.action === "project.resolve"
            ? { ok: true, data: { projectKey: "k".repeat(64) } }
            : { ok: true, data: {} });
        await controller.setThinking("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            level: "high",
        }, actor);
        (0, vitest_1.expect)(runs.withReconciledClient).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "k".repeat(64));
        (0, vitest_1.expect)(requests.request).toHaveBeenNthCalledWith(1, { clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({ action: "project.resolve" }));
        (0, vitest_1.expect)(requests.request).toHaveBeenNthCalledWith(2, { clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({ action: "thinking.set" }));
    });
    vitest_1.it.each([
        "success",
        "error",
        "timeout",
        "disconnect",
    ])("pending complete 后 dispatch %s 仍补发同 run abort", async (outcome) => {
        const { controller, requests } = makeController({
            runs: {
                snapshot: vitest_1.vi.fn(async () => ({
                    ...idleSnapshot,
                    status: "done",
                    runId: null,
                })),
            },
        });
        requests.request.mockImplementation((async (_lease, request) => {
            if (request.action === "project.resolve")
                return { ok: true, data: { projectKey: "k".repeat(64) } };
            if (request.action === "agent.abort")
                return { ok: true, data: {} };
            if (outcome === "success")
                return { ok: true, data: { accepted: true } };
            if (outcome === "error")
                return {
                    ok: false,
                    error: { code: "PI_WORKER_EXITED", message: "died" },
                };
            throw Object.assign(new Error(outcome), {
                code: outcome === "timeout"
                    ? "PI_REQUEST_TIMEOUT"
                    : "PI_CLIENT_DISCONNECTED",
            });
        }));
        const operation = controller.prompt("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor);
        await (0, vitest_1.expect)(operation).rejects.toMatchObject({
            response: { code: "PI_CONTROL_FORBIDDEN" },
        });
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "agent.abort",
            jobId: "s1",
            runId: "run-1",
        }));
    });
    (0, vitest_1.it)("new/fork/clone 建 Job 失败重试一次并按 lease 补偿删除", async () => {
        const dbError = new Error("db down");
        for (const kind of ["fork", "clone"]) {
            const { controller, requests, runs } = makeController({
                runs: {
                    ensureSession: vitest_1.vi.fn(async () => {
                        throw dbError;
                    }),
                },
            });
            requests.request.mockImplementation(async (_lease, request) => {
                if (request.action === "project.resolve")
                    return { ok: true, data: { projectKey: "k".repeat(64) } };
                if (request.action === `session.${kind}`)
                    return { ok: true, data: { sessionId: `${kind}-1` } };
                return { ok: true, data: {} };
            });
            const operation = kind === "fork"
                ? Reflect.apply(controller.forkSession, controller, [
                    "c1",
                    "s1",
                    { ...cwdRef, messageId: "m1" },
                    actor,
                ])
                : Reflect.apply(controller.cloneSession, controller, [
                    "c1",
                    "s1",
                    cwdRef,
                    actor,
                ]);
            await (0, vitest_1.expect)(operation).rejects.toBe(dbError);
            (0, vitest_1.expect)(runs.ensureSession).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
                action: "session.delete",
                sessionId: `${kind}-1`,
            }));
        }
    });
    (0, vitest_1.it)("rename/delete 在 owner 检查前调用 ensureSession，为未打开的会话补 Job 记录", async () => {
        const { controller, runs } = makeController();
        await controller.renameSession("c1", "s1", { rootDir: "D:\\", relativePath: "repo", name: "new" }, actor);
        (0, vitest_1.expect)(runs.ensureSession).toHaveBeenCalledWith(actor, {
            clientId: "c1",
            sessionId: "s1",
        });
        (0, vitest_1.expect)(runs.assertSessionOwner).toHaveBeenCalledWith("s1", actor.identityId);
        await controller.deleteSession("c1", "s1", { rootDir: "D:\\", relativePath: "repo" }, actor);
        // delete 路径也会调 ensureSession（为 beginDelete 补 Job）
        (0, vitest_1.expect)(runs.ensureSession).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(runs.beginDelete).toHaveBeenCalledWith("s1", actor.identityId);
    });
    (0, vitest_1.it)("fixed Owner mutation 在任何 Client request 前拒绝非 Owner", async () => {
        const forbidden = Object.assign(new Error("forbidden"), {
            code: "PI_CONTROL_FORBIDDEN",
        });
        const { controller, requests } = makeController({
            runs: {
                assertSessionOwner: vitest_1.vi.fn(async () => {
                    throw forbidden;
                }),
            },
        });
        const operations = [
            () => Reflect.apply(controller.renameSession, controller, [
                "c1",
                "s1",
                { ...cwdRef, name: "n" },
                actor,
            ]),
            () => Reflect.apply(controller.forkSession, controller, [
                "c1",
                "s1",
                { ...cwdRef, messageId: "m1" },
                actor,
            ]),
            () => Reflect.apply(controller.cloneSession, controller, [
                "c1",
                "s1",
                cwdRef,
                actor,
            ]),
            () => Reflect.apply(controller.navigateSession, controller, [
                "c1",
                "s1",
                { ...cwdRef, targetId: "m1" },
                actor,
            ]),
            () => Reflect.apply(controller.setModel, controller, [
                "c1",
                "s1",
                { ...cwdRef, provider: "p", modelId: "m" },
                actor,
            ]),
            () => Reflect.apply(controller.setThinking, controller, [
                "c1",
                "s1",
                { ...cwdRef, level: "high" },
                actor,
            ]),
        ];
        for (const operation of operations) {
            await (0, vitest_1.expect)(operation()).rejects.toMatchObject({
                response: { code: "PI_CONTROL_FORBIDDEN" },
            });
        }
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
    });
    vitest_1.it.each([
        [
            "active",
            { ...idleAgentState, status: "running", streaming: true },
            "accept",
        ],
        ["not-started", idleAgentState, "finishRun"],
        [
            "pending-extension",
            {
                ...idleAgentState,
                pendingExtension: {
                    requestId: "u1",
                    extensionId: "e",
                    kind: "confirm",
                    message: "trust?",
                },
            },
            "accept",
        ],
    ])("prompt dispatch timeout 后按权威 %s state 对账", async (_name, state, transition) => {
        const timeout = Object.assign(new Error("timeout"), {
            code: "PI_REQUEST_TIMEOUT",
        });
        const { controller, requests, runs } = makeController();
        requests.request.mockImplementation((async (_lease, request) => {
            if (request.action === "project.resolve")
                return { ok: true, data: { projectKey: "k".repeat(64) } };
            if (request.action === "agent.prompt")
                throw timeout;
            if (request.action === "agent.state")
                return { ok: true, data: state };
            return { ok: true, data: {} };
        }));
        await (0, vitest_1.expect)(controller.prompt("c1", "s1", {
            ...cwdRef,
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor)).rejects.toMatchObject({ response: { code: "PI_REQUEST_TIMEOUT" } });
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "agent.state",
            jobId: "s1",
            runId: "run-1",
        }));
        (0, vitest_1.expect)(runs[transition]).toHaveBeenCalledWith("s1", "run-1");
        if (transition === "accept") {
            (0, vitest_1.expect)(runs.finishRun).not.toHaveBeenCalled();
            (0, vitest_1.expect)(runs.reconcileOpen).toHaveBeenCalledWith("s1", "run-1", state);
        }
    });
    (0, vitest_1.it)("extension-response 成功后不再乐观 resume（状态只由 matching extension_resolved 驱动）", async () => {
        const { controller, requests, runs } = makeController();
        await (0, vitest_1.expect)(controller.extensionResponse("c1", "s1", { runId: "run-1", requestId: "unknown-ui" }, actor)).resolves.toEqual({ ok: true });
        (0, vitest_1.expect)(requests.request).toHaveBeenCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "extension.respond",
            sessionId: "s1",
            jobId: "s1",
            runId: "run-1",
            payload: { requestId: "unknown-ui" },
        }));
        (0, vitest_1.expect)(runs.resume).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("prompt dispatch disconnect 将 matching run CAS 为 disconnected", async () => {
        const disconnected = Object.assign(new Error("disconnected"), {
            code: "PI_CLIENT_DISCONNECTED",
        });
        const { controller, requests, runs } = makeController();
        requests.request.mockImplementation((async (_lease, request) => {
            if (request.action === "project.resolve")
                return { ok: true, data: { projectKey: "k".repeat(64) } };
            throw disconnected;
        }));
        await (0, vitest_1.expect)(controller.prompt("c1", "s1", {
            ...cwdRef,
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor)).rejects.toMatchObject({ response: { code: "PI_CLIENT_DISCONNECTED" } });
        (0, vitest_1.expect)(runs.markRunDisconnected).toHaveBeenCalledWith("s1", "run-1");
    });
    (0, vitest_1.it)("prompt 请求失败时 matching run 回 idle", async () => {
        const { controller, requests, runs } = makeController();
        requests.request.mockImplementation((async (_lease, req) => {
            if (req.action === "project.resolve")
                return { ok: true, data: { projectKey: "k".repeat(64) } };
            return {
                ok: false,
                error: { code: "PI_WORKER_EXITED", message: "died" },
            };
        }));
        await (0, vitest_1.expect)(controller.prompt("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "sub-1",
            prompt: "hello",
        }, actor)).rejects.toBeInstanceOf(common_1.BadRequestException);
        (0, vitest_1.expect)(runs.finishRun).toHaveBeenCalledWith("s1", "run-1");
    });
    vitest_1.it.each([
        [
            "steer",
            (controller, body) => Reflect.apply(controller.steer, controller, ["c1", "s1", body, actor]),
        ],
        [
            "follow-up",
            (controller, body) => Reflect.apply(controller.followUp, controller, [
                "c1",
                "s1",
                body,
                actor,
            ]),
        ],
        [
            "abort",
            (controller, body) => Reflect.apply(controller.abort, controller, ["c1", "s1", body, actor]),
        ],
        [
            "compact",
            (controller, body) => Reflect.apply(controller.compact, controller, [
                "c1",
                "s1",
                body,
                actor,
            ]),
        ],
        [
            "abort-compact",
            (controller, body) => Reflect.apply(controller.abortCompact, controller, [
                "c1",
                "s1",
                body,
                actor,
            ]),
        ],
        [
            "extension-response",
            (controller, body) => Reflect.apply(controller.extensionResponse, controller, [
                "c1",
                "s1",
                body,
                actor,
            ]),
        ],
    ])("%s 严格校验 run-scoped body", async (_name, invoke) => {
        for (const body of [null, [], { runId: "" }, { runId: "x".repeat(257) }]) {
            const { controller, requests } = makeController();
            await (0, vitest_1.expect)(invoke(controller, body)).rejects.toMatchObject({
                response: { code: "PI_PROTOCOL_INVALID" },
            });
            (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
        }
    });
    vitest_1.it.each([
        [
            "steer",
            (controller) => controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor),
        ],
        [
            "follow-up",
            (controller) => controller.followUp("c1", "s1", { runId: "run-1", message: "go" }, actor),
        ],
        [
            "abort",
            (controller) => controller.abort("c1", "s1", { runId: "run-1" }, actor),
        ],
        [
            "compact",
            (controller) => controller.compact("c1", "s1", { runId: "run-1" }, actor),
        ],
        [
            "abort-compact",
            (controller) => controller.abortCompact("c1", "s1", { runId: "run-1" }, actor),
        ],
        [
            "extension-response",
            (controller) => controller.extensionResponse("c1", "s1", { runId: "run-1", requestId: "ui-1" }, actor),
        ],
        [
            "model",
            (controller) => controller.setModel("c1", "s1", { ...cwdRef, provider: "p", modelId: "m" }, actor),
        ],
        [
            "thinking",
            (controller) => controller.setThinking("c1", "s1", { ...cwdRef, level: "high" }, actor),
        ],
    ])("旧 Client 调用 %s 返回 PI_CLIENT_UNSUPPORTED", async (_name, invoke) => {
        const { controller, clients, requests } = makeController();
        clients.listOnline.mockResolvedValue([
            {
                clientId: "c1",
                capabilities: ["agent.pi"],
                capabilityDetails: { pi: { available: true } },
            },
        ]);
        await (0, vitest_1.expect)(invoke(controller)).rejects.toMatchObject({
            response: { code: "PI_CLIENT_UNSUPPORTED" },
        });
        (0, vitest_1.expect)(requests.request).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("非法 body 返回 400", async () => {
        const { controller } = makeController();
        await (0, vitest_1.expect)(controller.prompt("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "steer", // 错误 type
            submissionId: "s",
            prompt: "x",
        }, actor)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    (0, vitest_1.it)("steer 先校验 Owner", async () => {
        const { controller, runs } = makeController();
        runs.assertCurrentRunOwner.mockRejectedValue(Object.assign(new Error("forbidden"), { code: "PI_CONTROL_FORBIDDEN" }));
        await (0, vitest_1.expect)(controller.steer("c1", "s1", { runId: "run-1", message: "go" }, actor)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    (0, vitest_1.it)("活动回合时 model.set 拒绝（assertIdle 失败）", async () => {
        const { controller, requests, runs } = makeController();
        requests.request.mockResolvedValue({
            ok: true,
            data: { projectKey: "k".repeat(64) },
        });
        runs.assertIdleMutation.mockRejectedValue(Object.assign(new Error("busy"), { code: "PI_PROJECT_BUSY" }));
        await (0, vitest_1.expect)(controller.setModel("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            provider: "p",
            modelId: "m",
        }, actor)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    (0, vitest_1.it)("thinking.set 校验 SDK 原生 level 并转发 cwd/session", async () => {
        const { controller, requests, runs } = makeController();
        requests.request.mockResolvedValue({
            ok: true,
            data: { projectKey: "k".repeat(64) },
        });
        await controller.setThinking("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            level: "high",
        }, actor);
        (0, vitest_1.expect)(runs.assertIdleMutation).toHaveBeenCalledWith("c1", "k".repeat(64));
        (0, vitest_1.expect)(requests.request).toHaveBeenLastCalledWith({ clientId: "c1", socketId: "socket-1" }, vitest_1.expect.objectContaining({
            action: "thinking.set",
            sessionId: "s1",
            cwdRef: { rootDir: "D:\\", relativePath: "repo" },
            payload: { level: "high" },
        }));
    });
    (0, vitest_1.it)("thinking.set 拒绝 auto 和未知 level", async () => {
        const { controller } = makeController();
        await (0, vitest_1.expect)(controller.setThinking("c1", "s1", {
            rootDir: "D:\\",
            relativePath: "repo",
            level: "auto",
        }, actor)).rejects.toMatchObject({ response: { code: "PI_PROTOCOL_INVALID" } });
    });
    (0, vitest_1.it)("SSE stream 不要求 Owner", async () => {
        const { controller, events } = makeController();
        controller.stream("c1", "s1");
        (0, vitest_1.expect)(events.stream).toHaveBeenCalledWith("c1", "s1");
    });
    (0, vitest_1.it)("running 返回活动回合列表", async () => {
        const { controller, runs } = makeController();
        runs.listActiveByClient.mockResolvedValue([
            { jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
        ]);
        const result = await controller.running("c1");
        (0, vitest_1.expect)(result).toEqual([
            { jobId: "j1", runId: "j1", sessionId: "s1", status: "running" },
        ]);
    });
});
