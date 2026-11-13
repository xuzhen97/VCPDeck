/**
 * Tailnet 探测的可执行文件回退单测。
 *
 * 覆盖场景：安装成功后只更新系统 PATH（Windows 落在注册表），而已经运行的
 * client 进程仍持有启动时的环境快照，裸名 `tailscale` 会一直 ENOENT，
 * 使 ensure 在安装成功后复检为「未安装」并误报 TAILNET_INSTALL_FAILED。
 */
import { describe, expect, it, vi } from "vitest";
import {
	fallbackBinaryCandidates,
	probeTailnet,
	resolveTailscaleBinary,
} from "./probe.js";

const h = vi.hoisted(() => {
	const calls: { command: string; args: string[] }[] = [];
	const state = { pathResolvesBinary: false };
	const execFile = (
		command: string,
		args: string[],
		_options: unknown,
		callback: (
			error: (Error & { code?: string }) | null,
			stdout?: string,
		) => void,
	) => {
		calls.push({ command, args });
		if (command === "tailscale" && !state.pathResolvesBinary) {
			callback(
				Object.assign(new Error("spawn tailscale ENOENT"), {
					code: "ENOENT",
				}),
				"",
			);
			return;
		}
		if (args[0] === "version") {
			callback(null, "1.104.5\n  tailscale commit: 7883847\n");
			return;
		}
		callback(
			null,
			JSON.stringify({
				BackendState: "NeedsLogin",
				Self: { DNSName: "mechrevo-mini.tail500c0d.ts.net." },
			}),
		);
	};
	return { calls, state, execFile };
});

vi.mock("node:child_process", () => ({ execFile: h.execFile }));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	existsSync: () => true,
}));

const OBSERVED_AT = "2026-11-13T14:04:52.614Z";

describe("tailnet 探测的可执行文件解析", () => {
	it("按平台给出兜底安装位置", () => {
		expect(fallbackBinaryCandidates("win32", {})).toEqual([
			"C:\\Program Files\\Tailscale\\tailscale.exe",
		]);
		expect(
			fallbackBinaryCandidates("win32", { ProgramFiles: "D:\\Apps" }),
		).toEqual(["D:\\Apps\\Tailscale\\tailscale.exe"]);
		expect(fallbackBinaryCandidates("linux", {})).toContain(
			"/usr/local/bin/tailscale",
		);
	});

	it("写操作解析到绝对路径，避免同样受 PATH 未刷新的影响", () => {
		expect(resolveTailscaleBinary("win32", {})).toBe(
			"C:\\Program Files\\Tailscale\\tailscale.exe",
		);
		expect(resolveTailscaleBinary("linux", {})).toBe(
			"/usr/local/bin/tailscale",
		);
	});

	it("PATH 未刷新时回退到已知安装位置完成探测", async () => {
		h.state.pathResolvesBinary = false;
		h.calls.length = 0;

		const snapshot = await probeTailnet({ now: () => OBSERVED_AT });
		const fallback = fallbackBinaryCandidates()[0];

		expect(snapshot.installed).toBe("yes");
		expect(snapshot.version).toBe("1.104.5");
		expect(snapshot.backend).toBe("needs-login");
		// 先按 PATH 用裸名试过，失败后才换成绝对路径。
		expect(h.calls[0]).toEqual({ command: "tailscale", args: ["version"] });
		expect(h.calls[1]).toEqual({ command: fallback, args: ["version"] });
		expect(h.calls.filter((call) => call.command !== "tailscale")).toHaveLength(
			2,
		);
	});

	it("PATH 能解析时不回退，不做多余调用", async () => {
		h.state.pathResolvesBinary = true;
		h.calls.length = 0;

		const snapshot = await probeTailnet({ now: () => OBSERVED_AT });

		expect(snapshot.installed).toBe("yes");
		expect(h.calls.every((call) => call.command === "tailscale")).toBe(true);
	});
});
