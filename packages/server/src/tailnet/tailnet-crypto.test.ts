/**
 * Tailnet 凭据加解密单测（ADR-0062）。
 *
 * 断言重点：随机 IV、密文布局、未知版本与错误根密钥一律 fail closed，
 * 以及根密钥缺失时只返回 null 而不生成新密钥。
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	decryptTailnetKey,
	encryptTailnetKey,
	loadTailnetKeyCipher,
	TAILNET_KEY_FILE_ENV,
} from "./tailnet-crypto.js";

const KEY = randomBytes(32);
const PLAINTEXT = "tskey-auth-kTestKey-0123456789abcdef";

function expectCode(fn: () => unknown, code: string): void {
	expect(fn).toThrowError(
		expect.objectContaining({ code }) as unknown as Error,
	);
}

describe("Tailnet 凭据加解密", () => {
	it("同一明文两次加密得到不同密文（随机 IV）", () => {
		const first = encryptTailnetKey(PLAINTEXT, KEY);
		const second = encryptTailnetKey(PLAINTEXT, KEY);
		expect(first.ciphertext).not.toBe(second.ciphertext);
		expect(first.keyVersion).toBe(1);
	});

	it("正确根密钥可还原明文", () => {
		const { ciphertext, keyVersion } = encryptTailnetKey(PLAINTEXT, KEY);
		expect(decryptTailnetKey(ciphertext, keyVersion, KEY)).toBe(PLAINTEXT);
	});

	it("密文为 base64(iv || tag || ciphertext)，长度符合 12+16+n", () => {
		const { ciphertext } = encryptTailnetKey(PLAINTEXT, KEY);
		const raw = Buffer.from(ciphertext, "base64");
		expect(raw.length).toBe(12 + 16 + Buffer.byteLength(PLAINTEXT, "utf8"));
	});

	it("未知 keyVersion 拒绝解密", () => {
		const { ciphertext } = encryptTailnetKey(PLAINTEXT, KEY);
		expectCode(
			() => decryptTailnetKey(ciphertext, 2, KEY),
			"TAILNET_KEY_UNAVAILABLE",
		);
	});

	it("错误根密钥因 GCM 认证失败而拒绝", () => {
		const { ciphertext, keyVersion } = encryptTailnetKey(PLAINTEXT, KEY);
		expectCode(
			() => decryptTailnetKey(ciphertext, keyVersion, randomBytes(32)),
			"TAILNET_KEY_UNAVAILABLE",
		);
	});

	it("非法根密钥长度拒绝加解密", () => {
		expectCode(
			() => encryptTailnetKey(PLAINTEXT, randomBytes(16)),
			"TAILNET_KEY_UNAVAILABLE",
		);
		expectCode(
			() => decryptTailnetKey("AAAA", 1, randomBytes(16)),
			"TAILNET_KEY_UNAVAILABLE",
		);
	});

	it("密文长度不足 28 字节拒绝", () => {
		expectCode(
			() => decryptTailnetKey(Buffer.alloc(20).toString("base64"), 1, KEY),
			"TAILNET_KEY_UNAVAILABLE",
		);
	});
});

describe("Tailnet 根密钥加载", () => {
	const dir = mkdtempSync(join(tmpdir(), "vcp-tailnet-crypto-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("未配置环境变量返回 null", async () => {
		await expect(loadTailnetKeyCipher({})).resolves.toBeNull();
	});

	it("文件不可读返回 null", async () => {
		await expect(
			loadTailnetKeyCipher({ [TAILNET_KEY_FILE_ENV]: join(dir, "missing") }),
		).resolves.toBeNull();
	});

	it("长度非 32 字节返回 null", async () => {
		const path = join(dir, "short.key");
		writeFileSync(path, randomBytes(16).toString("base64"));
		await expect(
			loadTailnetKeyCipher({ [TAILNET_KEY_FILE_ENV]: path }),
		).resolves.toBeNull();
	});

	it("合法根密钥返回可用 cipher", async () => {
		const path = join(dir, "ok.key");
		writeFileSync(path, `${KEY.toString("base64")}\n`);
		const cipher = await loadTailnetKeyCipher({ [TAILNET_KEY_FILE_ENV]: path });
		expect(cipher).not.toBeNull();
		const { ciphertext, keyVersion } = cipher!.encrypt(PLAINTEXT);
		expect(cipher!.decrypt(ciphertext, keyVersion)).toBe(PLAINTEXT);
	});
});
