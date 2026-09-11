"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const client_installer_service_js_1 = require("./client-installer.service.js");
function release(status = shared_1.ReleaseStatus.DONE) {
    const archives = {
        "win-x64": { sha256: "a".repeat(64), size: 10, fileName: "win.zip" },
        "linux-x64": { sha256: "b".repeat(64), size: 20, fileName: "linux.zip" },
    };
    return {
        version: shared_1.VERSION,
        status,
        archives,
        clientStates: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}
function mocks(enabled = false) {
    const rows = [
        {
            enabled: enabled ? 1 : 0,
            updatedAt: new Date("2026-08-20T00:00:00Z"),
            updatedByName: null,
            updatedVia: null,
        },
    ];
    return {
        prisma: {
            $executeRawUnsafe: vitest_1.vi.fn(async () => 1),
            $queryRawUnsafe: vitest_1.vi.fn(async () => rows),
        },
        releases: { findByVersion: vitest_1.vi.fn(async () => release()) },
        clients: {
            getInstallerStatus: vitest_1.vi.fn(async () => ({ registered: true, online: true })),
            rename: vitest_1.vi.fn(),
        },
    };
}
(0, vitest_1.describe)("ClientInstallerService", () => {
    (0, vitest_1.beforeEach)(() => {
        process.env.VCPDECK_PSK = "test-shared-psk";
    });
    (0, vitest_1.it)("默认关闭但展示同版本平台 readiness", async () => {
        const { prisma, releases, clients } = mocks(false);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        const config = await service.getConfig();
        (0, vitest_1.expect)(config.enabled).toBe(false);
        (0, vitest_1.expect)(releases.findByVersion).toHaveBeenCalledWith(shared_1.VERSION);
        (0, vitest_1.expect)(config.platforms["win-x64"].available).toBe(true);
    });
    (0, vitest_1.it)("关闭时 bootstrap fail closed 且不返回 PSK", async () => {
        const { prisma, releases, clients } = mocks(false);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        await (0, vitest_1.expect)(service.bootstrap("linux-x64")).rejects.toMatchObject({
            code: "CLIENT_INSTALLER_DISABLED",
            statusCode: 403,
        });
    });
    (0, vitest_1.it)("启用时只返回当前 Server 同版本 done Release", async () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        const result = await service.bootstrap("win-x64");
        (0, vitest_1.expect)(result).toMatchObject({
            serverVersion: shared_1.VERSION,
            releaseVersion: shared_1.VERSION,
            platform: "win-x64",
            psk: "test-shared-psk",
        });
    });
    (0, vitest_1.it)("Release 未完成或平台缺包时拒绝", async () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        releases.findByVersion.mockResolvedValueOnce(release(shared_1.ReleaseStatus.UPLOADED));
        await (0, vitest_1.expect)(service.bootstrap("win-x64")).rejects.toBeInstanceOf(client_installer_service_js_1.ClientInstallerError);
        releases.findByVersion.mockResolvedValueOnce({ ...release(), archives: {} });
        await (0, vitest_1.expect)(service.bootstrap("win-x64")).rejects.toMatchObject({
            code: "CLIENT_INSTALLER_ARCHIVE_MISSING",
        });
    });
    (0, vitest_1.it)("cleaned archive 不再被视为可安装构件", async () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        releases.findByVersion.mockResolvedValueOnce({
            ...release(),
            archives: {
                ...release().archives,
                "win-x64": {
                    sha256: "a".repeat(64),
                    size: 10,
                    fileName: "win.zip",
                    availability: "cleaned",
                    cleanedAt: "2026-08-29T00:00:00.000Z",
                    cleanupReason: "retention_policy",
                },
            },
        });
        await (0, vitest_1.expect)(service.bootstrap("win-x64")).rejects.toMatchObject({
            code: "CLIENT_INSTALLER_ARCHIVE_MISSING",
        });
    });
    (0, vitest_1.it)("公开 Shell 安装资产统一使用 LF", () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        for (const name of [
            "install-client-bootstrap.sh",
            "uninstall-client-bootstrap.sh",
        ]) {
            (0, vitest_1.expect)(service.readAsset(name).includes(0x0d)).toBe(false);
        }
    });
    (0, vitest_1.it)("preflight 按平台路由安装器资产：linux-x64 走 A2 系统安装器，win-x64 保持 PM2 安装器", async () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        const linux = await service.preflight("linux-x64");
        (0, vitest_1.expect)(linux.installerUrl).toBe("/api/client-installer/assets/install-client-linux.cjs");
        const win = await service.preflight("win-x64");
        (0, vitest_1.expect)(win.installerUrl).toBe("/api/client-installer/assets/install-client.cjs");
        // 低层安装器两平台一致。
        (0, vitest_1.expect)(linux.lowLevelInstallerUrl).toBe("/api/client-installer/assets/install.cjs");
        (0, vitest_1.expect)(win.lowLevelInstallerUrl).toBe("/api/client-installer/assets/install.cjs");
    });
    (0, vitest_1.it)("验收接口要求正确共享 PSK", () => {
        const { prisma, releases, clients } = mocks(true);
        const service = new client_installer_service_js_1.ClientInstallerService(prisma, releases, clients);
        (0, vitest_1.expect)(() => service.assertPsk("wrong")).toThrowError(client_installer_service_js_1.ClientInstallerError);
        (0, vitest_1.expect)(() => service.assertPsk("test-shared-psk")).not.toThrow();
    });
});
