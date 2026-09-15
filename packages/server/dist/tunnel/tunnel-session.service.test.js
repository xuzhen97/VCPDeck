"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const tunnel_session_service_js_1 = require("./tunnel-session.service.js");
const ACTOR = {
    identityId: "op-1",
    displayName: "op",
    isAdmin: true,
    credentialId: null,
    sessionId: null,
    source: "web",
    requestId: "r1",
};
const OTHER_ACTOR = { ...ACTOR, identityId: "op-2" };
function make() {
    const findUnique = vitest_1.vi.fn(async () => ({
        id: "c1",
        online: true,
        socketId: "client-socket",
        capabilityDetails: JSON.stringify({ p2pTunnel: { available: true, protocolVersion: 1 } }),
    }));
    const prisma = { client: { findUnique } };
    const config = {
        issueIceServers: vitest_1.vi.fn(async () => [{ urls: ["stun:turn.example.com:3478"] }]),
    };
    const sendClient = vitest_1.vi.fn();
    const sendBrowser = vitest_1.vi.fn();
    const service = new tunnel_session_service_js_1.TunnelSessionService(config, prisma);
    service.bindClientSender(sendClient);
    service.bindBrowserSender(sendBrowser);
    return { service, findUnique, config, sendClient, sendBrowser, prisma };
}
(0, vitest_1.describe)("TunnelSessionService", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("把 offer 转发到创建时绑定的 Client lease，并向其下发 prepare", async () => {
        const { service, sendClient } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
        (0, vitest_1.expect)(sendClient).toHaveBeenCalledWith("client-socket", shared_1.Events.TUNNEL_PREPARE, vitest_1.expect.objectContaining({ sessionId: created.sessionId, targetPort: 3000 }));
        await service.signalFromBrowser("browser-socket", {
            sessionId: created.sessionId,
            description: { type: "offer", sdp: "v=0\r\n" },
        });
        (0, vitest_1.expect)(sendClient).toHaveBeenCalledWith("client-socket", shared_1.Events.TUNNEL_SIGNAL, vitest_1.expect.objectContaining({ sessionId: created.sessionId }));
    });
    (0, vitest_1.it)("拒绝其他 Browser socket、其他 Client 和 answer 方向伪造", async () => {
        const { service } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
        const offer = { sessionId: created.sessionId, description: { type: "offer", sdp: "v=0" } };
        const answer = { sessionId: created.sessionId, description: { type: "answer", sdp: "v=0" } };
        await (0, vitest_1.expect)(service.signalFromBrowser("other-browser", offer)).rejects.toMatchObject({ code: "TUNNEL_FORBIDDEN" });
        await (0, vitest_1.expect)(service.signalFromClient("other-client-socket", answer)).rejects.toMatchObject({ code: "TUNNEL_FORBIDDEN" });
        await (0, vitest_1.expect)(service.signalFromBrowser("browser-socket", answer)).rejects.toMatchObject({ code: "TUNNEL_SIGNAL_INVALID" });
    });
    (0, vitest_1.it)("只把 Client answer 转发给已绑定 Browser", async () => {
        const { service, sendBrowser } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
        await service.signalFromClient("client-socket", {
            sessionId: created.sessionId,
            description: { type: "answer", sdp: "v=0" },
        });
        (0, vitest_1.expect)(sendBrowser).toHaveBeenCalledWith("browser-socket", shared_1.Events.TUNNEL_SIGNAL, vitest_1.expect.objectContaining({ sessionId: created.sessionId }));
    });
    (0, vitest_1.it)("Client failed 状态先通知 Browser 再释放 Session", async () => {
        const { service, sendBrowser } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
        await service.clientState("client-socket", {
            sessionId: created.sessionId,
            state: "failed",
            code: "TUNNEL_TARGET_REFUSED",
        });
        (0, vitest_1.expect)(sendBrowser).toHaveBeenCalledWith("browser-socket", shared_1.Events.TUNNEL_STATE, vitest_1.expect.objectContaining({ state: "failed" }));
        (0, vitest_1.expect)(service.has(created.sessionId)).toBe(false);
    });
    (0, vitest_1.it)("60 秒未 attach 的 Session 被 sweep 释放，close 幂等", async () => {
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
        const { service, sendClient } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        service.onModuleInit();
        vitest_1.vi.advanceTimersByTime(60_001);
        (0, vitest_1.expect)(service.has(created.sessionId)).toBe(false);
        await (0, vitest_1.expect)(service.close(created.sessionId, ACTOR)).resolves.toEqual({ closed: true });
        // 释放时向 client lease 发送 close
        (0, vitest_1.expect)(sendClient).toHaveBeenCalledWith("client-socket", shared_1.Events.TUNNEL_CLOSE, {
            sessionId: created.sessionId,
        });
    });
    (0, vitest_1.it)("Client 离线 / 无 p2pTunnel 能力时创建失败", async () => {
        const { service, findUnique } = make();
        findUnique.mockResolvedValueOnce({ id: "c1", online: false, socketId: null, capabilityDetails: "{}" });
        await (0, vitest_1.expect)(service.create({ clientId: "c1", targetPort: 3000 }, ACTOR)).rejects.toMatchObject({
            code: "TUNNEL_CLIENT_UNAVAILABLE",
        });
        findUnique.mockResolvedValueOnce({ id: "c1", online: true, socketId: "s", capabilityDetails: "{}" });
        await (0, vitest_1.expect)(service.create({ clientId: "c1", targetPort: 3000 }, ACTOR)).rejects.toMatchObject({
            code: "TUNNEL_CLIENT_UNSUPPORTED",
        });
    });
    (0, vitest_1.it)("close 只对创建者生效，非创建者被拒绝", async () => {
        const { service } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await (0, vitest_1.expect)(service.close(created.sessionId, OTHER_ACTOR)).rejects.toBeInstanceOf(tunnel_session_service_js_1.TunnelSessionError);
        (0, vitest_1.expect)(service.has(created.sessionId)).toBe(true);
        await (0, vitest_1.expect)(service.close(created.sessionId, ACTOR)).resolves.toEqual({ closed: true });
    });
    (0, vitest_1.it)("Browser / Client 断线只释放匹配 lease 的 Session", async () => {
        const { service } = make();
        const created = await service.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        await service.attachBrowser(created.sessionId, ACTOR, "browser-socket");
        service.disconnectBrowser("unrelated");
        (0, vitest_1.expect)(service.has(created.sessionId)).toBe(true);
        service.disconnectClient("c1", "client-socket");
        (0, vitest_1.expect)(service.has(created.sessionId)).toBe(false);
    });
});
