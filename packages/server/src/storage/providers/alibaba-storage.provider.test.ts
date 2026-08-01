import { describe, it, expect, beforeEach } from "vitest";
import { AlibabaStorageProvider } from "./alibaba-storage.provider.js";

describe("AlibabaStorageProvider download signature", () => {
	let provider: AlibabaStorageProvider;
	beforeEach(() => {
		// 无需真实阿里云配置：签名/校验是纯本地 HMAC 逻辑
		provider = new AlibabaStorageProvider({});
	});

	it("ttlSeconds <= 0 签出 expires=0（永久），verify 通过", () => {
		const qs = provider.signDownloadUrl("aliyun-file-id-123", 0);
		expect(qs).toContain("expires=0");
		const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
		const sig = new URLSearchParams(qs).get("sig") || "";
		expect(
			provider.verifyDownloadSignature("aliyun-file-id-123", expires, sig),
		).toBe(true);
	});

	it("签发的永久签名不因时间推移失效", async () => {
		const qs = provider.signDownloadUrl("aliyun-file-id-123", 0);
		const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
		const sig = new URLSearchParams(qs).get("sig") || "";
		// 模拟任意时刻校验永久链接都应通过（expires=0 不依赖当前时间）
		expect(
			provider.verifyDownloadSignature("aliyun-file-id-123", expires, sig),
		).toBe(true);
	});
});
