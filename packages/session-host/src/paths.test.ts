import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSessionHostPaths, resolveSessionHostPaths } from "./paths.js";

// 用 path.win32.sep 拼接期望值，避免反斜杠在测试源码里被转义层吞掉。
const win = (...segments: string[]) => segments.join(path.win32.sep);
const PROGRAM_DATA_C = win("C:", "ProgramData");
const PROGRAM_DATA_D = win("D:", "ProgramData");

describe("会话宿主稳定目录", () => {
	it("Windows 使用 ProgramData", () => {
		const p = resolveSessionHostPaths("win32", { ProgramData: PROGRAM_DATA_C });
		expect(p.root).toBe(win("C:", "ProgramData", "VCPDeck", "session-host"));
		expect(p.stateDir).toBe(win("C:", "ProgramData", "VCPDeck", "session-host", "state"));
		expect(p.logDir).toBe(win("C:", "ProgramData", "VCPDeck", "session-host", "log"));
	});

	it("Windows 缺 ProgramData 时回退 ALLUSERSPROFILE", () => {
		expect(resolveSessionHostPaths("win32", { ALLUSERSPROFILE: PROGRAM_DATA_D }).root).toBe(
			win("D:", "ProgramData", "VCPDeck", "session-host"),
		);
	});

	it("Windows 两者都缺时拒绝猜测", () => {
		expect(() => resolveSessionHostPaths("win32", {})).toThrow(/ProgramData/);
	});

	it("Linux 使用 /var/lib", () => {
		expect(resolveSessionHostPaths("linux", {}).runDir).toBe("/var/lib/vcpdeck/session-host/run");
	});

	it("路径拼接跟随传入平台，不跟随宿主进程平台", () => {
		// 本机是 Windows，但按 linux 解析必须得到 posix 路径。
		expect(resolveSessionHostPaths("linux", {}).root).toBe("/var/lib/vcpdeck/session-host");
		expect(resolveSessionHostPaths("linux", {}).root).not.toContain("\\");
	});

	it("范围外平台直接拒绝，不以其他平台布局兜底", () => {
		expect(() => resolveSessionHostPaths("darwin", {})).toThrow(/仅支持 Windows 与 Linux/);
	});

	it("目录不随版本变化", () => {
		expect(resolveSessionHostPaths("linux", {}).root).not.toMatch(/\d+\.\d+\.\d+/);
		expect(win("C:", "ProgramData", "VCPDeck", "session-host")).not.toMatch(/\d+\.\d+\.\d+/);
	});

	it("ensure 顺序创建全部目录", async () => {
		const created: string[] = [];
		await ensureSessionHostPaths(resolveSessionHostPaths("linux", {}), async (t) => {
			created.push(t);
		});
		expect(created).toEqual([
			"/var/lib/vcpdeck/session-host",
			"/var/lib/vcpdeck/session-host/state",
			"/var/lib/vcpdeck/session-host/run",
			"/var/lib/vcpdeck/session-host/log",
		]);
	});
});
