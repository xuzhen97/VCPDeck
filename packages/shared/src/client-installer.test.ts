import { describe, expect, it } from "vitest";
import {
	parseClientInstallerConfigUpdate,
	parseClientInstallerNameUpdate,
	parseClientInstallerPlatform,
} from "./client-installer.js";

describe("Client Installer parsers", () => {
	it("严格解析平台", () => {
		expect(parseClientInstallerPlatform("win-x64")).toBe("win-x64");
		expect(() => parseClientInstallerPlatform("linux-arm64")).toThrow();
	});

	it("配置更新拒绝未知字段", () => {
		expect(parseClientInstallerConfigUpdate({ enabled: true })).toEqual({
			enabled: true,
		});
		expect(() =>
			parseClientInstallerConfigUpdate({ enabled: true, extra: 1 }),
		).toThrow();
	});

	it("名称更新裁剪空白并限制长度", () => {
		expect(parseClientInstallerNameUpdate({ name: " build-1 " })).toEqual({
			name: "build-1",
		});
		expect(() => parseClientInstallerNameUpdate({ name: "" })).toThrow();
	});
});

describe("一键安装平台边界（ADR-0065）", () => {
	it("musl Client 走独立的 procd 安装器，平台解析接受三项", () => {
		expect(parseClientInstallerPlatform("linux-x64")).toBe("linux-x64");
		expect(parseClientInstallerPlatform("linux-x64-musl")).toBe(
			"linux-x64-musl",
		);
		expect(() => parseClientInstallerPlatform("linux-arm64")).toThrow();
		expect(() => parseClientInstallerPlatform("linux-x64-glibc")).toThrow();
	});
});
