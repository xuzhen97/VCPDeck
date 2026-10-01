import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	decryptGitSshPrivateKey,
	encryptGitSshPrivateKey,
	generateGitSshEd25519KeyPair,
	loadGitSshKeyCipher,
} from "./git-ssh-crypto.js";

const key = randomBytes(32).toString("base64");

/** 注入式读取：密钥文件内容（可含尾随换行）。 */
const readKey = (content: string) => async () => content;

/** 定位真实 ssh-keygen（存在则做互操作校验，不存在则跳过）。 */
function findSshKeygen(): string | null {
	const candidates =
		process.platform === "win32"
			? ["C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe", "ssh-keygen.exe"]
			: ["ssh-keygen"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["-l"], { encoding: "utf8" });
		if (!probe.error) return candidate;
	}
	return null;
}

const sshKeygen = findSshKeygen();

describe("git-ssh 私钥加解密", () => {
	it("加解密往返正确，密文不含明文", async () => {
		const cipher = await loadGitSshKeyCipher(
			{ VCPDECK_GIT_SSH_KEY_FILE: "/k" },
			readKey(`${key}\n`),
		);
		expect(cipher).not.toBeNull();
		const enc = encryptGitSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----x", Buffer.from(key, "base64"));
		expect(enc.ciphertext).not.toContain("OPENSSH");
		expect(enc.keyVersion).toBe(1);
		expect(cipher!.decrypt(enc.ciphertext, enc.keyVersion)).toBe(
			"-----BEGIN OPENSSH PRIVATE KEY-----x",
		);
	});

	it("同一明文两次加密密文不同（IV 随机）", () => {
		const buf = Buffer.from(key, "base64");
		expect(encryptGitSshPrivateKey("x", buf).ciphertext).not.toBe(
			encryptGitSshPrivateKey("x", buf).ciphertext,
		);
	});

	it("缺少环境变量或密钥长度不符时返回 null（调用方 fail closed）", async () => {
		expect(await loadGitSshKeyCipher({}, readKey(key))).toBeNull();
		expect(
			await loadGitSshKeyCipher(
				{ VCPDECK_GIT_SSH_KEY_FILE: "/k" },
				readKey("short"),
			),
		).toBeNull();
	});

	it("密钥文件读取失败时返回 null", async () => {
		const failing = async () => {
			throw new Error("ENOENT");
		};
		expect(
			await loadGitSshKeyCipher({ VCPDECK_GIT_SSH_KEY_FILE: "/missing" }, failing),
		).toBeNull();
	});

	it("未知 keyVersion、错误密钥与篡改密文一律 fail closed", () => {
		const buf = Buffer.from(key, "base64");
		const enc = encryptGitSshPrivateKey("v", buf);
		expect(() => decryptGitSshPrivateKey(enc.ciphertext, 99, buf)).toThrow(
			/keyVersion/,
		);
		expect(() =>
			decryptGitSshPrivateKey(enc.ciphertext, 1, randomBytes(32)),
		).toThrow();
		const raw = Buffer.from(enc.ciphertext, "base64");
		raw[raw.length - 1] ^= 0x01;
		expect(() => decryptGitSshPrivateKey(raw.toString("base64"), 1, buf)).toThrow();
	});

	it("错误信息不含明文", () => {
		const buf = Buffer.from(key, "base64");
		const enc = encryptGitSshPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----do-not-leak", buf);
		try {
			decryptGitSshPrivateKey(enc.ciphertext, 7, buf);
			throw new Error("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).not.toContain("do-not-leak");
			expect(message).not.toContain(key);
		}
	});
});

describe("generateGitSshEd25519KeyPair", () => {
	it("生成 ssh-ed25519 公钥、SHA256 指纹与 OpenSSH 私钥装甲", () => {
		const pair = generateGitSshEd25519KeyPair();
		expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/);
		expect(pair.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
		expect(pair.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
		expect(pair.privateKey.trimEnd().endsWith("-----END OPENSSH PRIVATE KEY-----")).toBe(true);
	});

	it("指纹为公钥 blob 的 SHA256", () => {
		const pair = generateGitSshEd25519KeyPair();
		const blob = Buffer.from(pair.publicKey.split(" ")[1]!, "base64");
		const expected = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
		expect(pair.fingerprint).toBe(expected);
	});

	it("私钥内嵌公钥与返回公钥一致，且为未加密 openssh-key-v1 结构", () => {
		const pair = generateGitSshEd25519KeyPair();
		const body = pair.privateKey
			.replace(/-----BEGIN OPENSSH PRIVATE KEY-----/, "")
			.replace(/-----END OPENSSH PRIVATE KEY-----/, "")
			.replace(/\s+/g, "");
		const blob = Buffer.from(body, "base64");
		expect(blob.subarray(0, 15).toString("binary")).toBe("openssh-key-v1\0");
		// 外层容器结构：magic + ciphername + kdfname + kdfoptions + nkeys + pubkey + privkey
		let offset = 15;
		offset += 4 + "none".length; // ciphername
		offset += 4 + "none".length; // kdfname
		offset += 4; // kdfoptions（空）
		const nkeys = blob.readUInt32BE(offset);
		offset += 4;
		expect(nkeys).toBe(1);
		const publicBlob = Buffer.from(pair.publicKey.split(" ")[1]!, "base64");
		const declaredPublicLength = blob.readUInt32BE(offset);
		offset += 4;
		expect(declaredPublicLength).toBe(publicBlob.length);
		expect(blob.subarray(offset, offset + declaredPublicLength).equals(publicBlob)).toBe(true);
		offset += declaredPublicLength;
		const privateLength = blob.readUInt32BE(offset);
		expect(privateLength % 8).toBe(0); // 私钥块按 8 字节对齐
		expect(offset + 4 + privateLength).toBe(blob.length);
		expect(blob.includes(publicBlob)).toBe(true);
	});

	it("两次生成互不相同", () => {
		const a = generateGitSshEd25519KeyPair();
		const b = generateGitSshEd25519KeyPair();
		expect(a.publicKey).not.toBe(b.publicKey);
		expect(a.privateKey).not.toBe(b.privateKey);
	});

	/**
	 * 互操作校验：Node 无法解析 OpenSSH 私钥（实测 ERR_OSSL_UNSUPPORTED），
	 * 因此必须由真实 ssh-keygen 证明生成的私钥可用且能回推同一公钥。
	 */
	it.skipIf(sshKeygen === null)("真实 ssh-keygen 能读取私钥并回推同一公钥", () => {
		const pair = generateGitSshEd25519KeyPair();
		const dir = mkdtempSync(join(tmpdir(), "vcp-git-ssh-"));
		try {
			const file = join(dir, "id_ed25519");
			writeFileSync(file, pair.privateKey, { mode: 0o600 });
			const result = spawnSync(sshKeygen!, ["-y", "-f", file], {
				encoding: "utf8",
			});
			expect(result.stderr ?? "").toBe("");
			expect(result.status).toBe(0);
			// ssh-keygen 会把私钥注释一并输出，只比对类型与公钥主体。
			const derived = result.stdout.trim().split(/\s+/).slice(0, 2).join(" ");
			const expected = pair.publicKey.split(/\s+/).slice(0, 2).join(" ");
			expect(derived).toBe(expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
