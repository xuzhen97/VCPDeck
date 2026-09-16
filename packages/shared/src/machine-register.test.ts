import { describe, expect, it } from "vitest";
import {
	getClientInstallationCompliance,
	parseMachineInstallation,
	parseMachineRegister,
	parsePrivilegedCapabilityStatus,
	type ClientInstallationCompliance,
	type MachineRegister,
} from "./machine-register.js";

type ComplianceFixture = Parameters<typeof getClientInstallationCompliance>[0];

/** 构造一份合法的新 Client 注册消息（含 ADR-0023 新增字段）。 */
function validRegister(overrides: Partial<MachineRegister> = {}): MachineRegister {
	const base: MachineRegister = {
		clientId: "67f965a4-e3cf-43ba-8d84-70e14cda864c",
		hostname: "xuzhen97-bazzite",
		os: "linux 6.11.0",
		cpuModel: "AMD Ryzen 7 5800X",
		totalMemMB: 32000,
		clientVersion: "0.6.15",
		capabilities: ["exec", "file.read", "file.write"],
		capabilityDetails: {
			frp: { available: true, reconcileProtocolVersion: 1 },
			privileged: {
				available: true,
				mode: "sudo-all",
				nonInteractive: true,
				runAsUser: "vcpdeck",
			},
		},
		installation: { mode: "systemd-root-equivalent" },
	};
	return { ...base, ...overrides };
}

describe("parseMachineRegister", () => {
	it("接受含 privileged + installation 的新 Client 注册", () => {
		const parsed = parseMachineRegister(validRegister());
		expect(parsed.installation).toEqual({ mode: "systemd-root-equivalent" });
		expect(parsed.capabilityDetails?.privileged).toMatchObject({
			available: true,
			mode: "sudo-all",
			nonInteractive: true,
			runAsUser: "vcpdeck",
		});
	});

	it("接受不含新增字段的旧 Client 注册（缺省即未报告）", () => {
		const parsed = parseMachineRegister(
			validRegister({ capabilityDetails: { frp: { available: false, code: "FRPC_NOT_FOUND" } }, installation: undefined }),
		);
		expect(parsed.installation).toBeUndefined();
		expect(parsed.capabilityDetails?.privileged).toBeUndefined();
		expect(parsed.capabilityDetails?.frp).toEqual({ available: false, code: "FRPC_NOT_FOUND" });
	});

	it("拒绝 capabilityDetails 中的未知字段", () => {
		expect(() =>
			parseMachineRegister(
				validRegister({
					capabilityDetails: {
						frp: { available: false, code: "FRPC_NOT_FOUND" },
						unknown: true,
					} as unknown as MachineRegister["capabilityDetails"],
				}),
			),
		).toThrow();
	});

	it("拒绝 capabilityDetails 不是对象", () => {
		expect(() =>
						parseMachineRegister(
							validRegister({
								capabilityDetails: ["frp"] as unknown as MachineRegister["capabilityDetails"],
							}),
						),
		).toThrow();
	});

	it("拒绝 privileged 非法 mode", () => {
		expect(() =>
			parseMachineRegister(
				validRegister({
					capabilityDetails: {
						privileged: {
							available: true,
							mode: "root",
							nonInteractive: true,
							runAsUser: "vcpdeck",
						} as never,
					},
				}),
			),
		).toThrow();
	});

	it("拒绝 privileged 非布尔 nonInteractive / 缺失 runAsUser / 超长 runAsUser", () => {
		const bad = [
			{ available: true, mode: "sudo-all", nonInteractive: "yes", runAsUser: "vcpdeck" },
			{ available: true, mode: "sudo-all", nonInteractive: true },
			{ available: true, mode: "sudo-all", nonInteractive: true, runAsUser: "x".repeat(257) },
			{ available: false, mode: "unavailable" },
		];
		for (const privileged of bad) {
			expect(() =>
				parseMachineRegister({
					...validRegister(),
					capabilityDetails: { privileged: privileged as never },
				}),
			).toThrow();
		}
	});

	it("拒绝 installation 非法 mode 或非对象", () => {
		expect(() =>
			parseMachineRegister(validRegister({ installation: { mode: "pm2" } as never })),
		).toThrow();
		expect(() =>
			parseMachineRegister(validRegister({ installation: "systemd" as never })),
		).toThrow();
	});

	it("拒绝核心字段类型错误：clientId 非字符串 / totalMemMB 非数字 / capabilities 非数组", () => {
		expect(() =>
			parseMachineRegister(validRegister({ clientId: 0 as never })),
		).toThrow();
		expect(() =>
			parseMachineRegister(validRegister({ totalMemMB: "32000" as never })),
		).toThrow();
		expect(() =>
			parseMachineRegister(validRegister({ capabilities: "exec" as never })),
		).toThrow();
	});

	it("拒绝 capabilities 超长条目与超量数组", () => {
		expect(() =>
			parseMachineRegister(
				validRegister({ capabilities: ["x".repeat(65)] }),
			),
		).toThrow();
		expect(() =>
			parseMachineRegister(
				validRegister({ capabilities: Array.from({ length: 101 }, (_, i) => `cap${i}`) }),
			),
		).toThrow();
	});
});

describe("parsePrivilegedCapabilityStatus", () => {
	it("接受 sudo-all 与 unavailable 两种合法形态", () => {
		expect(
			parsePrivilegedCapabilityStatus({
				available: true,
				mode: "sudo-all",
				nonInteractive: true,
				runAsUser: "vcpdeck",
			}),
		).toMatchObject({ available: true, mode: "sudo-all" });
		expect(
			parsePrivilegedCapabilityStatus({
				available: false,
				mode: "unavailable",
				nonInteractive: false,
				runAsUser: "xuzhen97",
			}),
		).toMatchObject({ available: false, mode: "unavailable" });
	});

	it("拒绝未知字段", () => {
		expect(() =>
			parsePrivilegedCapabilityStatus({
				available: true,
				mode: "sudo-all",
				nonInteractive: true,
				runAsUser: "vcpdeck",
				extra: 1,
			}),
		).toThrow();
	});
});

describe("parseMachineInstallation", () => {
	it("接受 systemd-root-equivalent 并拒绝其他取值", () => {
		expect(parseMachineInstallation({ mode: "systemd-root-equivalent" })).toEqual({
			mode: "systemd-root-equivalent",
		});
		expect(() => parseMachineInstallation({ mode: "pm2" })).toThrow();
		expect(() => parseMachineInstallation({})).toThrow();
		expect(() => parseMachineInstallation(null)).toThrow();
	});

	it("接受 windows-system-task 安装模式（ADR-0027）", () => {
		expect(parseMachineInstallation({ mode: "windows-system-task" })).toEqual({
			mode: "windows-system-task",
		});
		expect(() => parseMachineInstallation({ mode: "windows-logon-task" })).toThrow();
	});
});

describe("parsePrivilegedCapabilityStatus windows-system", () => {
	it("接受合规的 SYSTEM 身份摘要", () => {
		expect(
			parsePrivilegedCapabilityStatus({
				available: true,
				mode: "windows-system",
				nonInteractive: true,
				runAsUser: "SYSTEM",
			}),
		).toEqual({
			available: true,
			mode: "windows-system",
			nonInteractive: true,
			runAsUser: "SYSTEM",
		});
	});

	it("拒绝 windows-system 声明不可用或交互执行", () => {
		expect(() =>
			parsePrivilegedCapabilityStatus({
				available: false,
				mode: "windows-system",
				nonInteractive: false,
				runAsUser: "SYSTEM",
			}),
		).toThrow(/windows-system/);
		expect(() =>
			parsePrivilegedCapabilityStatus({
				available: true,
				mode: "windows-system",
				nonInteractive: false,
				runAsUser: "SYSTEM",
			}),
		).toThrow(/windows-system/);
	});
});

describe("getClientInstallationCompliance（ADR-0027 合规矩阵）", () => {
	const client = (
		os: string,
		mode: "systemd-root-equivalent" | "windows-system-task" | "legacy-pm2" | undefined,
		privileged: { available: boolean; mode: "sudo-all" | "windows-system" | "unavailable"; nonInteractive: boolean; runAsUser: string } | undefined,
	): ComplianceFixture => ({
		os,
		installation: mode === undefined ? undefined : { mode },
		capabilityDetails: privileged === undefined ? undefined : { privileged },
	});

	type CompliancePriv = { available: boolean; mode: "sudo-all" | "windows-system" | "unavailable"; nonInteractive: boolean; runAsUser: string };
	const sudoAll: CompliancePriv = { available: true, mode: "sudo-all", nonInteractive: true, runAsUser: "vcpdeck" };
	const winSystem: CompliancePriv = { available: true, mode: "windows-system", nonInteractive: true, runAsUser: "SYSTEM" };

	const cases: [
		string,
		ComplianceFixture,
		boolean,
		ClientInstallationCompliance["reason"],
	][] = [
		["Windows 系统任务 + SYSTEM 合规", client("win32 10.0", "windows-system-task", winSystem), true, null],
		["Linux systemd + sudo-all 合规", client("linux 6.8", "systemd-root-equivalent", sudoAll), true, null],
		["旧 PM2 模式", client("win32 10.0", "legacy-pm2", undefined), false, "legacy-pm2"],
		["安装模式未报告", client("linux 6.8", undefined, undefined), false, "installation-unreported"],
		["特权漂移为 unavailable", client("linux 6.8", "systemd-root-equivalent", { available: false, mode: "unavailable", nonInteractive: false, runAsUser: "vcpdeck" }), false, "privilege-noncompliant"],
		["平台与模式冲突", client("win32 10.0", "systemd-root-equivalent", sudoAll), false, "platform-mode-mismatch"],
		["系统模式但特权未报告", client("linux 6.8", "systemd-root-equivalent", undefined), false, "privilege-noncompliant"],
		["未知平台不合规", client("darwin 24.0", "windows-system-task", winSystem), false, "platform-unsupported"],
		["sudo-all 但非交互探测失败", client("linux 6.8", "systemd-root-equivalent", { available: true, mode: "sudo-all", nonInteractive: false, runAsUser: "vcpdeck" }), false, "privilege-noncompliant"],
	];

	for (const [label, fixture, compliant, reason] of cases) {
		it(`${label} → ${reason ?? "compliant"}`, () => {
			const result = getClientInstallationCompliance(fixture);
			expect(result).toEqual({ compliant, reason });
		});
	}

	it("旧 Client 缺字段时不抛错，仅判未报告", () => {
		const result = getClientInstallationCompliance({ os: "win32 10.0" });
		expect(result).toEqual({ compliant: false, reason: "installation-unreported" });
	});
});

describe("parseMachineRegister p2pTunnel 能力", () => {
	it("接受新 Client 上报的 p2pTunnel v1 能力", () => {
		const parsed = parseMachineRegister(
			validRegister({
				capabilityDetails: {
					frp: { available: true, reconcileProtocolVersion: 1 },
					p2pTunnel: { available: true, protocolVersion: 1 },
				},
			}),
		);
		expect(parsed.capabilityDetails?.p2pTunnel).toEqual({ available: true, protocolVersion: 1 });
	});

	it("接受 native 后端缺失的 p2pTunnel 摘要", () => {
		const parsed = parseMachineRegister(
			validRegister({
				capabilityDetails: {
					p2pTunnel: {
						available: false,
						protocolVersion: 1,
						code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
					},
				},
			}),
		);
		expect(parsed.capabilityDetails?.p2pTunnel).toMatchObject({
			available: false,
			code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
		});
	});

	it("拒绝 p2pTunnel 未知协议版本", () => {
		expect(() =>
			parseMachineRegister(
				validRegister({
					capabilityDetails: {
						p2pTunnel: { available: true, protocolVersion: 2 } as never,
					},
				}),
			),
		).toThrow();
	});

	it("旧 Client 缺省 p2pTunnel 时保持 undefined", () => {
		const parsed = parseMachineRegister(
			validRegister({
				capabilityDetails: { frp: { available: false, code: "FRPC_NOT_FOUND" } },
			}),
		);
		expect(parsed.capabilityDetails?.p2pTunnel).toBeUndefined();
	});
});
