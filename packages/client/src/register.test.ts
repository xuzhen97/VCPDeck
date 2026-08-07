import { describe, expect, it, vi } from "vitest";
import { getRegisterInfo } from "./register.js";
import type { PiCapabilityStatus } from "@vcpdeck/shared";

describe("getRegisterInfo", () => {
	it("可用状态包含 pi.probe 与 agent.pi 及安全 details", () => {
		const status: PiCapabilityStatus = {
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
		};
		const info = getRegisterInfo(status);
		expect(info.capabilities).toContain("pi.probe");
		expect(info.capabilities).toContain("agent.pi");
		expect(info.capabilityDetails?.pi).toMatchObject({ available: true });
	});

	it("不可用状态只包含 pi.probe", () => {
		const status: PiCapabilityStatus = {
			available: false,
			code: "PI_BASH_NOT_FOUND",
			message: "no bash",
		};
		const info = getRegisterInfo(status);
		expect(info.capabilities).toContain("pi.probe");
		expect(info.capabilities).not.toContain("agent.pi");
		expect(info.capabilityDetails?.pi).toMatchObject({ available: false });
	});

	it("无探测时不声明 Pi 能力", () => {
		const info = getRegisterInfo(undefined);
		expect(info.capabilities).not.toContain("pi.probe");
		expect(info.capabilities).not.toContain("agent.pi");
		expect(info.capabilityDetails).toBeUndefined();
	});

	it("序列化结果不包含本地路径或凭据", () => {
		const status: PiCapabilityStatus = {
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "configured",
		};
		vi.spyOn(require("node:os"), "homedir").mockReturnValue("C:\\Users\\secret-user");
		const info = getRegisterInfo(status);
		expect(JSON.stringify(info)).not.toContain("secret-user");
		expect(JSON.stringify(info)).not.toContain("C:\\");
		vi.restoreAllMocks();
	});
});
