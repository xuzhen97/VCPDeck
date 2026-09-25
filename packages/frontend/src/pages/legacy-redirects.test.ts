import { describe, expect, it } from "vitest";
import { legacyPiTarget, machinePiTarget } from "./legacy-redirects";

describe("legacyPiTarget", () => {
	it("把旧 /pi/* 逐段映射到 Agent 模块的二级项", () => {
		expect(legacyPiTarget("/pi/profile")).toBe("/agent/profile");
		expect(legacyPiTarget("/pi/provider")).toBe("/agent/provider");
		expect(legacyPiTarget("/pi/runtime")).toBe("/agent/runtime");
	});

	it("历史别名 credentials 归到 Provider", () => {
		expect(legacyPiTarget("/pi/credentials")).toBe("/agent/provider");
	});

	it("模块根与未知段一律落到对话", () => {
		expect(legacyPiTarget("/pi")).toBe("/agent/chat");
		expect(legacyPiTarget("/pi/")).toBe("/agent/chat");
		expect(legacyPiTarget("/pi/unknown")).toBe("/agent/chat");
		expect(legacyPiTarget("/pi/sessions/abc")).toBe("/agent/chat");
	});

	it("不接受非 /pi 前缀的路径而猜测目标", () => {
		expect(legacyPiTarget("/dashboard")).toBe("/agent/chat");
	});
});

describe("machinePiTarget", () => {
	it("保留机器上下文并落到 Agent 对话", () => {
		expect(machinePiTarget("c1")).toBe("/agent/chat?client=c1");
	});

	it("缺少 clientId 时不带查询参数", () => {
		expect(machinePiTarget("")).toBe("/agent/chat");
	});

	it("对 clientId 做 URL 编码", () => {
		expect(machinePiTarget("a b")).toBe("/agent/chat?client=a%20b");
	});
});
