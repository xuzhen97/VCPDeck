import { describe, expect, it } from "vitest";
import {
	discoverShells,
	toTerminalShellInfo,
	type ShellDiscoveryEnv,
} from "./shell-discovery.js";

const PATH_WIN = "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7";
const PATH_LINUX = "/usr/local/bin:/usr/bin:/bin";

/**
 * PATH 解析器 fake：按 platform 处理扩展名，返回 available 表中存在的候选路径。
 * available 键为小写完整路径。
 */
function makeResolver(
	platform: NodeJS.Platform,
	pathEnv: string,
	pathExt: string,
	available: Record<string, string>,
) {
	return async (name: string): Promise<string | null> => {
		const exts = platform === "win32" ? pathExt.split(";").filter(Boolean) : [""];
		for (const dir of pathEnv.split(";").filter(Boolean)) {
			for (const ext of exts) {
				const candidate = `${dir}\\${name}${ext}`;
				if (available[candidate.toLowerCase()] !== undefined) return candidate;
			}
		}
		return null;
	};
}

const NO_RESOLVER = async (): Promise<string | null> => null;

function winEnv(overrides: Partial<ShellDiscoveryEnv> = {}): ShellDiscoveryEnv {
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

function linuxEnv(overrides: Partial<ShellDiscoveryEnv> = {}): ShellDiscoveryEnv {
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

describe("Windows Shell 探测", () => {
	it("pwsh 存在时按 pwsh → powershell → cmd 顺序且 pwsh 为默认", async () => {
		const env = winEnv({
			path:
				"C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
			resolveExecutable: makeResolver(
				"win32",
				"C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
				".COM;.EXE;.BAT;.CMD",
				{
					"c:\\windows\\system32\\cmd.exe": "",
					"c:\\program files\\powershell\\7\\pwsh.exe": "",
					"c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe": "",
				},
			),
		});
		const shells = await discoverShells(env);
		expect(shells.map((s) => s.id)).toEqual(["pwsh", "powershell", "cmd"]);
		expect(shells[0]?.isDefault).toBe(true);
		expect(shells[1]?.isDefault).toBe(false);
		expect(shells[0]?.kind).toBe("pwsh");
		expect(shells[2]?.kind).toBe("cmd");
	});

	it("仅 cmd 可用时默认 cmd", async () => {
		const env = winEnv({
			resolveExecutable: makeResolver("win32", PATH_WIN, ".COM;.EXE;.BAT;.CMD", {
				"c:\\windows\\system32\\cmd.exe": "",
			}),
		});
		const shells = await discoverShells(env);
		expect(shells.map((s) => s.id)).toEqual(["cmd"]);
		expect(shells[0]?.isDefault).toBe(true);
		expect(shells[0]?.args).toEqual(["/Q"]);
	});

	it("无任何 Shell 时返回空列表", async () => {
		const shells = await discoverShells(winEnv());
		expect(shells).toEqual([]);
	});

	it("公开 DTO 不含可执行文件路径和 args", async () => {
		const env = winEnv({
			resolveExecutable: makeResolver("win32", PATH_WIN, ".COM;.EXE;.BAT;.CMD", {
				"c:\\windows\\system32\\cmd.exe": "",
			}),
		});
		const shells = await discoverShells(env);
		const dto = shells.map(toTerminalShellInfo);
		expect(JSON.stringify(dto)).not.toContain("C:\\");
		expect(JSON.stringify(dto)).not.toContain("cmd.exe");
		expect(dto[0]).toEqual({ id: "cmd", label: "cmd", kind: "cmd", isDefault: true });
	});
});

describe("Linux Shell 探测", () => {
	it("$SHELL 存在且可执行时优先并默认", async () => {
		const env = linuxEnv({
			shellEnv: "/bin/zsh",
			resolveExecutable: async (name) =>
				name === "zsh" ? "/usr/bin/zsh" : name === "bash" ? "/usr/bin/bash" : null,
			isExecutable: async (p) => p === "/bin/zsh" || p === "/usr/bin/bash" || p === "/usr/bin/zsh",
		});
		const shells = await discoverShells(env);
		expect(shells.map((s) => s.id)).toEqual(["zsh", "bash", "zsh"]);
		expect(shells[0]?.isDefault).toBe(true);
		expect(shells[0]?.kind).toBe("zsh");
		expect(shells[2]?.executable).toBe("/usr/bin/zsh");
	});

	it("$SHELL 不可执行时降级 bash 并默认", async () => {
		const env = linuxEnv({
			shellEnv: "/bin/fish",
			resolveExecutable: async (name) =>
				name === "bash" ? "/usr/bin/bash" : name === "zsh" ? "/usr/bin/zsh" : null,
			isExecutable: async (p) => p === "/usr/bin/bash",
		});
		const shells = await discoverShells(env);
		expect(shells.map((s) => s.id)).toEqual(["bash"]);
		expect(shells[0]?.isDefault).toBe(true);
	});

	it("按解析后的真实可执行文件去重", async () => {
		const env = linuxEnv({
			shellEnv: "/usr/bin/bash",
			resolveExecutable: async (name) =>
				name === "bash" ? "/usr/bin/bash" : name === "sh" ? "/usr/bin/bash" : null,
		});
		const shells = await discoverShells(env);
		expect(shells.map((s) => s.id)).toEqual(["bash"]);
	});

	it("未知 $SHELL 记 kind=other 且仍是默认", async () => {
		const env = linuxEnv({
			shellEnv: "/opt/fish",
			resolveExecutable: async (name) => (name === "bash" ? "/usr/bin/bash" : null),
			isExecutable: async (p) => p === "/opt/fish" || p === "/usr/bin/bash",
		});
		const shells = await discoverShells(env);
		expect(shells[0]?.id).toBe("fish");
		expect(shells[0]?.kind).toBe("other");
		expect(shells[0]?.isDefault).toBe(true);
	});
});

describe("toTerminalShellInfo", () => {
	it("只输出安全字段", () => {
		const info = toTerminalShellInfo({
			id: "bash",
			label: "bash",
			kind: "bash",
			executable: "/usr/bin/bash",
			args: [],
			isDefault: true,
		});
		expect(info).toEqual({ id: "bash", label: "bash", kind: "bash", isDefault: true });
	});
});
