import { describe, expect, it } from "vitest";
import {
	detectInstallationInfo,
	probePrivilegedCapability,
	type InstallationProbeEnv,
	type PrivilegedProbeEnv,
} from "./privileged-capability.js";

/** 构造可注入的特权探测环境（不触达真实 sudo / 系统账户）。 */
function makePrivilegedEnv(opts: {
	platform?: NodeJS.Platform;
	username?: string;
	sudoStatus?: number;
	sudoThrows?: boolean;
	windowsIdentity?: string;
	windowsIdentityThrows?: boolean;
}): PrivilegedProbeEnv {
	return {
		platform: opts.platform ?? "linux",
		currentUser: () => opts.username ?? "vcpdeck",
		runNonInteractiveSudo: async () => {
			if (opts.sudoThrows) throw new Error("spawn failed");
			return opts.sudoStatus ?? 1;
		},
		runWindowsIdentity: async () => {
			if (opts.windowsIdentityThrows) throw new Error("spawn failed");
			return opts.windowsIdentity ?? "";
		},
	};
}

describe("probePrivilegedCapability", () => {
	it("Linux 免密 sudo 成功 → sudo-all 可用", async () => {
		expect(await probePrivilegedCapability(makePrivilegedEnv({ sudoStatus: 0 }))).toEqual({
			available: true,
			mode: "sudo-all",
			nonInteractive: true,
			runAsUser: "vcpdeck",
		});
	});

	it("Linux 免密 sudo 失败 → unavailable（不声明 root 等价）", async () => {
		expect(await probePrivilegedCapability(makePrivilegedEnv({ sudoStatus: 1 }))).toEqual({
			available: false,
			mode: "unavailable",
			nonInteractive: false,
			runAsUser: "vcpdeck",
		});
	});

	it("sudo 执行抛错 → unavailable（失败关闭）", async () => {
		expect(await probePrivilegedCapability(makePrivilegedEnv({ sudoThrows: true }))).toEqual({
			available: false,
			mode: "unavailable",
			nonInteractive: false,
			runAsUser: "vcpdeck",
		});
	});

	it("非 Windows/Linux 返回 undefined（未报告）", async () => {
		expect(await probePrivilegedCapability(makePrivilegedEnv({ platform: "darwin" }))).toBeUndefined();
	});

	it("Windows SYSTEM 身份 → windows-system 可用（ADR-0027）", async () => {
		expect(
			await probePrivilegedCapability(
				makePrivilegedEnv({ platform: "win32", windowsIdentity: "NT AUTHORITY\\SYSTEM" }),
			),
		).toEqual({
			available: true,
			mode: "windows-system",
			nonInteractive: true,
			runAsUser: "SYSTEM",
		});
	});

	it("Windows 管理员账户（非 SYSTEM）→ unavailable，不声明 root 等价", async () => {
		expect(
			await probePrivilegedCapability(
				makePrivilegedEnv({ platform: "win32", windowsIdentity: "HOST\\Administrator" }),
			),
		).toEqual({
			available: false,
			mode: "unavailable",
			nonInteractive: false,
			runAsUser: "HOST\\Administrator",
		});
	});

	it("Windows whoami 失败 → unavailable（失败关闭）", async () => {
		const status = await probePrivilegedCapability(
			makePrivilegedEnv({ platform: "win32", windowsIdentityThrows: true }),
		);
		expect(status).toEqual({
			available: false,
			mode: "unavailable",
			nonInteractive: false,
			runAsUser: "unknown",
		});
	});

	it("当前用户名缺失时回退 unknown，仍不泄露路径", async () => {
		const status = await probePrivilegedCapability(
			makePrivilegedEnv({ username: "", sudoStatus: 0 }),
		);
		expect(status?.runAsUser).toBe("unknown");
		expect(JSON.stringify(status)).not.toContain("C:\\");
	});
});

describe("detectInstallationInfo", () => {
	const linuxNoMode: InstallationProbeEnv = { platform: "linux", installationMode: undefined };
	const linuxA2: InstallationProbeEnv = {
		platform: "linux",
		installationMode: "systemd-root-equivalent",
	};
	const win: InstallationProbeEnv = { platform: "win32", installationMode: undefined };

	it("Linux 无 A2 模式变量 → legacy-pm2（待迁移）", () => {
		expect(detectInstallationInfo(linuxNoMode)).toEqual({ mode: "legacy-pm2" });
	});

	it("Linux A2 模式变量 → systemd-root-equivalent", () => {
		expect(detectInstallationInfo(linuxA2)).toEqual({ mode: "systemd-root-equivalent" });
	});

	it("Linux 未知模式变量 → 按 legacy-pm2 处理（不猜测 A2）", () => {
		expect(
			detectInstallationInfo({ platform: "linux", installationMode: "weird" }),
		).toEqual({ mode: "legacy-pm2" });
	});

	it("Windows A2 模式变量 → windows-system-task（ADR-0027）", () => {
		expect(detectInstallationInfo({ platform: "win32", installationMode: "windows-system-task" })).toEqual({
			mode: "windows-system-task",
		});
	});

	it("Windows 其他/未报告 → legacy-pm2（待迁移）", () => {
		expect(detectInstallationInfo(win)).toEqual({ mode: "legacy-pm2" });
		expect(detectInstallationInfo({ platform: "win32", installationMode: "weird" })).toEqual({
			mode: "legacy-pm2",
		});
	});

	it("非 Windows/Linux 返回 undefined（未报告）", () => {
		expect(detectInstallationInfo({ platform: "darwin" })).toBeUndefined();
	});
});
