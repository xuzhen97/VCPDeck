"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const register_js_1 = require("./register.js");
let root = "";
(0, vitest_1.beforeEach)(() => {
    // 提供假 frpc 可执行文件，使 isFrpAvailable() 可确定；
    // 固定 CLIENT_ID 避免 register 读写 ~/.vcpdeck/client-id。
    root = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-register-"));
    const executable = (0, node_path_1.join)(root, "frpc.exe");
    (0, node_fs_1.writeFileSync)(executable, "test");
    process.env.VCPDECK_FRPC_PATH = executable;
    process.env.VCPDECK_CLIENT_ID = "test-client";
});
(0, vitest_1.afterEach)(() => {
    delete process.env.VCPDECK_FRPC_PATH;
    delete process.env.VCPDECK_CLIENT_ID;
    (0, node_fs_1.rmSync)(root, { recursive: true, force: true });
});
(0, vitest_1.describe)("getRegisterInfo", () => {
    (0, vitest_1.it)("注册版本取构建注入的 VERSION（供服务端版本比对与补更）", () => {
        const info = (0, register_js_1.getRegisterInfo)();
        (0, vitest_1.expect)(info.clientVersion).toBe(shared_1.VERSION);
    });
    (0, vitest_1.it)("frpc 可用时声明 frp 能力与 protocol v1", () => {
        const info = (0, register_js_1.getRegisterInfo)(undefined, undefined);
        (0, vitest_1.expect)(info.capabilities).toContain("frp");
        (0, vitest_1.expect)(info.capabilityDetails?.frp).toEqual({
            available: true,
            reconcileProtocolVersion: shared_1.FRP_RECONCILE_PROTOCOL_VERSION,
        });
    });
    (0, vitest_1.it)("frpc 缺失时只声明不可用原因，不声明 frp 能力", () => {
        const saved = process.env.VCPDECK_FRPC_PATH;
        delete process.env.VCPDECK_FRPC_PATH;
        try {
            const info = (0, register_js_1.getRegisterInfo)(undefined, undefined);
            (0, vitest_1.expect)(info.capabilities).not.toContain("frp");
            (0, vitest_1.expect)(info.capabilityDetails?.frp).toEqual({
                available: false,
                code: "FRPC_NOT_FOUND",
            });
        }
        finally {
            if (saved !== undefined)
                process.env.VCPDECK_FRPC_PATH = saved;
        }
    });
    (0, vitest_1.it)("可用状态包含 agent.pi 及安全 details", () => {
        const status = {
            available: true,
            sdkVersion: "0.84.0",
            nodeVersion: "22.19.0",
            shellKind: "git-bash",
        };
        const info = (0, register_js_1.getRegisterInfo)(status);
        (0, vitest_1.expect)(info.capabilities).toContain("agent.pi");
        (0, vitest_1.expect)(info.capabilities).not.toContain("pi.probe");
        (0, vitest_1.expect)(info.capabilityDetails?.pi).toMatchObject({ available: true });
    });
    (0, vitest_1.it)("不可用状态不声明 Pi 能力，仅保留 details 原因", () => {
        const status = {
            available: false,
            code: "PI_BASH_NOT_FOUND",
            message: "no bash",
        };
        const info = (0, register_js_1.getRegisterInfo)(status);
        (0, vitest_1.expect)(info.capabilities).not.toContain("pi.probe");
        (0, vitest_1.expect)(info.capabilities).not.toContain("agent.pi");
        (0, vitest_1.expect)(info.capabilityDetails?.pi).toMatchObject({ available: false });
    });
    (0, vitest_1.it)("无探测时不声明 Pi 能力（frp details 独立存在）", () => {
        const info = (0, register_js_1.getRegisterInfo)(undefined);
        (0, vitest_1.expect)(info.capabilities).not.toContain("pi.probe");
        (0, vitest_1.expect)(info.capabilities).not.toContain("agent.pi");
        (0, vitest_1.expect)(info.capabilityDetails?.pi).toBeUndefined();
        (0, vitest_1.expect)(info.capabilityDetails?.terminal).toBeUndefined();
        (0, vitest_1.expect)(info.capabilityDetails?.frp).toMatchObject({ available: true });
    });
    (0, vitest_1.it)("终端可用时声明 terminal.pty 并携带安全 details", () => {
        const terminalStatus = {
            available: true,
            backend: "conpty",
        };
        const info = (0, register_js_1.getRegisterInfo)(undefined, terminalStatus);
        (0, vitest_1.expect)(info.capabilities).toContain("terminal.pty");
        (0, vitest_1.expect)(info.capabilityDetails?.terminal).toMatchObject({ available: true });
    });
    (0, vitest_1.it)("终端不可用时只保留 details 原因，不声明能力", () => {
        const terminalStatus = {
            available: false,
            code: "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
            message: "no backend",
        };
        const info = (0, register_js_1.getRegisterInfo)(undefined, terminalStatus);
        (0, vitest_1.expect)(info.capabilities).not.toContain("terminal.pty");
        (0, vitest_1.expect)(info.capabilityDetails?.terminal).toMatchObject({
            available: false,
        });
    });
    (0, vitest_1.it)("无终端探测时不声明能力", () => {
        const info = (0, register_js_1.getRegisterInfo)(undefined, undefined);
        (0, vitest_1.expect)(info.capabilities).not.toContain("terminal.pty");
        (0, vitest_1.expect)(info.capabilityDetails?.terminal).toBeUndefined();
    });
    (0, vitest_1.it)("native 后端可用时声明 tunnel.p2p 能力与 details；不可用只上报稳定 code", () => {
        const ok = { available: true, protocolVersion: shared_1.P2P_TUNNEL_PROTOCOL_VERSION };
        const withP2p = (0, register_js_1.getRegisterInfo)(undefined, undefined, undefined, process.env, ok);
        (0, vitest_1.expect)(withP2p.capabilities).toContain("tunnel.p2p");
        (0, vitest_1.expect)(withP2p.capabilityDetails?.p2pTunnel).toEqual(ok);
        const unavailable = {
            available: false,
            protocolVersion: shared_1.P2P_TUNNEL_PROTOCOL_VERSION,
            code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
        };
        const withBad = (0, register_js_1.getRegisterInfo)(undefined, undefined, undefined, process.env, unavailable);
        (0, vitest_1.expect)(withBad.capabilities).not.toContain("tunnel.p2p");
        (0, vitest_1.expect)(withBad.capabilityDetails?.p2pTunnel).toEqual(unavailable);
        const none = (0, register_js_1.getRegisterInfo)(undefined, undefined, undefined, process.env);
        (0, vitest_1.expect)(none.capabilities).not.toContain("tunnel.p2p");
        (0, vitest_1.expect)(none.capabilityDetails).not.toHaveProperty("p2pTunnel");
    });
    (0, vitest_1.it)("A2 运行时安全摘要序列化：privileged + installation 上报，无路径或凭据", () => {
        const info = (0, register_js_1.getRegisterInfo)(undefined, undefined, {
            privileged: {
                available: true,
                mode: "sudo-all",
                nonInteractive: true,
                runAsUser: "vcpdeck",
            },
            installation: { mode: "systemd-root-equivalent" },
        });
        (0, vitest_1.expect)(info.capabilityDetails?.privileged).toEqual({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
        });
        (0, vitest_1.expect)(info.installation).toEqual({ mode: "systemd-root-equivalent" });
        // 不新增可执行 capability 字符串。
        (0, vitest_1.expect)(info.capabilities).toEqual(["exec", "file.read", "file.write", "frp"]);
        const json = JSON.stringify(info);
        (0, vitest_1.expect)(json).not.toContain("C:\\");
        (0, vitest_1.expect)(json).not.toContain("/home/");
        (0, vitest_1.expect)(json).not.toContain("VCPDECK_PSK");
    });
    (0, vitest_1.it)("无运行时安全摘要时不报告 privileged 与 installation（旧 Client 语义）", () => {
        const info = (0, register_js_1.getRegisterInfo)();
        (0, vitest_1.expect)(info.capabilityDetails?.privileged).toBeUndefined();
        (0, vitest_1.expect)(info.installation).toBeUndefined();
    });
    (0, vitest_1.it)("仅 sudo 不可用（legacy Linux）时只报告 privileged=unavailable + legacy-pm2", () => {
        const info = (0, register_js_1.getRegisterInfo)(undefined, undefined, {
            privileged: {
                available: false,
                mode: "unavailable",
                nonInteractive: false,
                runAsUser: "xuzhen97",
            },
            installation: { mode: "legacy-pm2" },
        });
        (0, vitest_1.expect)(info.capabilityDetails?.privileged).toMatchObject({ available: false });
        (0, vitest_1.expect)(info.installation).toEqual({ mode: "legacy-pm2" });
    });
    (0, vitest_1.describe)("M1 迁移验证模式（VCPDECK_MIGRATION_VERIFY_ONLY=1）", () => {
        const a2Security = {
            privileged: {
                available: true,
                mode: "sudo-all",
                nonInteractive: true,
                runAsUser: "vcpdeck",
            },
            installation: { mode: "systemd-root-equivalent" },
        };
        (0, vitest_1.it)("verify-only：不发布任何 operational 能力，但保留身份/版本/安装/特权", () => {
            const info = (0, register_js_1.getRegisterInfo)(undefined, undefined, a2Security, {
                ...process.env,
                VCPDECK_MIGRATION_VERIFY_ONLY: "1",
            });
            // 无 operational 能力字符串。
            (0, vitest_1.expect)(info.capabilities).toEqual([]);
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("pi");
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("terminal");
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("frp");
            // 保留身份/版本/安装/特权（身份非空且稳定；具体值由模块导入期 CLIENT_ID 决定）。
            (0, vitest_1.expect)(typeof info.clientId).toBe("string");
            (0, vitest_1.expect)(info.clientId.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(info.clientVersion).toBe(shared_1.VERSION);
            (0, vitest_1.expect)(info.installation).toEqual({ mode: "systemd-root-equivalent" });
            (0, vitest_1.expect)(info.capabilityDetails?.privileged).toMatchObject({
                available: true,
                mode: "sudo-all",
            });
        });
        (0, vitest_1.it)("verify-only 即使探测到 Pi/Terminal/FRP 可用也不声明", () => {
            const piStatus = {
                available: true,
                sdkVersion: "0.84.0",
                nodeVersion: "22.19.0",
                shellKind: "git-bash",
            };
            const terminalStatus = {
                available: true,
                backend: "conpty",
            };
            const info = (0, register_js_1.getRegisterInfo)(piStatus, terminalStatus, a2Security, {
                ...process.env,
                VCPDECK_MIGRATION_VERIFY_ONLY: "1",
            });
            (0, vitest_1.expect)(info.capabilities).toEqual([]);
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("pi");
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("terminal");
            (0, vitest_1.expect)(info.capabilityDetails).not.toHaveProperty("frp");
        });
        (0, vitest_1.it)("稳态（无 verify-only）照常发布 operational 能力", () => {
            const info = (0, register_js_1.getRegisterInfo)(undefined, undefined, a2Security);
            (0, vitest_1.expect)(info.capabilities).toContain("exec");
            (0, vitest_1.expect)(info.capabilityDetails).toHaveProperty("frp");
        });
    });
    (0, vitest_1.it)("序列化结果不包含本地路径或凭据", () => {
        const status = {
            available: true,
            sdkVersion: "0.84.0",
            nodeVersion: "22.19.0",
            shellKind: "configured",
        };
        vitest_1.vi.spyOn(require("node:os"), "homedir").mockReturnValue("C:\\Users\\secret-user");
        const info = (0, register_js_1.getRegisterInfo)(status);
        (0, vitest_1.expect)(JSON.stringify(info)).not.toContain("secret-user");
        (0, vitest_1.expect)(JSON.stringify(info)).not.toContain("C:\\");
        vitest_1.vi.restoreAllMocks();
    });
});
