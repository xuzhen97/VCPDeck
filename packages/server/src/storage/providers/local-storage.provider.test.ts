import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolve } from "node:path";
import {
	LocalStorageProvider,
	resolveStorageBaseDir,
} from "./local-storage.provider.js";

describe("resolveStorageBaseDir 锚定", () => {
	it("绝对 baseDir 原样返回，不受 app-dir 影响", () => {
		expect(resolveStorageBaseDir("/data/storage", "/app")).toBe(
			resolve("/data/storage"),
		);
	});

	it("相对 baseDir + VCPDECK_APP_DIR 锚定到版本目录外", () => {
		expect(resolveStorageBaseDir("./data/storage", "/vcpdeck/app")).toBe(
			resolve("/vcpdeck/app", "data/storage"),
		);
	});

	it("相对 baseDir 无 app-dir 时按 cwd 解析（现状）", () => {
		expect(resolveStorageBaseDir("./data/storage")).toBe(
			resolve(process.cwd(), "data/storage"),
		);
	});

	it("默认取 process.env.VCPDECK_APP_DIR", () => {
		vi.stubEnv("VCPDECK_APP_DIR", "/env-app");
		try {
			expect(resolveStorageBaseDir("./data/storage")).toBe(
				resolve("/env-app", "data/storage"),
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

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
			const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
			const sig = new URLSearchParams(qs).get("sig") || "";
			expect(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(
				true,
			);
			vi.setSystemTime(expires + 1000); // 越过过期时刻
			expect(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(
				false,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("对象不存在时抛出可识别的永久缺失错误", async () => {
		await expect(provider.download("missing/file.txt")).rejects.toMatchObject({
			name: "StorageObjectNotFoundError",
		});
	});
});
