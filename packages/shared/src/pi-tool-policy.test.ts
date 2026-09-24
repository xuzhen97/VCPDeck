import { describe, expect, it } from "vitest";
import { PI_BUILTIN_TOOL_IDS, parsePiToolPolicy } from "./pi.js";

describe("parsePiToolPolicy", () => {
	it("接受三个互斥桶", () => {
		expect(
			parsePiToolPolicy({ allow: ["read"], confirm: ["bash"], deny: [] }),
		).toEqual({ allow: ["read"], confirm: ["bash"], deny: [] });
	});

	it("接受空策略（全部默认拒绝）", () => {
		expect(parsePiToolPolicy({ allow: [], confirm: [], deny: [] })).toEqual({
			allow: [],
			confirm: [],
			deny: [],
		});
	});

	it("拒绝跨桶重复", () => {
		expect(() =>
			parsePiToolPolicy({ allow: ["bash"], confirm: ["bash"], deny: [] }),
		).toThrow(/互斥/);
	});

	it("拒绝桶内重复", () => {
		expect(() =>
			parsePiToolPolicy({ allow: ["read", "read"], confirm: [], deny: [] }),
		).toThrow(/重复/);
	});

	it("拒绝未知工具名", () => {
		expect(() =>
			parsePiToolPolicy({ allow: ["nope"], confirm: [], deny: [] }),
		).toThrow(/未知工具/);
	});

	it("拒绝未知键", () => {
		expect(() =>
			parsePiToolPolicy({
				allow: [],
				confirm: [],
				deny: [],
				extra: 1,
			}),
		).toThrow(/未知字段/);
	});

	it("拒绝缺失桶", () => {
		expect(() => parsePiToolPolicy({ allow: [], confirm: [] })).toThrow();
	});

	it("拒绝非数组桶", () => {
		expect(() =>
			parsePiToolPolicy({ allow: "read", confirm: [], deny: [] }),
		).toThrow(/数组/);
	});

	it("拒绝非字符串成员", () => {
		expect(() =>
			parsePiToolPolicy({ allow: [1], confirm: [], deny: [] }),
		).toThrow(/字符串/);
	});

	it("拒绝非对象输入", () => {
		expect(() => parsePiToolPolicy(null)).toThrow();
		expect(() => parsePiToolPolicy([])).toThrow();
	});

	it("目录与 SDK 0.86.0 内置工具名一致（新增工具必须显式决定归属桶）", () => {
		expect([...PI_BUILTIN_TOOL_IDS].sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"powershell",
			"read",
			"write",
		]);
	});
});
