import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRP_RECONCILE_PROTOCOL_VERSION, VERSION } from "@vcpdeck/shared";
import { getRegisterInfo } from "./register.js";
import type {
	PiCapabilityStatus,
	TerminalCapabilityStatus,
} from "@vcpdeck/shared";

let root = "";

beforeEach(() => {
	// 提供假 frpc 可执行文件，使 isFrpAvailable() 可确定；
	// 固定 CLIENT_ID 避免 register 读写 ~/.vcpdeck/client-id。
	root = mkdtempSync(join(tmpdir(), "vcpdeck-register-"));
	const executable = join(root, "frpc.exe");
	writeFileSync(executable, "test");
	process.env.VCPDECK_FRPC_PATH = executable;
	process.env.VCPDECK_CLIENT_ID = "test-client";
});

afterEach(() => {
	delete process.env.VCPDECK_FRPC_PATH;
	delete process.env.VCPDECK_CLIENT_ID;
	rmSync(root, { recursive: true, force: true });
});

describe("getRegisterInfo", () => {
	it("注册版本取构建注入的 VERSION（供服务端版本比对与补更）", () => {
		const info = getRegisterInfo();
		expect(info.clientVersion).toBe(VERSION);
	});

	it("frpc 可用时声明 frp 能力与 protocol v1", () => {
		const info = getRegisterInfo(undefined, undefined);
		expect(info.capabilities).toContain("frp");
		expect(info.capabilityDetails?.frp).toEqual({
			available: true,
			reconcileProtocolVersion: FRP_RECONCILE_PROTOCOL_VERSION,
		});
	});

	it("frpc 缺失时只声明不可用原因，不声明 frp 能力", () => {
		const saved = process.env.VCPDECK_FRPC_PATH;
		delete process.env.VCPDECK_FRPC_PATH;
		try {
			const info = getRegisterInfo(undefined, undefined);
			expect(info.capabilities).not.toContain("frp");
			expect(info.capabilityDetails?.frp).toEqual({
				available: false,
				code: "FRPC_NOT_FOUND",
			});
		} finally {
			if (saved !== undefined) process.env.VCPDECK_FRPC_PATH = saved;
		}
	});
	it("可用状态包含 agent.pi 及安全 details", () => {
		const status: PiCapabilityStatus = {
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
		};
		const info = getRegisterInfo(status);
		expect(info.capabilities).toContain("agent.pi");
		expect(info.capabilities).not.toContain("pi.probe");
		expect(info.capabilityDetails?.pi).toMatchObject({ available: true });
	});

	it("不可用状态不声明 Pi 能力，仅保留 details 原因", () => {
		const status: PiCapabilityStatus = {
			available: false,
			code: "PI_BASH_NOT_FOUND",
			message: "no bash",
		};
		const info = getRegisterInfo(status);
		expect(info.capabilities).not.toContain("pi.probe");
		expect(info.capabilities).not.toContain("agent.pi");
		expect(info.capabilityDetails?.pi).toMatchObject({ available: false });
	});

	it("无探测时不声明 Pi 能力（frp details 独立存在）", () => {
		const info = getRegisterInfo(undefined);
		expect(info.capabilities).not.toContain("pi.probe");
		expect(info.capabilities).not.toContain("agent.pi");
		expect(info.capabilityDetails?.pi).toBeUndefined();
		expect(info.capabilityDetails?.terminal).toBeUndefined();
		expect(info.capabilityDetails?.frp).toMatchObject({ available: true });
	});

	it("终端可用时声明 terminal.pty 并携带安全 details", () => {
		const terminalStatus: TerminalCapabilityStatus = {
			available: true,
			backend: "conpty",
		};
		const info = getRegisterInfo(undefined, terminalStatus);
		expect(info.capabilities).toContain("terminal.pty");
		expect(info.capabilityDetails?.terminal).toMatchObject({ available: true });
	});

	it("终端不可用时只保留 details 原因，不声明能力", () => {
		const terminalStatus: TerminalCapabilityStatus = {
			available: false,
			code: "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
			message: "no backend",
		};
		const info = getRegisterInfo(undefined, terminalStatus);
		expect(info.capabilities).not.toContain("terminal.pty");
		expect(info.capabilityDetails?.terminal).toMatchObject({
			available: false,
		});
	});

	it("无终端探测时不声明能力", () => {
		const info = getRegisterInfo(undefined, undefined);
		expect(info.capabilities).not.toContain("terminal.pty");
		expect(info.capabilityDetails?.terminal).toBeUndefined();
	});

	it("序列化结果不包含本地路径或凭据", () => {
		const status: PiCapabilityStatus = {
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "configured",
		};
		vi.spyOn(require("node:os"), "homedir").mockReturnValue(
			"C:\\Users\\secret-user",
		);
		const info = getRegisterInfo(status);
		expect(JSON.stringify(info)).not.toContain("secret-user");
		expect(JSON.stringify(info)).not.toContain("C:\\");
		vi.restoreAllMocks();
	});
});
