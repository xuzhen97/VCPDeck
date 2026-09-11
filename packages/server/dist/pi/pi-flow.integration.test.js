"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_gateway_js_1 = require("../events/client.gateway.js");
const pi_controller_js_1 = require("./pi.controller.js");
const pi_event_broker_js_1 = require("./pi-event-broker.js");
const pi_request_broker_js_1 = require("./pi-request-broker.js");
const pi_run_service_js_1 = require("./pi-run.service.js");
const actor = {
    identityId: "user-1",
    displayName: "User",
    isAdmin: false,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "req-1",
};
const PROJECT_KEY = "a".repeat(64);
const PROMPT_SENTINEL = "SENTINEL_PROMPT_9f2a";
const URL_SENTINEL = "SENTINEL_SIGNED_URL_7c11";
const THINKING_SENTINEL = "SENTINEL_THINKING_3d4e";
const TOOL_SENTINEL = "SENTINEL_TOOL_RESULT_5b8f";
const EXTENSION_SENTINEL = "SENTINEL_EXTENSION_INPUT_c621";
const ERROR_SENTINEL = "SENTINEL_PROMPT_ERROR_d18c";
const SENSITIVE_SENTINELS = [
    PROMPT_SENTINEL,
    URL_SENTINEL,
    THINKING_SENTINEL,
    TOOL_SENTINEL,
    EXTENSION_SENTINEL,
    ERROR_SENTINEL,
];
function matches(value, condition) {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        const { in: values } = condition;
        if (values)
            return values.includes(value);
    }
    return value === condition;
}
/** 记录全部写调用的最小内存 Prisma，用于状态与敏感正文断言。 */
function makePrismaMemory() {
    const jobs = [];
    const calls = [];
    const job = {
        create: vitest_1.vi.fn(async (args) => {
            calls.push(args);
            if (jobs.some((candidate) => candidate.id === args.data.id))
                throw { code: "P2002" };
            const created = {
                payload: "{}",
                progress: null,
                result: null,
                errorCode: null,
                errorMessage: null,
                startedAt: null,
                finishedAt: null,
                ...args.data,
            };
            jobs.push(created);
            return created;
        }),
        findUnique: vitest_1.vi.fn(async (args) => jobs.find((candidate) => candidate.id === args.where.id) ?? null),
        findMany: vitest_1.vi.fn(async (args) => jobs.filter((candidate) => Object.entries(args?.where ?? {}).every(([key, value]) => matches(candidate[key], value)))),
        update: vitest_1.vi.fn(async (args) => {
            calls.push(args);
            const candidate = jobs.find((item) => item.id === args.where.id);
            if (!candidate)
                throw new Error("not found");
            Object.assign(candidate, args.data);
            return candidate;
        }),
        updateMany: vitest_1.vi.fn(async (args) => {
            calls.push(args);
            let count = 0;
            for (const candidate of jobs) {
                if (Object.entries(args.where).every(([key, value]) => matches(candidate[key], value))) {
                    Object.assign(candidate, args.data);
                    count += 1;
                }
            }
            return { count };
        }),
    };
    return { job, jobs, calls };
}
function makeSocket(id) {
    return {
        id,
        data: {},
        join: vitest_1.vi.fn(),
        emit: vitest_1.vi.fn(),
    };
}
function registration(clientId = "c1") {
    return {
        clientId,
        hostname: "host",
        os: "win32",
        cpuModel: "cpu",
        totalMemMB: 1024,
        clientVersion: "1",
        capabilities: ["agent.pi"],
        capabilityDetails: {
            pi: {
                available: true,
                sdkVersion: "1",
                nodeVersion: "22.18.0",
                shellKind: "path",
                sessionJobProtocolVersion: 1,
            },
        },
    };
}
function report(runs = []) {
    return { clientId: "c1", runs };
}
function makeLoopback() {
    const prisma = makePrismaMemory();
    const runs = new pi_run_service_js_1.PiRunService(prisma);
    const requests = new pi_request_broker_js_1.PiRequestBroker();
    const events = new pi_event_broker_js_1.PiEventBroker(requests, runs);
    const sockets = new Map();
    const requestHandlers = new Map();
    const clientService = {
        register: vitest_1.vi.fn(async () => { }),
        markOfflineBySocketId: vitest_1.vi.fn(async () => { }),
        listOnline: vitest_1.vi.fn(async () => [
            {
                clientId: "c1",
                capabilities: ["agent.pi"],
                capabilityDetails: {
                    pi: { available: true, sessionJobProtocolVersion: 1 },
                },
            },
        ]),
    };
    const jobService = {
        markDisconnected: vitest_1.vi.fn(async () => { }),
        markDone: vitest_1.vi.fn(async () => null),
    };
    const fileService = { confirmUpload: vitest_1.vi.fn() };
    const frpService = {
        markInactiveByClientId: vitest_1.vi.fn(async () => { }),
        updateStatus: vitest_1.vi.fn(async () => { }),
    };
    const terminalService = {
        handleClientResponse: vitest_1.vi.fn(async () => { }),
        handleClientOutput: vitest_1.vi.fn(async () => { }),
        handleClientExit: vitest_1.vi.fn(async () => { }),
        handleClientState: vitest_1.vi.fn(async () => ({
            acceptedSessionIds: [],
            closeSessionIds: [],
        })),
        handleClientDisconnect: vitest_1.vi.fn(async () => { }),
        handleClientRegistered: vitest_1.vi.fn(async () => { }),
    };
    const terminalBroker = {
        bindEmitter: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
        resolve: vitest_1.vi.fn(),
    };
    const gateway = new client_gateway_js_1.ClientGateway(clientService, jobService, fileService, frpService, requests, events, runs, terminalService, terminalBroker, {
        onClientRegistered: vitest_1.vi.fn(),
        onUpdateReady: vitest_1.vi.fn(),
        onUpdateFailed: vitest_1.vi.fn(),
    }, { bindEmitters: vitest_1.vi.fn() });
    gateway.server = {
        emit: vitest_1.vi.fn(),
        to: vitest_1.vi.fn((socketId) => ({
            emit: (_event, request) => requestHandlers.get(socketId)?.(request),
        })),
    };
    gateway.afterInit();
    const controller = new pi_controller_js_1.PiController(requests, events, runs, clientService, {
        createPromptUploads: vitest_1.vi.fn(),
        completePromptUpload: vitest_1.vi.fn(),
        deleteAttachment: vitest_1.vi.fn(),
    });
    const addSocket = (id) => {
        const socket = makeSocket(id);
        sockets.set(id, socket);
        return socket;
    };
    const respond = async (socket, response) => {
        await gateway.handlePiResponse(socket, response);
    };
    const autoRespond = (socket, state = idleState()) => {
        requestHandlers.set(socket.id, (request) => {
            const data = request.action === "project.resolve"
                ? { projectKey: PROJECT_KEY }
                : request.action === "agent.state"
                    ? state
                    : { accepted: true };
            queueMicrotask(() => void respond(socket, {
                requestId: request.requestId,
                ok: true,
                data,
            }));
        });
    };
    const register = async (socket) => {
        await gateway.handleRegister(socket, registration());
    };
    const reconcile = async (socket, stateReport = report()) => {
        const result = await gateway.handlePiState(socket, stateReport);
        return result;
    };
    const current = (jobId) => prisma.jobs.find((job) => job.id === jobId);
    return {
        prisma,
        runs,
        requests,
        events,
        gateway,
        controller,
        jobService,
        requestHandlers,
        addSocket,
        respond,
        autoRespond,
        register,
        reconcile,
        current,
    };
}
function idleState() {
    return {
        status: "idle",
        streaming: false,
        prompting: false,
        compacting: false,
        thinkingLevel: "off",
        queuedMessages: { steering: [], followUp: [] },
    };
}
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
(0, vitest_1.describe)("Pi Gateway loopback 集成", () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)("REGISTER→PI_STATE 后，Gateway 事件驱动 waiting→running→idle settlement", async () => {
        vitest_1.vi.useFakeTimers();
        const loop = makeLoopback();
        const socket = loop.addSocket("socket-1");
        loop.autoRespond(socket);
        await loop.register(socket);
        await (0, vitest_1.expect)(loop.controller.sessions("c1", "D:\\", "repo")).rejects.toMatchObject({
            response: { code: "PI_STATE_PENDING" },
        });
        (0, vitest_1.expect)(await loop.reconcile(socket)).toEqual({
            acceptedRunIds: [],
            closedRunIds: [],
            reportAgain: false,
        });
        await loop.runs.ensureSession(actor, {
            clientId: "c1",
            sessionId: "session-1",
        });
        const run = await loop.runs.startRun(actor, {
            clientId: "c1",
            sessionId: "session-1",
            projectKey: PROJECT_KEY,
        });
        await loop.runs.accept(run.jobId, run.runId);
        const base = {
            clientId: "c1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: run.runId,
        };
        await loop.gateway.handlePiEvent(socket, {
            ...base,
            event: {
                type: "extension_request",
                sessionId: "session-1",
                ui: { requestId: "ui-1", extensionId: "ext", kind: "confirm" },
            },
        });
        (0, vitest_1.expect)(loop.current("session-1").status).toBe("waiting_input");
        await loop.gateway.handlePiEvent(socket, {
            ...base,
            event: {
                type: "extension_resolved",
                sessionId: "session-1",
                requestId: "ui-1",
                reason: "answered",
                hasPending: false,
            },
        });
        (0, vitest_1.expect)(loop.current("session-1").status).toBe("running");
        await loop.gateway.handlePiEvent(socket, {
            ...base,
            event: { type: "agent_settled", sessionId: "session-1" },
        });
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        await flush();
        (0, vitest_1.expect)(loop.current("session-1")).toMatchObject({
            status: "idle",
            payload: "{}",
        });
    });
    (0, vitest_1.it)("run-1/run-2 settlement 交错与 complete race 保持当前 run/done", async () => {
        vitest_1.vi.useFakeTimers();
        const loop = makeLoopback();
        const socket = loop.addSocket("socket-1");
        loop.autoRespond(socket);
        await loop.register(socket);
        await loop.reconcile(socket);
        await loop.runs.ensureSession(actor, {
            clientId: "c1",
            sessionId: "session-1",
        });
        const run1 = await loop.runs.startRun(actor, {
            clientId: "c1",
            sessionId: "session-1",
            projectKey: PROJECT_KEY,
        });
        await loop.runs.accept(run1.jobId, run1.runId);
        await loop.gateway.handlePiEvent(socket, {
            clientId: "c1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: run1.runId,
            event: { type: "agent_settled", sessionId: "session-1" },
        });
        await loop.runs.finishRun(run1.jobId, run1.runId);
        const run2 = await loop.runs.startRun(actor, {
            clientId: "c1",
            sessionId: "session-1",
            projectKey: PROJECT_KEY,
        });
        await loop.runs.accept(run2.jobId, run2.runId);
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        (0, vitest_1.expect)(loop.current("session-1")).toMatchObject({
            status: "running",
            payload: JSON.stringify({ runId: run2.runId }),
        });
        await loop.gateway.handlePiEvent(socket, {
            clientId: "c1",
            sessionId: "session-1",
            jobId: "session-1",
            runId: run2.runId,
            event: { type: "agent_settled", sessionId: "session-1" },
        });
        await loop.runs.completeSession("session-1", run2.runId);
        await vitest_1.vi.advanceTimersByTimeAsync(30_000);
        (0, vitest_1.expect)(loop.current("session-1")).toMatchObject({
            status: "done",
            payload: "{}",
        });
    });
    (0, vitest_1.it)("projectKey 冲突要求二次 PI_STATE；prompt_error sentinel 不持久化", async () => {
        const loop = makeLoopback();
        const socket = loop.addSocket("socket-1");
        await loop.runs.ensureSession(actor, {
            clientId: "c1",
            sessionId: "session-1",
        });
        await loop.runs.ensureSession(actor, {
            clientId: "c1",
            sessionId: "session-2",
        });
        const run1 = await loop.runs.startRun(actor, {
            clientId: "c1",
            sessionId: "session-1",
            projectKey: "1".repeat(64),
        });
        const run2 = await loop.runs.startRun(actor, {
            clientId: "c1",
            sessionId: "session-2",
            projectKey: "2".repeat(64),
        });
        await loop.runs.accept(run1.jobId, run1.runId);
        await loop.runs.accept(run2.jobId, run2.runId);
        await loop.register(socket);
        (0, vitest_1.expect)(await loop.reconcile(socket, report([
            {
                jobId: "session-1",
                sessionId: "session-1",
                runId: run1.runId,
                status: "running",
                projectKey: PROJECT_KEY,
            },
            {
                jobId: "session-2",
                sessionId: "session-2",
                runId: run2.runId,
                status: "running",
                projectKey: PROJECT_KEY,
            },
        ]))).toEqual({
            acceptedRunIds: [],
            closedRunIds: [run1.runId, run2.runId],
            reportAgain: true,
        });
        await (0, vitest_1.expect)(loop.controller.sessions("c1", "D:\\", "repo")).rejects.toMatchObject({
            response: { code: "PI_STATE_PENDING" },
        });
        (0, vitest_1.expect)(await loop.reconcile(socket)).toEqual({
            acceptedRunIds: [],
            closedRunIds: [],
            reportAgain: false,
        });
        loop.autoRespond(socket);
        const run3 = await loop.controller.prompt("c1", "session-3", {
            rootDir: `D:\\${URL_SENTINEL}`,
            relativePath: "repo",
            type: "prompt",
            submissionId: "submission-sensitive",
            prompt: PROMPT_SENTINEL,
        }, actor);
        const events = [
            {
                type: "message_update",
                sessionId: "session-3",
                text: PROMPT_SENTINEL,
            },
            {
                type: "thinking_progress",
                sessionId: "session-3",
                text: `${THINKING_SENTINEL} ${URL_SENTINEL}`,
            },
            {
                type: "message_update",
                sessionId: "session-3",
                text: TOOL_SENTINEL,
                role: "tool_result",
            },
            {
                type: "extension_request",
                sessionId: "session-3",
                ui: {
                    requestId: "ui-sensitive",
                    extensionId: "ext",
                    kind: "input",
                    message: EXTENSION_SENTINEL,
                },
            },
            {
                type: "prompt_error",
                sessionId: "session-3",
                code: "PI_WORKER_EXITED",
                message: ERROR_SENTINEL,
            },
        ];
        for (const event of events) {
            await loop.gateway.handlePiEvent(socket, {
                clientId: "c1",
                sessionId: "session-3",
                jobId: run3.jobId,
                runId: run3.runId,
                event,
            });
        }
        const job = loop.current(run3.jobId);
        (0, vitest_1.expect)(job).toMatchObject({
            errorMessage: null,
            progress: null,
            result: null,
        });
        const persisted = JSON.stringify({ calls: loop.prisma.calls, job });
        for (const sentinel of SENSITIVE_SENTINELS) {
            (0, vitest_1.expect)(persisted).not.toContain(sentinel);
        }
    });
    vitest_1.it.each([
        [
            "active",
            { ...idleState(), status: "running", streaming: true },
            "running",
        ],
        ["not-started", idleState(), "idle"],
    ])("prompt timeout 但 Worker %s 时按权威 state 收敛", async (_name, state, expectedStatus) => {
        vitest_1.vi.useFakeTimers();
        const loop = makeLoopback();
        const socket = loop.addSocket("socket-1");
        await loop.register(socket);
        await loop.reconcile(socket);
        loop.requestHandlers.set(socket.id, (request) => {
            if (request.action === "project.resolve") {
                queueMicrotask(() => void loop.respond(socket, {
                    requestId: request.requestId,
                    ok: true,
                    data: { projectKey: PROJECT_KEY },
                }));
            }
            else if (request.action === "agent.state") {
                queueMicrotask(() => void loop.respond(socket, {
                    requestId: request.requestId,
                    ok: true,
                    data: state,
                }));
            }
        });
        const prompt = loop.controller.prompt("c1", "session-timeout", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "submission-timeout",
            prompt: PROMPT_SENTINEL,
        }, actor);
        const outcome = (0, vitest_1.expect)(prompt).rejects.toMatchObject({
            response: { code: "PI_REQUEST_TIMEOUT" },
        });
        await flush();
        await vitest_1.vi.advanceTimersByTimeAsync(15_000);
        await outcome;
        (0, vitest_1.expect)(loop.current("session-timeout").status).toBe(expectedStatus);
    });
    (0, vitest_1.it)("REST lease 跨 await 阻塞 REGISTER，且新旧 socket 响应/断线隔离", async () => {
        const loop = makeLoopback();
        const oldSocket = loop.addSocket("socket-1");
        const newSocket = loop.addSocket("socket-2");
        await loop.register(oldSocket);
        await loop.reconcile(oldSocket);
        const emitted = [];
        loop.requestHandlers.set(oldSocket.id, (request) => emitted.push(request));
        const prompt = loop.controller.prompt("c1", "session-legacy", {
            rootDir: "D:\\",
            relativePath: "repo",
            type: "prompt",
            submissionId: "submission-1",
            prompt: PROMPT_SENTINEL,
        }, actor);
        await flush();
        (0, vitest_1.expect)(emitted[0]?.action).toBe("project.resolve");
        const nextRegister = loop.register(newSocket);
        await flush();
        (0, vitest_1.expect)(newSocket.data.clientId).toBe("c1");
        (0, vitest_1.expect)(newSocket.emit).not.toHaveBeenCalledWith("ack", vitest_1.expect.anything());
        const resolveRequest = emitted[0];
        await loop.respond(newSocket, {
            requestId: resolveRequest.requestId,
            ok: true,
            data: { projectKey: "f".repeat(64) },
        });
        await flush();
        (0, vitest_1.expect)(emitted).toHaveLength(1);
        await loop.respond(oldSocket, {
            requestId: resolveRequest.requestId,
            ok: true,
            data: { projectKey: PROJECT_KEY },
        });
        await flush();
        (0, vitest_1.expect)(emitted[1]?.action).toBe("agent.prompt");
        const promptRequest = emitted[1];
        await loop.respond(newSocket, {
            requestId: promptRequest.requestId,
            ok: true,
            data: { accepted: false },
        });
        await flush();
        await loop.respond(oldSocket, {
            requestId: promptRequest.requestId,
            ok: true,
            data: { accepted: true },
        });
        await (0, vitest_1.expect)(prompt).resolves.toMatchObject({
            sessionId: "session-legacy",
        });
        await nextRegister;
        (0, vitest_1.expect)(newSocket.emit).toHaveBeenCalledWith("ack", { event: "register" });
        await loop.reconcile(newSocket);
        const beforeDisconnect = { ...loop.prisma.jobs[0] };
        await loop.gateway.handleDisconnect(oldSocket);
        (0, vitest_1.expect)(loop.jobService.markDisconnected).not.toHaveBeenCalled();
        (0, vitest_1.expect)(loop.prisma.jobs[0]).toEqual(beforeDisconnect);
    });
});
