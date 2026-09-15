"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_crypto_1 = require("node:crypto");
const tunnel_config_service_js_1 = require("./tunnel-config.service.js");
// 将 shared secret 文件读取 mock 化，避免依赖真实文件系统路径。
vitest_1.vi.mock("node:fs/promises", () => ({
    readFile: vitest_1.vi.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const promises_1 = require("node:fs/promises");
function configRow(overrides = {}) {
    return {
        id: "default",
        stunUrls: '["stun:turn.example.com:3478"]',
        turnUrls: '["turn:turn.example.com:3478?transport=udp"]',
        realm: "turn.example.com",
        updatedAt: new Date("2026-09-11T00:00:00.000Z"),
        ...overrides,
    };
}
function service() {
    const findUnique = vitest_1.vi.fn(async () => configRow());
    const prisma = {
        tunnelConfig: {
            findUnique,
            create: vitest_1.vi.fn(async () => configRow()),
        },
        $executeRawUnsafe: vitest_1.vi.fn(async () => 1),
    };
    return { service: new tunnel_config_service_js_1.TunnelConfigService(prisma), findUnique, prisma };
}
(0, vitest_1.describe)("TunnelConfigService", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        process.env.VCPDECK_TURN_SECRET_FILE = "/tmp/vcpdeck-turn-secret";
    });
    (0, vitest_1.it)("按 coturn TURN REST 算法签发 24h 凭据且 get() 不返回 shared secret", async () => {
        const now = new Date("2026-09-11T00:00:00.000Z");
        vitest_1.vi.mocked(promises_1.readFile).mockResolvedValue("shared-secret\n");
        const { service: svc } = service();
        const issued = await svc.issueIceServers("tn_123", now);
        const username = `${Math.floor(now.getTime() / 1000) + 86400}:tn_123`;
        const expected = (0, node_crypto_1.createHmac)("sha1", "shared-secret").update(username).digest("base64");
        (0, vitest_1.expect)(issued).toContainEqual({
            urls: ["turn:turn.example.com:3478?transport=udp"],
            username,
            credential: expected,
        });
        // STUN 无凭据。
        (0, vitest_1.expect)(issued).toContainEqual({ urls: ["stun:turn.example.com:3478"] });
        const info = await svc.get();
        (0, vitest_1.expect)(info.turnSecretConfigured).toBe(true);
        (0, vitest_1.expect)(JSON.stringify(info)).not.toContain("shared-secret");
    });
    vitest_1.it.each(["", "\n"])("空 TURN secret 时 issueIceServers 以稳定错误失败 %p", async (secret) => {
        vitest_1.vi.mocked(promises_1.readFile).mockResolvedValue(secret);
        const { service: svc } = service();
        await (0, vitest_1.expect)(svc.issueIceServers("tn_123")).rejects.toMatchObject({
            code: "TUNNEL_TURN_NOT_CONFIGURED",
        });
    });
    (0, vitest_1.it)("secret 文件缺失（读取抛错）时 issueIceServers 失败，get() 显示未配置", async () => {
        vitest_1.vi.mocked(promises_1.readFile).mockRejectedValue(new Error("ENOENT"));
        const { service: svc } = service();
        await (0, vitest_1.expect)(svc.issueIceServers("tn_123")).rejects.toBeInstanceOf(tunnel_config_service_js_1.TunnelConfigError);
        const info = await svc.get();
        (0, vitest_1.expect)(info.turnSecretConfigured).toBe(false);
    });
    (0, vitest_1.it)("env 未设置 VCPDECK_TURN_SECRET_FILE 时视为未配置", async () => {
        delete process.env.VCPDECK_TURN_SECRET_FILE;
        const { service: svc } = service();
        (0, vitest_1.expect)(await svc.get()).toMatchObject({ turnSecretConfigured: false });
    });
    (0, vitest_1.it)("配置 JSON 损坏时 get() 回退为空数组而非抛出", async () => {
        vitest_1.vi.mocked(promises_1.readFile).mockResolvedValue("shared-secret");
        const { service: svc, findUnique } = service();
        findUnique.mockResolvedValue(configRow({ stunUrls: "{not-json", turnUrls: "[]" }));
        const info = await svc.get();
        (0, vitest_1.expect)(info.stunUrls).toEqual([]);
    });
    (0, vitest_1.it)("update 拒绝 secret 字段并持久化非秘密配置", async () => {
        vitest_1.vi.mocked(promises_1.readFile).mockResolvedValue("shared-secret");
        const { service: svc } = service();
        await (0, vitest_1.expect)(svc.update({
            stunUrls: ["stun:turn.example.com:3478"],
            turnUrls: [],
            realm: "turn.example.com",
            secret: "should-reject",
        })).rejects.toThrow();
        const saved = await svc.update({
            stunUrls: ["stun:turn.example.com:3478"],
            turnUrls: ["turn:turn.example.com:3478?transport=udp"],
            realm: "turn.example.com",
        });
        (0, vitest_1.expect)(saved.realm).toBe("turn.example.com");
    });
});
