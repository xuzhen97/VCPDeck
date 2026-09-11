"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const client_gateway_js_1 = require("../events/client.gateway.js");
const terminal_service_js_1 = require("./terminal.service.js");
const terminal_request_broker_js_1 = require("./terminal-request-broker.js");
const integration_helpers_js_1 = require("./integration-helpers.js");
const ACTOR = {
    identityId: "user-1",
    displayName: "Admin",
    isAdmin: true,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "req-1",
};
// ── 回路 harness：真实 gateway + service + broker，fake client（模拟 PTY 桥） ──
function makeHarness() {
    const memory = (0, integration_helpers_js_1.makeMemoryPrisma)();
    const broker = new terminal_request_broker_js_1.TerminalRequestBroker();
    const service = terminal_service_js_1.TerminalService.withDeps({
        prisma: memory.prisma,
        broker,
        audit: memory.audit,
    });
    const browserEmits = [];
    service.bindBrowserEmitter((socketId, event, payload) => browserEmits.push({ socketId, event, payload }));
    const fakeClient = (0, integration_helpers_js_1.makeFakeClient)();
    fakeClient.setOnOutput((sessionId, data) => {
        const pty = fakeClient.ptys.get(sessionId);
        pty.seq += 1;
        void service.handleClientOutput("c1", { sessionId, seq: pty.seq, data });
    });
    const gateway = new client_gateway_js_1.ClientGateway({
        register: vitest_1.vi.fn(async () => { }),
        getClientIdBySocketId: vitest_1.vi.fn(async () => "c1"),
        markOfflineBySocketId: vitest_1.vi.fn(async () => { }),
    }, {
        markDisconnected: vitest_1.vi.fn(async () => { }),
        markDone: vitest_1.vi.fn(async () => null),
    }, { confirmUpload: vitest_1.vi.fn() }, {
        markInactiveByClientId: vitest_1.vi.fn(async () => { }),
        updateStatus: vitest_1.vi.fn(),
    }, {
        bindEmitter: vitest_1.vi.fn(),
        request: vitest_1.vi.fn(),
        resolve: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
    }, { publish: vitest_1.vi.fn(), stream: vitest_1.vi.fn() }, {
        markReconcilePending: vitest_1.vi.fn(async () => { }),
        reconcileGeneration: vitest_1.vi.fn(async () => ({
            acceptedRunIds: [],
            closedRunIds: [],
            reportAgain: false,
        })),
        withReconciledSocket: vitest_1.vi.fn(async (_c, _s, op) => op()),
        disconnectGeneration: vitest_1.vi.fn(async () => true),
    }, service, broker, {
        onClientRegistered: vitest_1.vi.fn(),
        onUpdateReady: vitest_1.vi.fn(),
        onUpdateFailed: vitest_1.vi.fn(),
    }, { bindEmitters: vitest_1.vi.fn() });
    gateway.afterInit();
    // 覆盖 terminal broker emitter → fake client（模拟 /client socket 发送）
    broker.bindEmitter((socketId, request) => {
        void fakeClient.broker
            .request({ clientId: "c1", socketId }, request)
            .then((response) => {
            void gateway.handleTerminalResponse({ id: socketId, data: { clientId: "c1" } }, response);
        });
    });
    return { memory, service, broker, gateway, fakeClient, browserEmits };
}
async function registerClient(h) {
    await h.gateway.handleRegister({ id: "client-sock-1", data: {}, join: vitest_1.vi.fn(), emit: vitest_1.vi.fn() }, {
        clientId: "c1",
        hostname: "host",
        os: "win32",
        cpuModel: "cpu",
        totalMemMB: 1024,
        clientVersion: "1",
        capabilities: ["terminal.pty"],
        capabilityDetails: {},
    });
    h.memory.clients.set("c1", {
        id: "c1",
        socketId: "client-sock-1",
        online: true,
    });
    h.fakeClient.bindClientSocket("client-sock-1");
    // Client 注册后上报状态对账
    await h.service.handleClientState("c1", "client-sock-1", {
        clientId: "c1",
        generationId: "g1",
        sessions: [],
    });
}
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
(0, vitest_1.describe)("终端端到端回路", () => {
    (0, vitest_1.it)("创建 → attach → 输入 → PTY 回显 → 浏览器收到 snapshot + output", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 100, rows: 40 }, ACTOR);
        (0, vitest_1.expect)(created.status).toBe("detached");
        (0, vitest_1.expect)(h.memory.sessions.get(created.sessionId)?.shellId).toBe("bash");
        const attached = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "browser-1",
        });
        (0, vitest_1.expect)(attached.mode).toBe("operator");
        await h.service.whenAttachSettled(created.sessionId);
        const snap = h.browserEmits.find((e) => e.event === shared_1.Events.TERMINAL_SNAPSHOT);
        (0, vitest_1.expect)(snap?.payload).toMatchObject({
            sessionId: created.sessionId,
            snapshot: `SNAP:${created.sessionId}`,
        });
        await h.service.browserInput({
            socketId: "browser-1",
            sessionId: created.sessionId,
            attachmentId: attached.attachmentId,
            data: "ls\r",
        });
        (0, vitest_1.expect)(h.fakeClient.receivedInput).toEqual([
            { sessionId: created.sessionId, data: "ls\r" },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const outputs = h.browserEmits.filter((e) => e.event === shared_1.Events.TERMINAL_OUTPUT);
        (0, vitest_1.expect)(outputs.map((o) => o.payload.data)).toEqual([
            "echo:ls\r",
        ]);
        (0, vitest_1.expect)(outputs[0]?.payload).toMatchObject({ seq: 1 });
    });
    (0, vitest_1.it)("第二浏览器只读：伪造 input 被拒绝且不达 Client", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        const viewer = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: { ...ACTOR, identityId: "id2" },
            socketId: "b2",
        });
        await (0, vitest_1.expect)(h.service.browserInput({
            socketId: "b2",
            sessionId: created.sessionId,
            attachmentId: viewer.attachmentId,
            data: "rm -rf /",
        })).rejects.toMatchObject({ code: "TERMINAL_READ_ONLY" });
        (0, vitest_1.expect)(h.fakeClient.receivedInput).toHaveLength(0);
    });
    (0, vitest_1.it)("同一 socket 重复 attach：旧 attachment 被取代，新 attach 仍为 operator", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const first = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        // StrictMode 双挂载：同一 socket 再次 attach
        const second = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        (0, vitest_1.expect)(second.mode).toBe("operator");
        // 旧 attachment 已失效：输入被拒绝；新 attachment 可写
        await (0, vitest_1.expect)(h.service.browserInput({
            socketId: "b1",
            sessionId: created.sessionId,
            attachmentId: first.attachmentId,
            data: "x\r",
        })).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
        await h.service.browserInput({
            socketId: "b1",
            sessionId: created.sessionId,
            attachmentId: second.attachmentId,
            data: "ls\r",
        });
        (0, vitest_1.expect)(h.fakeClient.receivedInput).toHaveLength(1);
    });
    (0, vitest_1.it)("operator 断开后 token 重绑恢复操作权", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const first = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.detachBrowserSocket("b1");
        const rebind = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b2",
            reconnectToken: first.reconnectToken,
        });
        (0, vitest_1.expect)(rebind.mode).toBe("operator");
        await h.service.browserInput({
            socketId: "b2",
            sessionId: created.sessionId,
            attachmentId: rebind.attachmentId,
            data: "pwd\r",
        });
        (0, vitest_1.expect)(h.fakeClient.receivedInput).toHaveLength(1);
    });
    (0, vitest_1.it)("保护期后 viewer 接管成功", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.detachBrowserSocket("b1");
        const viewer = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: { ...ACTOR, identityId: "id2" },
            socketId: "b2",
        });
        await (0, vitest_1.expect)(h.service.browserTakeover({
            socketId: "b2",
            sessionId: created.sessionId,
            attachmentId: viewer.attachmentId,
        })).rejects.toMatchObject({ code: "TERMINAL_CONTROL_PROTECTED" });
        // 拨快服务时钟（30 秒保护期）
        const svc = h.service;
        const originalNow = svc.now;
        let clock = Date.now();
        svc.now = () => clock;
        clock += shared_1.TerminalLimits.reconnectGraceMs + 1;
        const winner = await h.service.browserTakeover({
            socketId: "b2",
            sessionId: created.sessionId,
            attachmentId: viewer.attachmentId,
        });
        (0, vitest_1.expect)(winner.mode).toBe("operator");
        svc.now = originalNow;
    });
    (0, vitest_1.it)("Client 重启对账：旧会话 interrupted，孤儿 closeSessionIds", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const ack = await h.service.handleClientState("c1", "client-sock-2", {
            clientId: "c1",
            generationId: "g2",
            sessions: [],
        });
        (0, vitest_1.expect)(ack.acceptedSessionIds).toEqual([]);
        (0, vitest_1.expect)(h.memory.sessions.get(created.sessionId)?.status).toBe("interrupted");
        (0, vitest_1.expect)(h.memory.sessions.get(created.sessionId)?.endReason).toBe("TERMINAL_CLIENT_RESTARTED");
        const ack2 = await h.service.handleClientState("c1", "client-sock-2", {
            clientId: "c1",
            generationId: "g2",
            sessions: [
                {
                    sessionId: "ts_orphan",
                    shellId: "bash",
                    status: "active",
                    cols: 80,
                    rows: 24,
                    lastSeq: 0,
                },
            ],
        });
        (0, vitest_1.expect)(ack2.closeSessionIds).toEqual(["ts_orphan"]);
    });
    (0, vitest_1.it)("安全 canary：输入/路径/token 不进入 DB 与审计", async () => {
        const h = makeHarness();
        await registerClient(h);
        const created = await h.service.createSession("c1", { shellId: "bash", cols: 80, rows: 24 }, ACTOR);
        const attached = await h.service.attachBrowser({
            sessionId: created.sessionId,
            actor: ACTOR,
            socketId: "b1",
        });
        await h.service.browserInput({
            socketId: "b1",
            sessionId: created.sessionId,
            attachmentId: attached.attachmentId,
            data: "SECRET_INPUT_7f3a",
        });
        const dbJson = JSON.stringify([...h.memory.sessions.values()]);
        (0, vitest_1.expect)(dbJson).not.toContain("SECRET_INPUT_7f3a");
        (0, vitest_1.expect)(dbJson).not.toContain("/home/");
        (0, vitest_1.expect)(dbJson).not.toContain(attached.reconnectToken);
        (0, vitest_1.expect)(JSON.stringify(h.memory.audits)).not.toContain("SECRET_INPUT_7f3a");
        (0, vitest_1.expect)(JSON.stringify(h.memory.audits)).not.toContain(attached.reconnectToken);
    });
});
