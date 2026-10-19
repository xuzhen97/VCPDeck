import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "./windows-launcher.js";

const COMSPEC = "C:\\Windows\\System32\\cmd.exe";

const WINDOWS_ENV: NodeJS.ProcessEnv = {
	PATH: "C:\\tools;C:\\bin",
	PATHEXT: ".COM;.EXE;.BAT;.CMD",
	ComSpec: COMSPEC,
};

/**
 * 大小写不敏感的文件存在性替身（Windows 语义）。
 *
 * 注意：经 PATH + PATHEXT 解析出来的路径会保留 PATHEXT 的大小写（`.CMD`/`.EXE`），
 * Windows 文件系统不区分大小写，cmd.exe 也能正常执行，因此断言按该形态书写。
 */
function files(...paths: string[]): (path: string) => boolean {
	const set = new Set(paths.map((path) => path.toLowerCase()));
	return (path) => set.has(path.toLowerCase());
}

describe("resolveSpawnTarget", () => {
	it("非 Windows 平台不做任何改写", () => {
		const target = resolveSpawnTarget({
			command: "dsh",
			args: ["--profile", "acp"],
			platform: "linux",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\dsh.cmd"),
		});
		expect(target).toEqual({ command: "dsh", args: ["--profile", "acp"] });
	});

	it("win32 裸命令命中 PATH 里的 .exe 时使用解析后的绝对路径", () => {
		const target = resolveSpawnTarget({
			command: "dsh",
			args: ["--profile", "acp"],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\dsh.exe"),
		});
		expect(target.command).toBe("C:\\tools\\dsh.EXE");
		expect(target.args).toEqual(["--profile", "acp"]);
		expect(target.windowsVerbatimArguments).toBeUndefined();
	});

	it("win32 裸命令命中 .cmd 时经 cmd.exe 包装", () => {
		const target = resolveSpawnTarget({
			command: "dsh",
			args: ["--profile", "acp"],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\dsh.cmd"),
		});
		expect(target.command).toBe(COMSPEC);
		// /s 会剥掉最外层引号，因此整条命令行必须再包一层引号
		expect(target.args).toEqual([
			"/d",
			"/s",
			"/c",
			'""C:\\tools\\dsh.CMD" "--profile" "acp""',
		]);
		expect(target.windowsVerbatimArguments).toBe(true);
	});

	it("win32 绝对 .cmd 路径被包装，.exe 路径原样使用", () => {
		const cmd = resolveSpawnTarget({
			command: "C:\\tools\\agent.cmd",
			args: [],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\agent.cmd"),
		});
		expect(cmd.command).toBe(COMSPEC);
		expect(cmd.args[3]).toBe('""C:\\tools\\agent.cmd""');

		const exe = resolveSpawnTarget({
			command: "C:\\tools\\agent.exe",
			args: ["--x"],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\agent.exe"),
		});
		expect(exe).toEqual({ command: "C:\\tools\\agent.exe", args: ["--x"] });
	});

	it("win32 无扩展名的绝对路径按 PATHEXT 补齐", () => {
		const target = resolveSpawnTarget({
			command: "C:\\tools\\agent",
			args: ["run"],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\agent.cmd"),
		});
		expect(target.command).toBe(COMSPEC);
		expect(target.args[3]).toBe('""C:\\tools\\agent.CMD" "run""');
	});

	it("PATH 未命中时保持原样，交给 spawn 报 ENOENT", () => {
		const target = resolveSpawnTarget({
			command: "nope",
			args: ["--x"],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: () => false,
		});
		expect(target).toEqual({ command: "nope", args: ["--x"] });
	});

	it("同一目录内按 PATHEXT 顺序优先 .exe 而不是 .cmd", () => {
		const target = resolveSpawnTarget({
			command: "dsh",
			args: [],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\dsh.cmd", "C:\\tools\\dsh.exe"),
		});
		expect(target.command).toBe("C:\\tools\\dsh.EXE");
	});

	it("PATH 目录顺序优先于扩展名顺序（先命中的目录获胜）", () => {
		const target = resolveSpawnTarget({
			command: "dsh",
			args: [],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\dsh.cmd", "C:\\bin\\dsh.exe"),
		});
		expect(target.command).toBe(COMSPEC);
		expect(target.args[3]).toBe('""C:\\tools\\dsh.CMD""');
	});

	it("参数里的空格与 cmd 元字符被引号包裹", () => {
		const target = resolveSpawnTarget({
			command: "C:\\tools\\agent.cmd",
			args: ["a b&c", 'say "hi"', ""],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\agent.cmd"),
		});
		expect(target.args[3]).toBe(
			'""C:\\tools\\agent.cmd" "a b&c" "say ""hi""" """',
		);
	});

	it("缺省 ComSpec 时回退到 cmd.exe", () => {
		const target = resolveSpawnTarget({
			command: "C:\\tools\\agent.cmd",
			args: [],
			platform: "win32",
			env: { PATH: "", PATHEXT: ".CMD" },
			isFile: files("C:\\tools\\agent.cmd"),
		});
		expect(target.command).toBe("cmd.exe");
	});

	it("非脚本扩展名不做包装", () => {
		const target = resolveSpawnTarget({
			command: "C:\\tools\\agent.ps1",
			args: [],
			platform: "win32",
			env: WINDOWS_ENV,
			isFile: files("C:\\tools\\agent.ps1"),
		});
		expect(target).toEqual({ command: "C:\\tools\\agent.ps1", args: [] });
	});
});
