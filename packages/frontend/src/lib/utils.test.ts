import { describe, expect, it } from "vitest";
import { MACHINE_TABS, randomUUID } from "./utils";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 在 crypto 实例上遮蔽原型上的 randomUUID，模拟非安全上下文（明文 HTTP）。 */
function hideRandomUUID(): () => void {
	const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
	Object.defineProperty(crypto, "randomUUID", {
		value: undefined,
		configurable: true,
	});
	return () => {
		if (original) Object.defineProperty(crypto, "randomUUID", original);
		else Reflect.deleteProperty(crypto, "randomUUID");
	};
}

describe("MACHINE_TABS", () => {
	it("不再包含 Pi 入口（已并入全局 Agent 模块的对话视图）", () => {
		expect(MACHINE_TABS.map(([key]) => key)).not.toContain("pi");
		expect(MACHINE_TABS.map(([, label]) => label)).not.toContain("Pi");
	});

	it("保留其余机器工作区 tab 与顺序", () => {
		expect(MACHINE_TABS.map(([key]) => key)).toEqual([
			"overview",
			"execute",
			"files",
			"frp",
			"jobs",
			"terminal",
			"tunnel",
			"desktop",
		]);
	});
});

describe("randomUUID", () => {
	it("非安全上下文（无 crypto.randomUUID）下仍返回 v4 UUID 且不重复", () => {
		const restore = hideRandomUUID();
		try {
			const a = randomUUID();
			const b = randomUUID();
			expect(a).toMatch(V4);
			expect(b).toMatch(V4);
			expect(a).not.toBe(b);
		} finally {
			restore();
		}
	});

	it("安全上下文下走原生实现", () => {
		expect(randomUUID()).toMatch(V4);
	});
});
