"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverShells = discoverShells;
exports.toTerminalShellInfo = toTerminalShellInfo;
const node_path_1 = require("node:path");
const WIN32_ORDER = [
    { name: "pwsh", kind: "pwsh", args: ["-NoLogo"] },
    { name: "powershell", kind: "powershell", args: ["-NoLogo"] },
    { name: "cmd", kind: "cmd", args: ["/Q"] },
];
const POSIX_NAMES = [
    { name: "bash", kind: "bash" },
    { name: "zsh", kind: "zsh" },
    { name: "sh", kind: "sh" },
];
function kindForExecutable(path) {
    const name = (0, node_path_1.basename)(path).toLowerCase().replace(/\.exe$/, "");
    switch (name) {
        case "pwsh":
            return "pwsh";
        case "powershell":
            return "powershell";
        case "cmd":
            return "cmd";
        case "bash":
            return "bash";
        case "zsh":
            return "zsh";
        case "sh":
            return "sh";
        default:
            return "other";
    }
}
/**
 * 探测可用 Shell（Windows：pwsh → powershell → cmd；POSIX：$SHELL → bash → zsh → sh）。
 * 只返回实际可用项；第一个可用项为默认。按解析后的可执行路径去重。
 */
async function discoverShells(env) {
    const entries = [];
    const seen = new Set();
    async function add(path, id, args) {
        if (!path || seen.has(path))
            return;
        if (!(await env.isExecutable(path)))
            return;
        seen.add(path);
        entries.push({
            id,
            label: id,
            kind: kindForExecutable(path),
            executable: path,
            args,
            isDefault: false,
        });
    }
    if (env.platform === "win32") {
        for (const shell of WIN32_ORDER) {
            const resolved = await env.resolveExecutable(shell.name);
            await add(resolved, shell.name, shell.args);
        }
    }
    else {
        // $SHELL 可能是绝对路径或裸命令名
        const shellEnv = env.shellEnv?.trim();
        if (shellEnv) {
            if (shellEnv.includes("/")) {
                await add(shellEnv, (0, node_path_1.basename)(shellEnv).replace(/\.exe$/, ""), []);
            }
            else {
                const resolved = await env.resolveExecutable(shellEnv);
                await add(resolved, shellEnv, []);
            }
        }
        for (const shell of POSIX_NAMES) {
            const resolved = await env.resolveExecutable(shell.name);
            await add(resolved, shell.name, []);
        }
    }
    if (entries.length > 0)
        entries[0] = { ...entries[0], isDefault: true };
    return entries;
}
/** 映射为公开 Shell DTO（不含可执行文件路径与启动参数）。 */
function toTerminalShellInfo(entry) {
    return {
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        isDefault: entry.isDefault,
    };
}
