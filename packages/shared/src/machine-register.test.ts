import { describe, expect, it } from "vitest";
import {
	parseMachineInstallation,
	parseMachineRegister,
	parsePrivilegedCapabilityStatus,
	type MachineRegister,
} from "./machine-register.js";

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
});
