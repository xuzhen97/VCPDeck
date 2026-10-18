import { describe, expect, it } from "vitest";
import {
	hasClientAnnotations,
	parseClientAnnotations,
	parseClientAnnotationsInput,
} from "./client-annotations.js";

const validInput = {
	publicAddress: {
		v4: ["1.2.3.4"],
		v6: ["2001:db8::1"],
		host: "nas.example.com",
	},
	notes: "  动态 IP，靠 DDNS  \n",
};

describe("parseClientAnnotationsInput", () => {
	it("解析完整输入并去除备注首尾空白", () => {
		expect(parseClientAnnotationsInput(validInput)).toEqual({
			publicAddress: {
				v4: ["1.2.3.4"],
				v6: ["2001:db8::1"],
				host: "nas.example.com",
			},
			notes: "动态 IP，靠 DDNS",
		});
	});

	it("空对象表示未声明，且可单独声明无公网地址", () => {
		expect(parseClientAnnotationsInput({})).toEqual({
			publicAddress: null,
			notes: null,
		});
		expect(parseClientAnnotationsInput({ publicAddress: {} })).toEqual({
			publicAddress: { v4: [], v6: [], host: null },
			notes: null,
		});
	});

	it("拒绝未知字段", () => {
		expect(() => parseClientAnnotationsInput({ tags: ["prod"] })).toThrow(
			"未知字段",
		);
	});

	it("拒绝非法 IPv4 与 IPv6", () => {
		for (const ip of ["256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5"]) {
			expect(() =>
				parseClientAnnotationsInput({ publicAddress: { v4: [ip] } }),
			).toThrow("IPv4");
		}
		for (const ip of [
			"2001:db8:::1",
			"not-an-ip",
			"fe80::1%eth0",
			"::1]/@evil.com",
			"::1]/foo\nbar",
			"::1]?x",
			`::1]/${"A".repeat(5000)}`,
		]) {
			expect(() =>
				parseClientAnnotationsInput({ publicAddress: { v6: [ip] } }),
			).toThrow("IPv6");
		}
	});

	it("拒绝重复地址与超过上限", () => {
		expect(() =>
			parseClientAnnotationsInput({
				publicAddress: { v4: ["1.2.3.4", "1.2.3.4"] },
			}),
		).toThrow("重复");
		expect(() =>
			parseClientAnnotationsInput({
				publicAddress: {
					v4: ["1.1.1.1", "1.1.1.2", "1.1.1.3", "1.1.1.4", "1.1.1.5"],
				},
			}),
		).toThrow("最多");
	});

	it("拒绝非法域名与过长备注", () => {
		expect(() =>
			parseClientAnnotationsInput({
				publicAddress: { host: "https://example.com" },
			}),
		).toThrow("域名");
		expect(() =>
			parseClientAnnotationsInput({ notes: "x".repeat(1001) }),
		).toThrow("1000");
	});

	it("拒绝备注控制字符但允许换行与制表符", () => {
		expect(() =>
			parseClientAnnotationsInput({ notes: "a\u0000b" }),
		).toThrow("控制字符");
		expect(parseClientAnnotationsInput({ notes: "a\nb\tc" }).notes).toBe(
			"a\nb\tc",
		);
	});
});

describe("hasClientAnnotations", () => {
	it("空注解为 false，明确无公网或备注为 true", () => {
		expect(
			hasClientAnnotations({ publicAddress: null, notes: null }),
		).toBe(false);
		expect(
			hasClientAnnotations({
				publicAddress: { v4: [], v6: [], host: null },
				notes: null,
			}),
		).toBe(true);
		expect(
			hasClientAnnotations({ publicAddress: null, notes: "仅备注" }),
		).toBe(true);
	});
});

describe("parseClientAnnotations", () => {
	it("解析 Server 存储的完整读模型并规范化时间", () => {
		expect(
			parseClientAnnotations({
				...validInput,
				updatedAt: "2026-10-18T02:00:00Z",
			}),
		).toEqual({
			publicAddress: validInput.publicAddress,
			notes: "动态 IP，靠 DDNS",
			updatedAt: "2026-10-18T02:00:00.000Z",
		});
	});

	it("空对象表示没有注解", () => {
		expect(parseClientAnnotations({})).toBeNull();
	});

	it("缺少或非法 updatedAt 时拒绝", () => {
		expect(() =>
			parseClientAnnotations({ publicAddress: null, notes: "x" }),
		).toThrow("updatedAt");
		expect(() =>
			parseClientAnnotations({
				publicAddress: null,
				notes: "x",
				updatedAt: "not-a-date",
			}),
		).toThrow("updatedAt");
	});

	it("拒绝未知字段", () => {
		expect(() =>
			parseClientAnnotations({
				...validInput,
				updatedAt: "2026-10-18T02:00:00.000Z",
				updatedBy: {},
			}),
		).toThrow("未知字段");
	});
});
