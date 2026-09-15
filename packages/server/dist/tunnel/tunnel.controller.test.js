"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const common_1 = require("@nestjs/common");
const tunnel_controller_js_1 = require("./tunnel.controller.js");
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
function make(overrides = {}) {
    const config = {
        get: vitest_1.vi.fn(async () => ({
            stunUrls: ["stun:turn.example.com:3478"],
            turnUrls: ["turn:turn.example.com:3478"],
            realm: "turn.example.com",
            turnSecretConfigured: true,
            updatedAt: null,
        })),
        update: vitest_1.vi.fn(),
        ...overrides.config,
    };
    const sessions = {
        create: vitest_1.vi.fn(async () => ({
            sessionId: "tn_1",
            clientId: "c1",
            targetPort: 3000,
            attachDeadline: "2026-09-11T00:01:00.000Z",
            iceServers: [{ urls: ["stun:turn.example.com:3478"] }],
        })),
        close: vitest_1.vi.fn(async () => ({ closed: true })),
        ...overrides.sessions,
    };
    const controller = new tunnel_controller_js_1.TunnelController(config, sessions);
    return { controller, config, sessions };
}
(0, vitest_1.describe)("TunnelController", () => {
    (0, vitest_1.it)("GET config 返回脱敏摘要，不含 secret 内容", async () => {
        const { controller } = make();
        const info = await controller.getConfig();
        (0, vitest_1.expect)(info.turnSecretConfigured).toBe(true);
        (0, vitest_1.expect)(JSON.stringify(info)).not.toContain("shared-secret");
    });
    (0, vitest_1.it)("POST create 委托 service 并透传 actor", async () => {
        const { controller, sessions } = make();
        await controller.create({ clientId: "c1", targetPort: 3000 }, ACTOR);
        (0, vitest_1.expect)(sessions.create).toHaveBeenCalledWith({ clientId: "c1", targetPort: 3000 }, ACTOR);
    });
    (0, vitest_1.it)("DELETE close 委托 service 并透传 actor", async () => {
        const { controller, sessions } = make();
        await controller.close("tn_1", ACTOR);
        (0, vitest_1.expect)(sessions.close).toHaveBeenCalledWith("tn_1", ACTOR);
    });
    (0, vitest_1.it)("domain 错误映射为带稳定 code 的 HttpException（409 不支持）", async () => {
        const { controller } = make({
            sessions: {
                create: vitest_1.vi.fn(async () => {
                    throw new tunnel_session_service_js_1.TunnelSessionError("TUNNEL_CLIENT_UNSUPPORTED", "目标 Client 不支持", 409);
                }),
                close: vitest_1.vi.fn(),
            },
        });
        const err = await controller.create({ clientId: "c1", targetPort: 3000 }, ACTOR).catch((e) => e);
        (0, vitest_1.expect)(err).toBeInstanceOf(common_1.HttpException);
        (0, vitest_1.expect)(err.getStatus()).toBe(409);
        (0, vitest_1.expect)(err.getResponse()).toMatchObject({ code: "TUNNEL_CLIENT_UNSUPPORTED" });
    });
    (0, vitest_1.it)("非法请求体映射为 400 TUNNEL_REQUEST_INVALID", async () => {
        const { controller } = make({
            config: {
                get: vitest_1.vi.fn(),
                update: vitest_1.vi.fn(async () => {
                    throw new Error("boom");
                }),
            },
        });
        const err = await controller.updateConfig({ stunUrls: [], turnUrls: [], realm: "x", extra: 1 }).catch((e) => e);
        (0, vitest_1.expect)(err).toBeInstanceOf(common_1.HttpException);
        (0, vitest_1.expect)(err.getStatus()).toBe(400);
        (0, vitest_1.expect)(err.getResponse()).toMatchObject({ code: "TUNNEL_REQUEST_INVALID" });
    });
    (0, vitest_1.it)("HttpException 原样透传", async () => {
        const original = new common_1.HttpException({ code: "AUTH_REQUIRED" }, 401);
        const { controller } = make({
            sessions: {
                create: vitest_1.vi.fn(async () => {
                    throw original;
                }),
                close: vitest_1.vi.fn(),
            },
        });
        await (0, vitest_1.expect)(controller.create({}, ACTOR)).rejects.toBe(original);
    });
});
