import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyShellPathDirs,
	filterShellTools,
	type PiShellEnv,
	type PiShellResolution,
	prependShellPathDirs,
	resolvePiShells,
} from "./shell.js";

/** 只声明「存在」的路径集合，其余一律不存在。 */
function envWith(
	platform: NodeJS.Platform,
	presentPaths: string[],
	env: NodeJS.ProcessEnv = {},
	onPath: Record<string, string> = {},
): PiShellEnv {
	return {
		platform,
		env,
		exists: async (p) => presentPaths.includes(p),
		findInPath: async (name) => onPath[name] ?? null,
	};
}

describe("resolvePiShells", () => {
	it("Windows：Git Bash 与 PowerShell 都按绝对路径命中（不依赖 PATH）", async () => {
		const result = await resolvePiShells(
			envWith(
				"win32",
				[
					"C:\\Program Files\\Git\\bin\\bash.exe",
					"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
				],
				{ ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
			),
		);
		expect(result).toEqual({
			bash: "C:\\Program Files\\Git\\bin\\bash.exe",
			bashSource: "git-bash",
			powershell:
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			// 命中路径自身目录也入列：SDK 的 PATH 解析（`where`）必须能定位到它。
			pathDirs: [
				"C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
				"C:\\Program Files\\Git\\bin",
			],
		});
	});

	it("Windows：x86 Git 目录被识别为 git-bash（旧探测漏掉的分支）", async () => {
		const result = await resolvePiShells(
			envWith(
				"win32",
				["C:\\Program Files (x86)\\Git\\bin\\bash.exe"],
				{
					ProgramFiles: "C:\\Program Files",
					"ProgramFiles(x86)": "C:\\Program Files (x86)",
				},
			),
		);
		expect(result.bash).toBe("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
		expect(result.bashSource).toBe("git-bash");
	});

	it("Windows：只有 PowerShell 时 bash 为 null，Pi 仍可用", async () => {
		const result = await resolvePiShells(
			envWith(
				"win32",
				["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
				{ SystemRoot: "C:\\Windows" },
			),
		);
		expect(result.bash).toBeNull();
		expect(result.bashSource).toBeNull();
		expect(result.powershell).not.toBeNull();
	});

	it("Windows：PATH 仍是最后回退（能找到时标 path 来源并进行注目录）", async () => {
		const result = await resolvePiShells(
			envWith("win32", [], { SystemRoot: "C:\\Windows" }, {
				"bash.exe": "D:\\tools\\git\\bin\\bash.exe",
				"powershell.exe": "D:\\tools\\ps\\powershell.exe",
			}),
		);
		expect(result.bash).toBe("D:\\tools\\git\\bin\\bash.exe");
		expect(result.bashSource).toBe("path");
		expect(result.powershell).toBe("D:\\tools\\ps\\powershell.exe");
	});

	it("POSIX：/bin/bash 视为 system 来源，powershell 恒为 null", async () => {
		const result = await resolvePiShells(envWith("linux", ["/bin/bash"]));
		expect(result).toEqual({
			bash: "/bin/bash",
			bashSource: "system",
			powershell: null,
			pathDirs: ["/bin"],
		});
	});
});

describe("prependShellPathDirs", () => {
	const resolution: PiShellResolution = {
		bash: null,
		bashSource: null,
		powershell: null,
		pathDirs: ["C:\\ps", "C:\\git"],
	};

	it("保留原 PATH 变量名大小写并前置", () => {
		const result = prependShellPathDirs(resolution, { Path: "C:\\Windows" });
		expect(result.Path).toBe("C:\\ps;c:\\git;C:\\Windows".replace("c:", "C:"));
	});

	it("无目录时不改动环境（返回原引用）", () => {
		const env = { PATH: "C:\\Windows" };
		expect(
			prependShellPathDirs({ ...resolution, pathDirs: [] }, env),
		).toBe(env);
	});
});

describe("filterShellTools", () => {
	const winNoBash: PiShellResolution = {
		bash: null,
		bashSource: null,
		powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		pathDirs: [],
	};
	const winBoth: PiShellResolution = {
		...winNoBash,
		bash: "C:\\Program Files\\Git\\bin\\bash.exe",
		bashSource: "git-bash",
	};

	it("Windows 无 bash：去掉 bash，保留 powershell", () => {
		expect(
			filterShellTools(["bash", "powershell", "read"], winNoBash, "win32"),
		).toEqual(["powershell", "read"]);
	});

	it("Windows 两者齐备：都保留", () => {
		expect(
			filterShellTools(["bash", "powershell", "read"], winBoth, "win32"),
		).toEqual(["bash", "powershell", "read"]);
	});

	it("POSIX：去掉 powershell，保留 bash 与其它工具", () => {
		expect(
			filterShellTools(
				["bash", "powershell", "read"],
				{ ...winBoth, powershell: null },
				"linux",
			),
		).toEqual(["bash", "read"]);
	});
});

describe("applyShellPathDirs", () => {
	it("只就地改写 PATH，不重写其它环境变量", () => {
		const env: NodeJS.ProcessEnv = { Path: "C:\\Windows", KEEP: "1" };
		applyShellPathDirs(
			{ bash: null, bashSource: null, powershell: null, pathDirs: ["C:\\ps"] },
			env,
		);
		expect(env).toEqual({
			Path: ["C:\\ps", "C:\\Windows"].join(delimiter),
			KEEP: "1",
		});
	});

	it("无目录时不触碰环境", () => {
		const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
		applyShellPathDirs(
			{ bash: null, bashSource: null, powershell: null, pathDirs: [] },
			env,
		);
		expect(env).toEqual({ PATH: "C:\\Windows" });
	});
});
