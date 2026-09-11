"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_installer_js_1 = require("./client-installer.js");
(0, vitest_1.describe)("Client Installer parsers", () => {
    (0, vitest_1.it)("严格解析平台", () => {
        (0, vitest_1.expect)((0, client_installer_js_1.parseClientInstallerPlatform)("win-x64")).toBe("win-x64");
        (0, vitest_1.expect)(() => (0, client_installer_js_1.parseClientInstallerPlatform)("linux-arm64")).toThrow();
    });
    (0, vitest_1.it)("配置更新拒绝未知字段", () => {
        (0, vitest_1.expect)((0, client_installer_js_1.parseClientInstallerConfigUpdate)({ enabled: true })).toEqual({
            enabled: true,
        });
        (0, vitest_1.expect)(() => (0, client_installer_js_1.parseClientInstallerConfigUpdate)({ enabled: true, extra: 1 })).toThrow();
    });
    (0, vitest_1.it)("名称更新裁剪空白并限制长度", () => {
        (0, vitest_1.expect)((0, client_installer_js_1.parseClientInstallerNameUpdate)({ name: " build-1 " })).toEqual({
            name: "build-1",
        });
        (0, vitest_1.expect)(() => (0, client_installer_js_1.parseClientInstallerNameUpdate)({ name: "" })).toThrow();
    });
});
