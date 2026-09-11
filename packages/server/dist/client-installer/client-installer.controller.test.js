"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_installer_controller_js_1 = require("./client-installer.controller.js");
const client_installer_service_js_1 = require("./client-installer.service.js");
const actor = {
    identityId: "identity-1",
    displayName: "Operator",
    isAdmin: false,
    credentialId: null,
    sessionId: "session-1",
    source: "web",
    requestId: "request-1",
};
function service() {
    return {
        getConfig: vitest_1.vi.fn(async () => ({ enabled: false })),
        updateConfig: vitest_1.vi.fn(async (enabled) => ({ enabled })),
        readAsset: vitest_1.vi.fn(() => Buffer.from("echo installer")),
        preflight: vitest_1.vi.fn(async () => ({ platform: "linux-x64" })),
        bootstrap: vitest_1.vi.fn(async () => ({ psk: "secret" })),
        assertPsk: vitest_1.vi.fn((value) => {
            if (value !== "secret") {
                throw new client_installer_service_js_1.ClientInstallerError("CLIENT_INSTALLER_PSK_INVALID", "Client 安装凭据无效", 401);
            }
        }),
        getClientStatus: vitest_1.vi.fn(async () => ({ registered: true })),
        renameClient: vitest_1.vi.fn(),
    };
}
function response(psk) {
    return {
        req: { header: vitest_1.vi.fn(() => psk) },
        type: vitest_1.vi.fn().mockReturnThis(),
        send: vitest_1.vi.fn().mockReturnThis(),
    };
}
(0, vitest_1.describe)("ClientInstallerController", () => {
    (0, vitest_1.it)("普通已登录操作者可以更新开关", async () => {
        const mock = service();
        const controller = new client_installer_controller_js_1.ClientInstallerController(mock);
        await controller.updateConfig({ enabled: true }, actor);
        (0, vitest_1.expect)(mock.updateConfig).toHaveBeenCalledWith(true, actor);
    });
    (0, vitest_1.it)("bootstrap 严格拒绝未知字段", async () => {
        const controller = new client_installer_controller_js_1.ClientInstallerController(service());
        (0, vitest_1.expect)(() => controller.bootstrap({ platform: "linux-x64", extra: true })).toThrowError(vitest_1.expect.objectContaining({ status: 400 }));
    });
    (0, vitest_1.it)("安装状态使用 header PSK 并稳定映射 401", async () => {
        const controller = new client_installer_controller_js_1.ClientInstallerController(service());
        (0, vitest_1.expect)(() => controller.getClientStatus("client-1", undefined, response())).toThrowError(vitest_1.expect.objectContaining({ status: 401 }));
    });
    (0, vitest_1.it)("拒绝通过 query 传递 PSK", () => {
        const controller = new client_installer_controller_js_1.ClientInstallerController(service());
        (0, vitest_1.expect)(() => controller.getClientStatus("client-1", "secret", response("secret"))).toThrowError(vitest_1.expect.objectContaining({ status: 400 }));
    });
    (0, vitest_1.it)("公开脚本响应不包含 PSK", () => {
        const mock = service();
        const controller = new client_installer_controller_js_1.ClientInstallerController(mock);
        const res = response();
        controller.getScript("linux-x64", res);
        (0, vitest_1.expect)(res.send).toHaveBeenCalledWith(Buffer.from("echo installer"));
        (0, vitest_1.expect)(String(res.send.mock.calls[0]?.[0])).not.toContain("secret");
    });
    (0, vitest_1.it)("公开卸载资产可以读取", () => {
        const mock = service();
        const controller = new client_installer_controller_js_1.ClientInstallerController(mock);
        const res = response();
        controller.getAsset("uninstall-client.cjs", res);
        (0, vitest_1.expect)(mock.readAsset).toHaveBeenCalledWith("uninstall-client.cjs");
        (0, vitest_1.expect)(res.send).toHaveBeenCalledWith(Buffer.from("echo installer"));
    });
});
