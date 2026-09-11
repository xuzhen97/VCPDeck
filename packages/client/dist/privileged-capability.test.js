"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const privileged_capability_js_1 = require("./privileged-capability.js");
/** 构造可注入的特权探测环境（不触达真实 sudo / 系统账户）。 */
function makePrivilegedEnv(opts) {
    return {
        platform: opts.platform ?? "linux",
        currentUser: () => opts.username ?? "vcpdeck",
        runNonInteractiveSudo: async () => {
            if (opts.sudoThrows)
                throw new Error("spawn failed");
            return opts.sudoStatus ?? 1;
        },
    };
}
(0, vitest_1.describe)("probePrivilegedCapability", () => {
    (0, vitest_1.it)("Linux 免密 sudo 成功 → sudo-all 可用", async () => {
        (0, vitest_1.expect)(await (0, privileged_capability_js_1.probePrivilegedCapability)(makePrivilegedEnv({ sudoStatus: 0 }))).toEqual({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
        });
    });
    (0, vitest_1.it)("Linux 免密 sudo 失败 → unavailable（不声明 root 等价）", async () => {
        (0, vitest_1.expect)(await (0, privileged_capability_js_1.probePrivilegedCapability)(makePrivilegedEnv({ sudoStatus: 1 }))).toEqual({
            available: false,
            mode: "unavailable",
            nonInteractive: false,
            runAsUser: "vcpdeck",
        });
    });
    (0, vitest_1.it)("sudo 执行抛错 → unavailable（失败关闭）", async () => {
        (0, vitest_1.expect)(await (0, privileged_capability_js_1.probePrivilegedCapability)(makePrivilegedEnv({ sudoThrows: true }))).toEqual({
            available: false,
            mode: "unavailable",
            nonInteractive: false,
            runAsUser: "vcpdeck",
        });
    });
    (0, vitest_1.it)("非 Linux 返回 undefined（未报告，不探测 sudo）", async () => {
        (0, vitest_1.expect)(await (0, privileged_capability_js_1.probePrivilegedCapability)(makePrivilegedEnv({ platform: "win32", sudoStatus: 0 }))).toBeUndefined();
    });
    (0, vitest_1.it)("当前用户名缺失时回退 unknown，仍不泄露路径", async () => {
        const status = await (0, privileged_capability_js_1.probePrivilegedCapability)(makePrivilegedEnv({ username: "", sudoStatus: 0 }));
        (0, vitest_1.expect)(status?.runAsUser).toBe("unknown");
        (0, vitest_1.expect)(JSON.stringify(status)).not.toContain("C:\\");
    });
});
(0, vitest_1.describe)("detectInstallationInfo", () => {
    const linuxNoMode = { platform: "linux", installationMode: undefined };
    const linuxA2 = {
        platform: "linux",
        installationMode: "systemd-root-equivalent",
    };
    const win = { platform: "win32", installationMode: undefined };
    (0, vitest_1.it)("Linux 无 A2 模式变量 → legacy-pm2（待迁移）", () => {
        (0, vitest_1.expect)((0, privileged_capability_js_1.detectInstallationInfo)(linuxNoMode)).toEqual({ mode: "legacy-pm2" });
    });
    (0, vitest_1.it)("Linux A2 模式变量 → systemd-root-equivalent", () => {
        (0, vitest_1.expect)((0, privileged_capability_js_1.detectInstallationInfo)(linuxA2)).toEqual({ mode: "systemd-root-equivalent" });
    });
    (0, vitest_1.it)("Linux 未知模式变量 → 按 legacy-pm2 处理（不猜测 A2）", () => {
        (0, vitest_1.expect)((0, privileged_capability_js_1.detectInstallationInfo)({ platform: "linux", installationMode: "weird" })).toEqual({ mode: "legacy-pm2" });
    });
    (0, vitest_1.it)("Windows 未报告安装模式（保持原 PM2 语义）", () => {
        (0, vitest_1.expect)((0, privileged_capability_js_1.detectInstallationInfo)(win)).toBeUndefined();
    });
});
