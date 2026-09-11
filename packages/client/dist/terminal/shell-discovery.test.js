"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shell_discovery_js_1 = require("./shell-discovery.js");
const PATH_WIN = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7";
const PATH_LINUX = "/usr/local/bin:/usr/bin:/bin";
/**
 * PATH 解析器 fake：按 platform 处理扩展名，返回 available 表中存在的候选路径。
 * available 键为小写完整路径。
 */
function makeResolver(platform, pathEnv, pathExt, available) {
    return async (name) => {
        const exts = platform === "win32" ? pathExt.split(";").filter(Boolean) : [""];
        for (const dir of pathEnv.split(";").filter(Boolean)) {
            for (const ext of exts) {
                const candidate = `${dir}\\${name}${ext}`;
                if (available[candidate.toLowerCase()] !== undefined)
                    return candidate;
            }
        }
        return null;
    };
}
const NO_RESOLVER = async () => null;
function winEnv(overrides = {}) {
    return {
        platform: "win32",
        home: "C:\\Users\\dev",
        shellEnv: undefined,
        path: PATH_WIN,
        pathExt: ".COM;.EXE;.BAT;.CMD",
        resolveExecutable: NO_RESOLVER,
        isExecutable: async () => true,
        ...overrides,
    };
}
function linuxEnv(overrides = {}) {
    return {
        platform: "linux",
        home: "/home/dev",
        shellEnv: undefined,
        path: PATH_LINUX,
        pathExt: "",
        resolveExecutable: NO_RESOLVER,
        isExecutable: async () => true,
        ...overrides,
    };
}
(0, vitest_1.describe)("Windows Shell 探测", () => {
    (0, vitest_1.it)("pwsh 存在时按 pwsh → powershell → cmd 顺序且 pwsh 为默认", async () => {
        const env = winEnv({
            path: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
            resolveExecutable: makeResolver("win32", "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0", ".COM;.EXE;.BAT;.CMD", {
                "c:\\windows\\system32\\cmd.exe": "",
                "c:\\program files\\powershell\\7\\pwsh.exe": "",
                "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe": "",
            }),
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells.map((s) => s.id)).toEqual(["pwsh", "powershell", "cmd"]);
        (0, vitest_1.expect)(shells[0]?.isDefault).toBe(true);
        (0, vitest_1.expect)(shells[1]?.isDefault).toBe(false);
        (0, vitest_1.expect)(shells[0]?.kind).toBe("pwsh");
        (0, vitest_1.expect)(shells[2]?.kind).toBe("cmd");
    });
    (0, vitest_1.it)("仅 cmd 可用时默认 cmd", async () => {
        const env = winEnv({
            resolveExecutable: makeResolver("win32", PATH_WIN, ".COM;.EXE;.BAT;.CMD", {
                "c:\\windows\\system32\\cmd.exe": "",
            }),
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells.map((s) => s.id)).toEqual(["cmd"]);
        (0, vitest_1.expect)(shells[0]?.isDefault).toBe(true);
        (0, vitest_1.expect)(shells[0]?.args).toEqual(["/Q"]);
    });
    (0, vitest_1.it)("无任何 Shell 时返回空列表", async () => {
        const shells = await (0, shell_discovery_js_1.discoverShells)(winEnv());
        (0, vitest_1.expect)(shells).toEqual([]);
    });
    (0, vitest_1.it)("公开 DTO 不含可执行文件路径和 args", async () => {
        const env = winEnv({
            resolveExecutable: makeResolver("win32", PATH_WIN, ".COM;.EXE;.BAT;.CMD", {
                "c:\\windows\\system32\\cmd.exe": "",
            }),
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        const dto = shells.map(shell_discovery_js_1.toTerminalShellInfo);
        (0, vitest_1.expect)(JSON.stringify(dto)).not.toContain("C:\\");
        (0, vitest_1.expect)(JSON.stringify(dto)).not.toContain("cmd.exe");
        (0, vitest_1.expect)(dto[0]).toEqual({ id: "cmd", label: "cmd", kind: "cmd", isDefault: true });
    });
});
(0, vitest_1.describe)("Linux Shell 探测", () => {
    (0, vitest_1.it)("$SHELL 存在且可执行时优先并默认", async () => {
        const env = linuxEnv({
            shellEnv: "/bin/zsh",
            resolveExecutable: async (name) => name === "zsh" ? "/usr/bin/zsh" : name === "bash" ? "/usr/bin/bash" : null,
            isExecutable: async (p) => p === "/bin/zsh" || p === "/usr/bin/bash" || p === "/usr/bin/zsh",
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells.map((s) => s.id)).toEqual(["zsh", "bash", "zsh"]);
        (0, vitest_1.expect)(shells[0]?.isDefault).toBe(true);
        (0, vitest_1.expect)(shells[0]?.kind).toBe("zsh");
        (0, vitest_1.expect)(shells[2]?.executable).toBe("/usr/bin/zsh");
    });
    (0, vitest_1.it)("$SHELL 不可执行时降级 bash 并默认", async () => {
        const env = linuxEnv({
            shellEnv: "/bin/fish",
            resolveExecutable: async (name) => name === "bash" ? "/usr/bin/bash" : name === "zsh" ? "/usr/bin/zsh" : null,
            isExecutable: async (p) => p === "/usr/bin/bash",
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells.map((s) => s.id)).toEqual(["bash"]);
        (0, vitest_1.expect)(shells[0]?.isDefault).toBe(true);
    });
    (0, vitest_1.it)("按解析后的真实可执行文件去重", async () => {
        const env = linuxEnv({
            shellEnv: "/usr/bin/bash",
            resolveExecutable: async (name) => name === "bash" ? "/usr/bin/bash" : name === "sh" ? "/usr/bin/bash" : null,
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells.map((s) => s.id)).toEqual(["bash"]);
    });
    (0, vitest_1.it)("未知 $SHELL 记 kind=other 且仍是默认", async () => {
        const env = linuxEnv({
            shellEnv: "/opt/fish",
            resolveExecutable: async (name) => (name === "bash" ? "/usr/bin/bash" : null),
            isExecutable: async (p) => p === "/opt/fish" || p === "/usr/bin/bash",
        });
        const shells = await (0, shell_discovery_js_1.discoverShells)(env);
        (0, vitest_1.expect)(shells[0]?.id).toBe("fish");
        (0, vitest_1.expect)(shells[0]?.kind).toBe("other");
        (0, vitest_1.expect)(shells[0]?.isDefault).toBe(true);
    });
});
(0, vitest_1.describe)("toTerminalShellInfo", () => {
    (0, vitest_1.it)("只输出安全字段", () => {
        const info = (0, shell_discovery_js_1.toTerminalShellInfo)({
            id: "bash",
            label: "bash",
            kind: "bash",
            executable: "/usr/bin/bash",
            args: [],
            isDefault: true,
        });
        (0, vitest_1.expect)(info).toEqual({ id: "bash", label: "bash", kind: "bash", isDefault: true });
    });
});
