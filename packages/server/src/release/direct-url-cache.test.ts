import { describe, expect, it } from "vitest";
import { DirectUrlCache } from "./direct-url-cache.js";

const NOW = 1_800_000_000_000;

describe("DirectUrlCache", () => {
	it("set 后未过期可命中", () => {
		const cache = new DirectUrlCache();
		cache.set("k", "https://storage/x", NOW + 900_000);
		expect(cache.get("k", NOW)).toBe("https://storage/x");
	});

	it("超过有效期（含安全余量）返回 null 并淘汰", () => {
		const cache = new DirectUrlCache();
		cache.set("k", "https://storage/x", NOW + 30_000);
		// 距过期不足默认 60s 安全余量 → 视为已过期
		expect(cache.get("k", NOW + 1)).toBeNull();
		expect(cache.get("k", NOW + 1)).toBeNull();
	});

	it("expiresAt 以秒给出时换算为毫秒", () => {
		const cache = new DirectUrlCache();
		cache.set("k", "https://storage/x", NOW / 1000 + 900);
		expect(cache.get("k", NOW)).toBe("https://storage/x");
	});

	it("expiresAt 为 0 表示不设过期，始终命中", () => {
		const cache = new DirectUrlCache();
		cache.set("k", "https://storage/x", 0);
		expect(cache.get("k", NOW + 3_600_000)).toBe("https://storage/x");
	});

	it("delete 后不再命中", () => {
		const cache = new DirectUrlCache();
		cache.set("k", "https://storage/x", NOW + 900_000);
		cache.delete("k");
		expect(cache.get("k", NOW)).toBeNull();
	});
});
