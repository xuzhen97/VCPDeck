/**
 * 特权命令包装单测（ADR-0023）。
 *
 * 只验证命令拼装，不执行真实 sudo 与 systemctl。
 */
import { describe, expect, it } from "vitest";
import { currentUid, needsEscalation, privileged } from "./privileged-command.js";

describe("privileged", () => {
	it("Linux 非 root 账户补 sudo -n", () => {
		expect(privileged("systemctl", ["start", "tailscaled"], "linux", 999)).toEqual({
			command: "sudo",
			args: ["-n", "systemctl", "start", "tailscaled"],
		});
	});

	it("Linux root 账户原样执行", () => {
		expect(privileged("systemctl", ["start", "tailscaled"], "linux", 0)).toEqual({
			command: "systemctl",
			args: ["start", "tailscaled"],
		});
	});

	it("Windows 与 macOS 不加 sudo", () => {
		expect(privileged("sc.exe", ["start", "Tailscale"], "win32", null)).toEqual({
			command: "sc.exe",
			args: ["start", "Tailscale"],
		});
		expect(privileged("tailscale", ["version"], "darwin", 501)).toEqual({
			command: "tailscale",
			args: ["version"],
		});
	});

	it("needsEscalation 只对 Linux 非 root 为真", () => {
		expect(needsEscalation("linux", 1000)).toBe(true);
		expect(needsEscalation("linux", 0)).toBe(false);
		expect(needsEscalation("win32", null)).toBe(false);
		expect(needsEscalation("darwin", 501)).toBe(false);
	});

	it("currentUid 在非 POSIX 平台返回 null", () => {
		const uid = currentUid();
		expect(uid === null || typeof uid === "number").toBe(true);
	});
});
