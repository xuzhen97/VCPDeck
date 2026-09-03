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

	it("A2 运行时安全摘要序列化：privileged + installation 上报，无路径或凭据", () => {
		const info = getRegisterInfo(
			undefined,
			undefined,
			{
				privileged: {
					available: true,
					mode: "sudo-all",
					nonInteractive: true,
					runAsUser: "vcpdeck",
				},
				installation: { mode: "systemd-root-equivalent" },
			},
		);
		expect(info.capabilityDetails?.privileged).toEqual({
			available: true,
			mode: "sudo-all",
				nonInteractive: true,
				runAsUser: "vcpdeck",
			});
		expect(info.installation).toEqual({ mode: "systemd-root-equivalent" });
		// 不新增可执行 capability 字符串。
		expect(info.capabilities).toEqual(["exec", "file.read", "file.write", "frp"]);
		const json = JSON.stringify(info);
		expect(json).not.toContain("C:\\");
		expect(json).not.toContain("/home/");
		expect(json).not.toContain("VCPDECK_PSK");
	});

	it("无运行时安全摘要时不报告 privileged 与 installation（旧 Client 语义）", () => {
		const info = getRegisterInfo();
		expect(info.capabilityDetails?.privileged).toBeUndefined();
		expect(info.installation).toBeUndefined();
	});

	it("仅 sudo 不可用（legacy Linux）时只报告 privileged=unavailable + legacy-pm2", () => {
		const info = getRegisterInfo(
			undefined,
			undefined,
			{
				privileged: {
					available: false,
					mode: "unavailable",
					nonInteractive: false,
					runAsUser: "xuzhen97",
				},
				installation: { mode: "legacy-pm2" },
			},
		);
		expect(info.capabilityDetails?.privileged).toMatchObject({ available: false });
		expect(info.installation).toEqual({ mode: "legacy-pm2" });
	});

	describe("M1 迁移验证模式（VCPDECK_MIGRATION_VERIFY_ONLY=1）", () => {
		const a2Security = {
			privileged: {
				available: true,
				mode: "sudo-all" as const,
				nonInteractive: true,
				runAsUser: "vcpdeck",
			},
			installation: { mode: "systemd-root-equivalent" } as const,
		};

		it("verify-only：不发布任何 operational 能力，但保留身份/版本/安装/特权", () => {
			const info = getRegisterInfo(undefined, undefined, a2Security, {
				...process.env,
				VCPDECK_MIGRATION_VERIFY_ONLY: "1",
			});
			// 无 operational 能力字符串。
			expect(info.capabilities).toEqual([]);
			expect(info.capabilityDetails).not.toHaveProperty("pi");
			expect(info.capabilityDetails).not.toHaveProperty("terminal");
			expect(info.capabilityDetails).not.toHaveProperty("frp");
			// 保留身份/版本/安装/特权（身份非空且稳定；具体值由模块导入期 CLIENT_ID 决定）。
			expect(typeof info.clientId).toBe("string");
			expect(info.clientId.length).toBeGreaterThan(0);
			expect(info.clientVersion).toBe(VERSION);
			expect(info.installation).toEqual({ mode: "systemd-root-equivalent" });
			expect(info.capabilityDetails?.privileged).toMatchObject({
				available: true,
				mode: "sudo-all",
			});
		});

		it("verify-only 即使探测到 Pi/Terminal/FRP 可用也不声明", () => {
			const piStatus: PiCapabilityStatus = {
				available: true,
				sdkVersion: "0.84.0",
				nodeVersion: "22.19.0",
				shellKind: "git-bash",
			};
			const terminalStatus: TerminalCapabilityStatus = {
				available: true,
				backend: "conpty",
			};
			const info = getRegisterInfo(piStatus, terminalStatus, a2Security, {
				...process.env,
				VCPDECK_MIGRATION_VERIFY_ONLY: "1",
			});
			expect(info.capabilities).toEqual([]);
			expect(info.capabilityDetails).not.toHaveProperty("pi");
			expect(info.capabilityDetails).not.toHaveProperty("terminal");
			expect(info.capabilityDetails).not.toHaveProperty("frp");
		});

		it("稳态（无 verify-only）照常发布 operational 能力", () => {
			const info = getRegisterInfo(undefined, undefined, a2Security);
			expect(info.capabilities).toContain("exec");
			expect(info.capabilityDetails).toHaveProperty("frp");
		});
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
