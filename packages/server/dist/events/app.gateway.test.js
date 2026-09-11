"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const app_gateway_js_1 = require("./app.gateway.js");
const ACTOR = { identityId: "id1", displayName: "admin", isAdmin: true, credentialId: null, sessionId: null, source: "web", requestId: "socket-1" };
function makeSocket(id = "socket-1") {
    const socket = {
        id,
        data: {},
        handshake: { headers: {} },
        emit: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
        join: vitest_1.vi.fn(),
    };
    socket.actor = ACTOR;
    return socket;
}
function makeGateway() {
    const prisma = {
        authSession: { findUnique: vitest_1.vi.fn() },
        credential: { findUnique: vitest_1.vi.fn() },
        identity: { findUnique: vitest_1.vi.fn() },
    };
    const terminalService = {
        attachBrowser: vitest_1.vi.fn(),
        detachBrowser: vitest_1.vi.fn(),
        detachBrowserSocket: vitest_1.vi.fn(),
        browserInput: vitest_1.vi.fn(),
        browserResize: vitest_1.vi.fn(),
        browserTakeover: vitest_1.vi.fn(),
        browserAckOutput: vitest_1.vi.fn(),
        browserResync: vitest_1.vi.fn(),
        bindBrowserEmitter: vitest_1.vi.fn(),
    };
    const gateway = new app_gateway_js_1.AppGateway(prisma, terminalService);
    const emit = vitest_1.vi.fn();
    const to = vitest_1.vi.fn(() => ({ emit }));
    gateway.server = { emit: vitest_1.vi.fn(), to };
    return { gateway, prisma, terminalService, to, emit };
}
(0, vitest_1.describe)("AppGateway terminal handlers", () => {
    (0, vitest_1.it)("afterInit 绑定浏览器 emitter 精确投递 socketId", () => {
        const { gateway, terminalService, to, emit } = makeGateway();
        gateway.afterInit();
        const binder = terminalService.bindBrowserEmitter.mock.calls[0]?.[0];
        (0, vitest_1.expect)(typeof binder).toBe("function");
        binder("browser-9", "terminal:output", { seq: 1 });
        (0, vitest_1.expect)(to).toHaveBeenCalledWith("browser-9");
        (0, vitest_1.expect)(emit).toHaveBeenCalledWith("terminal:output", { seq: 1 });
    });
    (0, vitest_1.it)("attach 透传 actor/socketId 并返回结果", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        terminalService.attachBrowser.mockResolvedValue({
            attachmentId: "ta1",
            reconnectToken: "tok1",
            mode: "operator",
            controlProtectedUntil: null,
        });
        const result = await gateway.handleTerminalAttach(socket, { sessionId: "s1", reconnectToken: "tok" });
        (0, vitest_1.expect)(terminalService.attachBrowser).toHaveBeenCalledWith({
            sessionId: "s1",
            actor: ACTOR,
            socketId: "socket-1",
            reconnectToken: "tok",
        });
        (0, vitest_1.expect)(result).toEqual({
            ok: true,
            data: { sessionId: "s1", attachmentId: "ta1", reconnectToken: "tok1", mode: "operator", controlProtectedUntil: null },
        });
    });
    (0, vitest_1.it)("attach 非法 payload 返回错误", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        const result = await gateway.handleTerminalAttach(socket, { reconnectToken: 42 });
        (0, vitest_1.expect)(terminalService.attachBrowser).not.toHaveBeenCalled();
        (0, vitest_1.expect)(result).toEqual({ ok: false, error: vitest_1.expect.objectContaining({ code: "TERMINAL_PROTOCOL_INVALID" }) });
    });
    (0, vitest_1.it)("service 错误转为安全返回", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        terminalService.attachBrowser.mockRejectedValue(Object.assign(new Error("x"), { code: "TERMINAL_SESSION_ENDED" }));
        const result = await gateway.handleTerminalAttach(socket, { sessionId: "s1" });
        (0, vitest_1.expect)(result).toEqual({ ok: false, error: { code: "TERMINAL_SESSION_ENDED", message: "x" } });
    });
    (0, vitest_1.it)("viewer 伪造 input 被 service 拒绝（无权限）", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        terminalService.browserInput.mockRejectedValue(Object.assign(new Error("readonly"), { code: "TERMINAL_READ_ONLY" }));
        const result = await gateway.handleTerminalInput(socket, { sessionId: "s1", attachmentId: "ta2", data: "rm -rf /" });
        (0, vitest_1.expect)(result).toEqual({ ok: false, error: { code: "TERMINAL_READ_ONLY", message: "readonly" } });
    });
    (0, vitest_1.it)("input/resize/takeover/ack/resync 都透传并返回", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        terminalService.browserResize.mockResolvedValue(undefined);
        terminalService.browserTakeover.mockResolvedValue({ mode: "operator" });
        (0, vitest_1.expect)(await gateway.handleTerminalResize(socket, { sessionId: "s1", attachmentId: "ta1", cols: 100, rows: 40 })).toEqual({ ok: true, data: undefined });
        (0, vitest_1.expect)(await gateway.handleTerminalTakeover(socket, { sessionId: "s1", attachmentId: "ta1" })).toEqual({ ok: true, data: { mode: "operator" } });
        (0, vitest_1.expect)(await gateway.handleTerminalAckOutput(socket, { sessionId: "s1", attachmentId: "ta1", seq: 9 })).toEqual({ ok: true, data: undefined });
        (0, vitest_1.expect)(await gateway.handleTerminalResync(socket, { sessionId: "s1", attachmentId: "ta1" })).toEqual({ ok: true, data: undefined });
    });
    (0, vitest_1.it)("detach 按 socketId 清理该 socket 全部 attachment", async () => {
        const { gateway, terminalService } = makeGateway();
        const socket = makeSocket();
        await gateway.handleDisconnect(socket);
        (0, vitest_1.expect)(terminalService.detachBrowserSocket).toHaveBeenCalledWith("socket-1");
    });
});
