"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const machine_register_js_1 = require("./machine-register.js");
/** 构造一份合法的新 Client 注册消息（含 ADR-0023 新增字段）。 */
function validRegister(overrides = {}) {
    const base = {
        clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
        hostname: "xuzhen97-bazzite",
        os: "linux 6.11.0",
        cpuModel: "AMD Ryzen 7 5800X",
        totalMemMB: 32000,
        clientVersion: "0.6.15",
        capabilities: ["exec", "file.read", "file.write"],
        capabilityDetails: {
            frp: { available: true, reconcileProtocolVersion: 1 },
            privileged: {
                available: true,
                mode: "sudo-all",
                nonInteractive: true,
                runAsUser: "vcpdeck",
            },
        },
        installation: { mode: "systemd-root-equivalent" },
    };
    return { ...base, ...overrides };
}
(0, vitest_1.describe)("parseMachineRegister", () => {
    (0, vitest_1.it)("接受含 privileged + installation 的新 Client 注册", () => {
        const parsed = (0, machine_register_js_1.parseMachineRegister)(validRegister());
        (0, vitest_1.expect)(parsed.installation).toEqual({ mode: "systemd-root-equivalent" });
        (0, vitest_1.expect)(parsed.capabilityDetails?.privileged).toMatchObject({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
        });
    });
    (0, vitest_1.it)("接受不含新增字段的旧 Client 注册（缺省即未报告）", () => {
        const parsed = (0, machine_register_js_1.parseMachineRegister)(validRegister({ capabilityDetails: { frp: { available: false, code: "FRPC_NOT_FOUND" } }, installation: undefined }));
        (0, vitest_1.expect)(parsed.installation).toBeUndefined();
        (0, vitest_1.expect)(parsed.capabilityDetails?.privileged).toBeUndefined();
        (0, vitest_1.expect)(parsed.capabilityDetails?.frp).toEqual({ available: false, code: "FRPC_NOT_FOUND" });
    });
    (0, vitest_1.it)("拒绝 capabilityDetails 中的未知字段", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({
            capabilityDetails: {
                frp: { available: false, code: "FRPC_NOT_FOUND" },
                unknown: true,
            },
        }))).toThrow();
    });
    (0, vitest_1.it)("拒绝 capabilityDetails 不是对象", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({
            capabilityDetails: ["frp"],
        }))).toThrow();
    });
    (0, vitest_1.it)("拒绝 privileged 非法 mode", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({
            capabilityDetails: {
                privileged: {
                    available: true,
                    mode: "root",
                    nonInteractive: true,
                    runAsUser: "vcpdeck",
                },
            },
        }))).toThrow();
    });
    (0, vitest_1.it)("拒绝 privileged 非布尔 nonInteractive / 缺失 runAsUser / 超长 runAsUser", () => {
        const bad = [
            { available: true, mode: "sudo-all", nonInteractive: "yes", runAsUser: "vcpdeck" },
            { available: true, mode: "sudo-all", nonInteractive: true },
            { available: true, mode: "sudo-all", nonInteractive: true, runAsUser: "x".repeat(257) },
            { available: false, mode: "unavailable" },
        ];
        for (const privileged of bad) {
            (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)({
                ...validRegister(),
                capabilityDetails: { privileged: privileged },
            })).toThrow();
        }
    });
    (0, vitest_1.it)("拒绝 installation 非法 mode 或非对象", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ installation: { mode: "pm2" } }))).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ installation: "systemd" }))).toThrow();
    });
    (0, vitest_1.it)("拒绝核心字段类型错误：clientId 非字符串 / totalMemMB 非数字 / capabilities 非数组", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ clientId: 0 }))).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ totalMemMB: "32000" }))).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ capabilities: "exec" }))).toThrow();
    });
    (0, vitest_1.it)("拒绝 capabilities 超长条目与超量数组", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ capabilities: ["x".repeat(65)] }))).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineRegister)(validRegister({ capabilities: Array.from({ length: 101 }, (_, i) => `cap${i}`) }))).toThrow();
    });
});
(0, vitest_1.describe)("parsePrivilegedCapabilityStatus", () => {
    (0, vitest_1.it)("接受 sudo-all 与 unavailable 两种合法形态", () => {
        (0, vitest_1.expect)((0, machine_register_js_1.parsePrivilegedCapabilityStatus)({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
        })).toMatchObject({ available: true, mode: "sudo-all" });
        (0, vitest_1.expect)((0, machine_register_js_1.parsePrivilegedCapabilityStatus)({
            available: false,
            mode: "unavailable",
            nonInteractive: false,
            runAsUser: "xuzhen97",
        })).toMatchObject({ available: false, mode: "unavailable" });
    });
    (0, vitest_1.it)("拒绝未知字段", () => {
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parsePrivilegedCapabilityStatus)({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
            extra: 1,
        })).toThrow();
    });
});
(0, vitest_1.describe)("parseMachineInstallation", () => {
    (0, vitest_1.it)("接受 systemd-root-equivalent 并拒绝其他取值", () => {
        (0, vitest_1.expect)((0, machine_register_js_1.parseMachineInstallation)({ mode: "systemd-root-equivalent" })).toEqual({
            mode: "systemd-root-equivalent",
        });
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineInstallation)({ mode: "pm2" })).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineInstallation)({})).toThrow();
        (0, vitest_1.expect)(() => (0, machine_register_js_1.parseMachineInstallation)(null)).toThrow();
    });
});
