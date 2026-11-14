/**
 * Tailnet 安装器单测（ADR-0062）。
 *
 * 全部以注入替身驱动：不联网、不安装、不启动系统服务。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privileged } from "../privileged-command.js";
import {
	installTailnet,
	linuxInstallPlan,
	tailscaledDaemonPath,
	TAILNET_ARTIFACT_SHA256,
	type TailnetInstallDeps,
	type TailnetInstallRunResult,
} from "./installer.js";

const SIGNAL = new AbortController().signal;

function makeDeps(overrides: Partial<TailnetInstallDeps> = {}): {
	deps: TailnetInstallDeps;
	calls: { command: string; args: string[] }[];
	downloads: string[];
} {
	const calls: { command: string; args: string[] }[] = [];
	const downloads: string[] = [];
	const deps: TailnetInstallDeps = {
		platform: "linux",
		arch: "x64",
		osRelease: { ID: "ubuntu", VERSION_ID: "22.04" },
		privileged: true,
		pathExists: async () => false,
		makeTempDir: async () => "/tmp/vcp-tailnet-install",
		removePath: async () => undefined,
		download: async (url) => {
			downloads.push(url);
		},
		sha256File: async () => TAILNET_ARTIFACT_SHA256.linux,
		verifyWindowsSignature: async () => true,
		run: async (command, args): Promise<TailnetInstallRunResult> => {
			calls.push({ command, args });
			if (command === "tar" && args[0] === "-tvzf") {
				return {
					code: 0,
					stdout:
						"-rwxr-xr-x 0/0 0 2026-01-01 tailscale\n-rwxr-xr-x 0/0 0 2026-01-01 tailscaled\ndrwxr-xr-x 0/0 0 2026-01-01 systemd\n",
				};
			}
			return { code: 0, stdout: "" };
		},
		placeLinuxFiles: async () => undefined,
		escalate: (command, args) => ({ command, args }),
		...overrides,
	};
	return { deps, calls, downloads };
}

describe("Tailnet 安装器", () => {
	it("已有安装或 state 时安全失败，不下载也不覆盖", async () => {
		const { deps, downloads } = makeDeps({ pathExists: async () => true });
		await expect(installTailnet(SIGNAL, deps)).rejects.toMatchObject({
			code: "TAILNET_EXISTING_CONFIG",
		});
		expect(downloads).toHaveLength(0);
	});

	it("非矩阵平台或缺少 root/管理员权限时拒绝自动安装", async () => {
		const arm = makeDeps({ arch: "arm64" });
		await expect(installTailnet(SIGNAL, arm.deps)).rejects.toMatchObject({
			code: "TAILNET_UNSUPPORTED_PLATFORM",
		});
		expect(arm.downloads).toHaveLength(0);

		const noRoot = makeDeps({ privileged: false });
		await expect(installTailnet(SIGNAL, noRoot.deps)).rejects.toMatchObject({
			code: "TAILNET_UNSUPPORTED_PLATFORM",
		});
		expect(noRoot.downloads).toHaveLength(0);
	});

	it("已取消的信号不产生任何下载", async () => {
		const controller = new AbortController();
		controller.abort();
		const { deps, downloads } = makeDeps();
		await expect(installTailnet(controller.signal, deps)).rejects.toMatchObject({
			code: "TAILNET_INSTALL_FAILED",
		});
		expect(downloads).toHaveLength(0);
	});

	it("校验和或签名不匹配时拒绝执行安装程序，并清理临时目录", async () => {
		const removed: string[] = [];
		const { deps, calls } = makeDeps({
			sha256File: async () => "deadbeef",
			removePath: async (path) => {
				removed.push(path);
			},
		});
		await expect(installTailnet(SIGNAL, deps)).rejects.toMatchObject({
			code: "TAILNET_INSTALL_FAILED",
		});
		expect(calls).toHaveLength(0);
		expect(removed).toEqual(["/tmp/vcp-tailnet-install"]);
	});

	it("Windows 使用官方 MSI 静默参数，且不含任何 auth key 参数", async () => {
		const { deps, calls, downloads } = makeDeps({
			platform: "win32",
			osRelease: {},
			sha256File: async () => TAILNET_ARTIFACT_SHA256.windows,
		});
		await installTailnet(SIGNAL, deps);
		expect(downloads).toEqual([
			"https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi",
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("msiexec");
		const args = calls[0]?.args ?? [];
		expect(args).toContain("/qn");
		expect(args).toContain("/norestart");
		expect(args).toContain("TS_NOLAUNCH=1");
		expect(args.join(" ")).not.toContain("auth-key");
		expect(args[1]).toBe(join("/tmp/vcp-tailnet-install", "tailscale-setup-1.104.5-amd64.msi"));
	});

	it("MSI 返回 3010 时明确要求重启而不是继续", async () => {
		const { deps } = makeDeps({
			platform: "win32",
			osRelease: {},
			sha256File: async () => TAILNET_ARTIFACT_SHA256.windows,
			run: async () => ({ code: 3010, stdout: "" }),
		});
		await expect(installTailnet(SIGNAL, deps)).rejects.toMatchObject({
			code: "TAILNET_INSTALL_REBOOT_REQUIRED",
		});
	});

	it("tar 成员含绝对路径或 .. 时拒绝解压", async () => {
		let placed = false;
		const { deps, calls } = makeDeps({
			run: async (command, args) => {
				calls.push({ command, args });
				if (command === "tar" && args[0] === "-tvzf") {
					return { code: 0, stdout: "lrwxrwxrwx 0/0 0 2026-01-01 ../../etc/passwd\n" };
				}
				return { code: 0, stdout: "" };
			},
			placeLinuxFiles: async () => {
				placed = true;
			},
		});
		await expect(installTailnet(SIGNAL, deps)).rejects.toMatchObject({
			code: "TAILNET_INSTALL_FAILED",
		});
		expect(calls.some((call) => call.args[0] === "-xzf")).toBe(false);
		expect(placed).toBe(false);
	});

	it("Linux 校验成员后解压、落盘并启用服务", async () => {
		const { deps, calls } = makeDeps();
		await installTailnet(SIGNAL, deps);
		expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
			["tar", "-tvzf"],
			["tar", "-xzf"],
			["systemctl", "enable"],
		]);
		expect(calls[2]?.args).toEqual(["enable", "--now", "tailscaled"]);
	});

	it("非 root 账户启用服务时经 escalate 提权执行", async () => {
		const { deps, calls } = makeDeps({
			escalate: (command, args) => privileged(command, args, "linux", 999),
		});
		await installTailnet(SIGNAL, deps);
		expect(calls[calls.length - 1]).toEqual({
			command: "sudo",
			args: ["-n", "systemctl", "enable", "--now", "tailscaled"],
		});
	});
});

describe("Linux 落盘计划", () => {
	/** 1.104.5 官方 tarball 内 tailscaled.service 的关键内容。 */
	const OFFICIAL_UNIT = `[Unit]
Description=Tailscale node agent

[Service]
EnvironmentFile=/etc/default/tailscaled
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=\${PORT} $FLAGS
ExecStopPost=/usr/sbin/tailscaled --cleanup

[Install]
WantedBy=multi-user.target
`;

	it("守护进程按 unit 的 ExecStart 路径落盘，而不是一律放进 /usr/local/bin", () => {
		expect(tailscaledDaemonPath(OFFICIAL_UNIT)).toBe("/usr/sbin/tailscaled");
		const daemon = linuxInstallPlan(OFFICIAL_UNIT).find(
			(file) => file.source === "tailscaled",
		);
		expect(daemon).toEqual({
			source: "tailscaled",
			target: "/usr/sbin/tailscaled",
			mode: "0755",
		});
	});

	it("落盘路径与 unit 的 ExecStart、ExecStopPost 保持一致", () => {
		const target =
			linuxInstallPlan(OFFICIAL_UNIT).find((file) => file.source === "tailscaled")
				?.target ?? "";
		expect(OFFICIAL_UNIT).toContain(`ExecStart=${target} `);
		expect(OFFICIAL_UNIT).toContain(`ExecStopPost=${target} `);
	});

	it("补齐 EnvironmentFile 指向的 /etc/default/tailscaled", () => {
		expect(OFFICIAL_UNIT).toContain("EnvironmentFile=/etc/default/tailscaled");
		expect(linuxInstallPlan(OFFICIAL_UNIT)).toContainEqual({
			source: "systemd/tailscaled.defaults",
			target: "/etc/default/tailscaled",
			mode: "0644",
		});
	});

	it("固定落盘目标覆盖 CLI、unit 与 defaults", () => {
		expect(linuxInstallPlan(OFFICIAL_UNIT).map((file) => file.target)).toEqual([
			"/usr/sbin/tailscaled",
			"/usr/local/bin/tailscale",
			"/etc/systemd/system/tailscaled.service",
			"/etc/default/tailscaled",
		]);
	});

	it("unit 换路径时跟随，解析不到绝对路径时按官方布局回退", () => {
		expect(
			tailscaledDaemonPath("[Service]\nExecStart=/opt/ts/tailscaled --cleanup\n"),
		).toBe("/opt/ts/tailscaled");
		expect(tailscaledDaemonPath("[Service]\nExecStart=tailscaled\n")).toBe(
			"/usr/sbin/tailscaled",
		);
		expect(tailscaledDaemonPath("")).toBe("/usr/sbin/tailscaled");
	});
});
