import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid.js";

const V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("randomUUID", () => {
	it("安全上下文下使用 crypto.randomUUID", () => {
		const original = vi.fn(() => "11111111-1111-4111-8111-111111111111");
		vi.stubGlobal("crypto", {
			randomUUID: original,
			getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
		});
		expect(randomUUID()).toBe("11111111-1111-4111-8111-111111111111");
		expect(original).toHaveBeenCalledOnce();
	});

	it("非安全上下文（无 crypto.randomUUID）仍返回 v4 UUID 且不重复", () => {
		// 明文 HTTP 部署时浏览器没有 crypto.randomUUID，只能退回 getRandomValues。
		const { getRandomValues } = globalThis.crypto;
		vi.stubGlobal("crypto", {
			getRandomValues: getRandomValues.bind(globalThis.crypto),
		});
		const first = randomUUID();
		const second = randomUUID();
		expect(first).toMatch(V4);
		expect(second).toMatch(V4);
		expect(first).not.toBe(second);
	});
});
