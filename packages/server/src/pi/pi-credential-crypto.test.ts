import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadPiCredentialCipher } from "./pi-credential-crypto.js";

const key = randomBytes(32).toString("base64");

/** 注入式读取：密钥文件内容（可含尾随换行）。 */
const readKey = (content: string) => async () => content;

describe("PiCredentialCipher", () => {
	it("加解密往返正确，密文不含明文，指纹为明文 sha256", async () => {
		const cipher = await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
			readKey(`${key}\n`),
		);
		expect(cipher).not.toBeNull();
		const enc = cipher!.encrypt("sk-live-1234567890");
		expect(enc.ciphertext).not.toContain("sk-live");
		expect(enc.keyVersion).toBe(1);
		expect(enc.fingerprint).toBe(
			createHash("sha256").update("sk-live-1234567890").digest("hex"),
		);
		expect(cipher!.decrypt(enc.ciphertext, enc.keyVersion)).toBe(
			"sk-live-1234567890",
		);
	});

	it("同一明文两次加密密文不同（IV 随机）", async () => {
		const cipher = (await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
			readKey(key),
		))!;
		expect(cipher.encrypt("x").ciphertext).not.toBe(
			cipher.encrypt("x").ciphertext,
		);
	});

	it("缺少环境变量或密钥长度不符时返回 null（调用方 fail closed）", async () => {
		expect(await loadPiCredentialCipher({}, readKey(key))).toBeNull();
		expect(
			await loadPiCredentialCipher(
				{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
				readKey("short"),
			),
		).toBeNull();
	});

	it("密钥文件读取失败时返回 null", async () => {
		const failing = async () => {
			throw new Error("ENOENT");
		};
		expect(
			await loadPiCredentialCipher(
				{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/missing" },
				failing,
			),
		).toBeNull();
	});

	it("未知 keyVersion 与错误密钥 fail closed", async () => {
		const cipher = (await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
			readKey(key),
		))!;
		const enc = cipher.encrypt("v");
		expect(() => cipher.decrypt(enc.ciphertext, 99)).toThrow(/keyVersion/);

		const other = (await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k2" },
			readKey(randomBytes(32).toString("base64")),
		))!;
		expect(() => other.decrypt(enc.ciphertext, 1)).toThrow();
	});

	it("密文被篡改时认证失败（GCM tag 校验）", async () => {
		const cipher = (await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
			readKey(key),
		))!;
		const enc = cipher.encrypt("secret-value");
		const raw = Buffer.from(enc.ciphertext, "base64");
		raw[raw.length - 1] ^= 0x01;
		expect(() => cipher.decrypt(raw.toString("base64"), 1)).toThrow();
	});

	it("错误信息不含密钥与明文", async () => {
		const cipher = (await loadPiCredentialCipher(
			{ VCPDECK_PI_CREDENTIAL_KEY_FILE: "/k" },
			readKey(key),
		))!;
		const enc = cipher.encrypt("sk-do-not-leak");
		try {
			cipher.decrypt(enc.ciphertext, 99);
			throw new Error("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).not.toContain("sk-do-not-leak");
			expect(message).not.toContain(key);
		}
	});
});
