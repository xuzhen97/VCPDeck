import { describe, it, expect, beforeEach, vi } from "vitest";
import { LocalStorageProvider } from "./local-storage.provider.js";

describe("LocalStorageProvider download signature", () => {
	let provider: LocalStorageProvider;
	beforeEach(() => {
		provider = new LocalStorageProvider({ baseDir: "./data/storage-test" });
	});

	it("ttlSeconds <= 0 签出 expires=0（永久），verify 通过", () => {
		const qs = provider.signDownloadUrl("abc/def.txt", 0);
		expect(qs).toContain("expires=0");
		const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
		const sig = new URLSearchParams(qs).get("sig") || "";
		expect(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(
			true,
		);
	});

	it("正常 ttl 签出的签名过期后 verify 拒绝", () => {
		vi.useFakeTimers();
		try {
			const qs = provider.signDownloadUrl("abc/def.txt", 1); // 1 秒有效期
			const expires = parseInt(
				new URLSearchParams(qs).get("expires") || "0",
				10,
			);
			const sig = new URLSearchParams(qs).get("sig") || "";
			expect(
				provider.verifyDownloadSignature("abc/def.txt", expires, sig),
			).toBe(true);
			vi.setSystemTime(expires + 1000); // 越过过期时刻
			expect(
				provider.verifyDownloadSignature("abc/def.txt", expires, sig),
			).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
