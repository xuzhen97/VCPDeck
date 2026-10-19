import { describe, expect, it } from "vitest";
import {
	DSH_WEB_URL_MAX_LENGTH,
	parseClientDshWebUrl,
} from "./client-dsh-web.js";

describe("远程 DSH 地址解析（ADR-0059）", () => {
	it("接受 http/https 并规范化", () => {
		expect(parseClientDshWebUrl("https://dsh.example.com/?token=abc")).toBe(
			"https://dsh.example.com/?token=abc",
		);
		expect(parseClientDshWebUrl("  http://10.0.0.5:7800/  ")).toBe(
			"http://10.0.0.5:7800/",
		);
	});

	it("null 与空串表示清除登记", () => {
		expect(parseClientDshWebUrl(null)).toBeNull();
		expect(parseClientDshWebUrl("")).toBeNull();
		expect(parseClientDshWebUrl("   ")).toBeNull();
	});

	it("拒绝非 http(s) 协议与内嵌凭据", () => {
		expect(() => parseClientDshWebUrl("javascript:alert(1)")).toThrow();
		expect(() => parseClientDshWebUrl("file:///c:/secret")).toThrow();
		expect(() => parseClientDshWebUrl("https://u:p@dsh.example.com/")).toThrow();
	});

	it("拒绝非法 URL 与超长地址", () => {
		expect(() => parseClientDshWebUrl("not a url")).toThrow();
		expect(() =>
			parseClientDshWebUrl(`https://a.example/${"x".repeat(DSH_WEB_URL_MAX_LENGTH)}`),
		).toThrow();
		expect(() => parseClientDshWebUrl(42)).toThrow();
	});
});
