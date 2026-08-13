import { describe, expect, it } from "vitest";
import { probeTerminalCapability, type TerminalCapabilityEnv } from "./capability.js";

describe("probeTerminalCapability", () => {
	it("node-pty 可加载时声明 backend=conpty（Windows）", async () => {
		const env: TerminalCapabilityEnv = {
			platform: "win32",
			loadPty: async () => ({ spawn: () => ({}) }),
		};
		const status = await probeTerminalCapability(env);
		expect(status.available).toBe(true);
		expect(status.backend).toBe("conpty");
		expect(status.code).toBeUndefined();
	});

	it("node-pty 可加载时声明 backend=pty（Linux）", async () => {
		const env: TerminalCapabilityEnv = {
			platform: "linux",
			loadPty: async () => ({ spawn: () => ({}) }),
		};
		const status = await probeTerminalCapability(env);
		expect(status.available).toBe(true);
		expect(status.backend).toBe("pty");
	});

	it("动态 import 失败返回稳定错误且不抛异常", async () => {
		const env: TerminalCapabilityEnv = {
			platform: "win32",
			loadPty: async () => {
				throw new Error("Cannot find module 'node-pty'");
			},
		};
		const status = await probeTerminalCapability(env);
		expect(status.available).toBe(false);
		expect(status.code).toBe("TERMINAL_NATIVE_BACKEND_UNAVAILABLE");
	});

	it("模块缺少 spawn 时视为不可用", async () => {
		const env: TerminalCapabilityEnv = {
			platform: "win32",
			loadPty: async () => null,
		};
		const status = await probeTerminalCapability(env);
		expect(status.available).toBe(false);
		expect(status.code).toBe("TERMINAL_NATIVE_BACKEND_UNAVAILABLE");
	});

	it("错误消息不包含本地路径或 stack", async () => {
		const env: TerminalCapabilityEnv = {
			platform: "win32",
			loadPty: async () => {
				throw new Error("D:\\secret\\node-pty.node load failed at line 42");
			},
		};
		const status = await probeTerminalCapability(env);
		expect(status.message ?? "").not.toContain("D:\\");
		expect(status.message ?? "").not.toContain("secret");
		expect(status.message ?? "").not.toContain("line 42");
	});
});
