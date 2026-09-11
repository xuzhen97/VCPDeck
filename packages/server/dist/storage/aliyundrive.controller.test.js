"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const aliyundrive_controller_js_1 = require("./aliyundrive.controller.js");
function mockPrisma() {
    return {
        storageBackendConfig: {
            findFirst: vitest_1.vi.fn(),
            upsert: vitest_1.vi.fn(),
        },
    };
}
function makeStorage() {
    return { reload: vitest_1.vi.fn() };
}
(0, vitest_1.describe)("AliyunDriveController.verify", () => {
    let prisma;
    let controller;
    let storage;
    (0, vitest_1.beforeEach)(() => {
        prisma = mockPrisma();
        storage = makeStorage();
        controller = new aliyundrive_controller_js_1.AliyunDriveController(prisma, storage);
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.unstubAllGlobals();
    });
    (0, vitest_1.it)("verifies a live token through getDriveInfo without exposing secrets", async () => {
        prisma.storageBackendConfig.findFirst.mockResolvedValue({
            kind: "alibaba",
            config: JSON.stringify({
                clientId: "app-id",
                accessToken: "access-token",
                expiresAt: Date.now() + 3_600_000,
            }),
        });
        const fetcher = vitest_1.vi
            .fn()
            .mockResolvedValue(Response.json({ default_drive_id: "drive-1" }));
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const result = await controller.verify();
        (0, vitest_1.expect)(result).toMatchObject({ valid: true, driveId: "drive-1" });
        (0, vitest_1.expect)(result.checkedAt).toEqual(vitest_1.expect.any(String));
        (0, vitest_1.expect)(fetcher).toHaveBeenCalledWith("https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo", vitest_1.expect.objectContaining({
            method: "POST",
            headers: vitest_1.expect.objectContaining({
                Authorization: "Bearer access-token",
            }),
        }));
        (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("access-token");
        (0, vitest_1.expect)(prisma.storageBackendConfig.upsert).toHaveBeenCalled();
        (0, vitest_1.expect)(storage.reload).toHaveBeenCalled();
    });
    (0, vitest_1.it)("reports revoked when the OpenAPI token is rejected", async () => {
        prisma.storageBackendConfig.findFirst.mockResolvedValue({
            kind: "alibaba",
            config: JSON.stringify({
                clientId: "app-id",
                accessToken: "revoked-token",
                expiresAt: Date.now() + 3_600_000,
            }),
        });
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockResolvedValue(new Response("invalid token", { status: 401 })));
        (0, vitest_1.expect)(await controller.verify()).toMatchObject({
            valid: false,
            reason: "revoked",
        });
    });
    (0, vitest_1.it)("refreshes a near-expiry token before verifying it", async () => {
        prisma.storageBackendConfig.findFirst.mockResolvedValue({
            kind: "alibaba",
            config: JSON.stringify({
                clientId: "app-id",
                clientSecret: "client-secret",
                accessToken: "old-token",
                refreshToken: "refresh-token",
                expiresAt: Date.now() + 60_000,
            }),
        });
        const fetcher = vitest_1.vi
            .fn()
            .mockResolvedValueOnce(Response.json({
            access_token: "new-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
        }))
            .mockResolvedValueOnce(Response.json({ default_drive_id: "drive-2" }));
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const result = await controller.verify();
        (0, vitest_1.expect)(result).toMatchObject({ valid: true, driveId: "drive-2" });
        (0, vitest_1.expect)(fetcher).toHaveBeenNthCalledWith(1, "https://openapi.alipan.com/oauth/access_token", vitest_1.expect.objectContaining({ method: "POST" }));
        (0, vitest_1.expect)(fetcher).toHaveBeenNthCalledWith(2, "https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo", vitest_1.expect.objectContaining({
            headers: vitest_1.expect.objectContaining({
                Authorization: "Bearer new-token",
            }),
        }));
        (0, vitest_1.expect)(storage.reload).toHaveBeenCalled();
    });
    (0, vitest_1.describe)("completeOAuth", () => {
        (0, vitest_1.it)("OAuth 成功后重新加载存储 provider 使内存 token 生效", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "alibaba",
                config: JSON.stringify({ clientId: "app-id" }),
            });
            const { state } = await controller.startOAuth();
            vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockResolvedValue(Response.json({
                access_token: "fresh-token",
                refresh_token: "fresh-refresh",
                expires_in: 3600,
            })));
            await controller.completeOAuth({ state, code: "auth-code" });
            (0, vitest_1.expect)(storage.reload).toHaveBeenCalled();
            (0, vitest_1.expect)(prisma.storageBackendConfig.upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                update: vitest_1.expect.objectContaining({
                    config: vitest_1.expect.stringContaining("fresh-token"),
                }),
            }));
        });
    });
    (0, vitest_1.describe)("saveConfig / revoke", () => {
        (0, vitest_1.it)("保存配置后同步内存 provider", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "alibaba",
                config: JSON.stringify({ clientId: "old-id" }),
            });
            await controller.saveConfig({ clientId: "new-id" });
            (0, vitest_1.expect)(storage.reload).toHaveBeenCalled();
        });
        (0, vitest_1.it)("撤销授权后同步内存 provider", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "alibaba",
                config: JSON.stringify({ clientId: "app-id", accessToken: "t" }),
            });
            await controller.revoke();
            (0, vitest_1.expect)(storage.reload).toHaveBeenCalled();
        });
    });
});
