/**
 * Pi Provider 凭据加解密（Server 侧）。
 *
 * 权威边界见 docs/design/remote-pi-control-plane.md §6.2 与 ADR-0029 决策 6：
 * - DB 只保存密文与安全元数据；明文只在受控解密窗口与 Client Worker 内存中存在；
 * - 根密钥来自 Server 进程外部安全配置（`VCPDECK_PI_CREDENTIAL_KEY_FILE`），
 *   不与 ciphertext 同库形成等价明文；
 * - 密钥缺失或非法时返回 null，由调用方 fail closed（PI_CONFIG_UNAVAILABLE），
 *   不得猜测、不得降级为明文存储。
 *
 * 算法：AES-256-GCM，每字段独立 12 字节 IV 与 16 字节 tag，
 * 存储格式 `base64(iv || tag || ciphertext)`。
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 本轮只写 1；解密按 keyVersion 分派，未知版本 fail closed。 */
const CURRENT_KEY_VERSION = 1;

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

export interface EncryptedPiCredential {
	ciphertext: string;
	keyVersion: number;
	fingerprint: string;
}

export interface PiCredentialCipher {
	encrypt(plaintext: string): EncryptedPiCredential;
	decrypt(ciphertext: string, keyVersion: number): string;
}

/** 用给定密钥加密；IV 随机，因此同一明文每次密文不同。 */
export function encryptPiCredential(
	plaintext: string,
	key: Buffer,
): EncryptedPiCredential {
	if (key.length !== KEY_BYTES) {
		throw piError("PI_CONFIG_UNAVAILABLE", "Pi 凭据密钥长度非法");
	}
	const iv = randomBytes(IV_BYTES);
	const gcm = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([gcm.update(plaintext, "utf8"), gcm.final()]);
	return {
		ciphertext: Buffer.concat([iv, gcm.getAuthTag(), body]).toString("base64"),
		keyVersion: CURRENT_KEY_VERSION,
		fingerprint: createHash("sha256").update(plaintext).digest("hex"),
	};
}

/** 用给定密钥解密；未知 keyVersion 与认证失败均 fail closed。 */
export function decryptPiCredential(
	ciphertext: string,
	keyVersion: number,
	key: Buffer,
): string {
	if (keyVersion !== CURRENT_KEY_VERSION) {
		throw piError(
			"PI_CONFIG_UNAVAILABLE",
			`未知的 Pi 凭据 keyVersion ${keyVersion}`,
		);
	}
	if (key.length !== KEY_BYTES) {
		throw piError("PI_CONFIG_UNAVAILABLE", "Pi 凭据密钥长度非法");
	}
	const raw = Buffer.from(ciphertext, "base64");
	if (raw.length <= IV_BYTES + TAG_BYTES) {
		throw piError("PI_CONFIG_UNAVAILABLE", "Pi 凭据密文格式非法");
	}
	const iv = raw.subarray(0, IV_BYTES);
	const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const gcm = createDecipheriv("aes-256-gcm", key, iv);
	gcm.setAuthTag(tag);
	return Buffer.concat([
		gcm.update(raw.subarray(IV_BYTES + TAG_BYTES)),
		gcm.final(),
	]).toString("utf8");
}

/**
 * 从 `VCPDECK_PI_CREDENTIAL_KEY_FILE` 读取根密钥并构造 cipher。
 * 未配置、读取失败或长度不符时返回 null（调用方 fail closed）。
 */
export async function loadPiCredentialCipher(
	env: NodeJS.ProcessEnv = process.env,
	readFileImpl: (path: string) => Promise<string> = (path) =>
		readFile(path, "utf8"),
): Promise<PiCredentialCipher | null> {
	const file = env.VCPDECK_PI_CREDENTIAL_KEY_FILE;
	if (!file) return null;
	let key: Buffer;
	try {
		key = Buffer.from((await readFileImpl(file)).trim(), "base64");
	} catch {
		return null;
	}
	if (key.length !== KEY_BYTES) return null;
	return {
		encrypt: (plaintext) => encryptPiCredential(plaintext, key),
		decrypt: (ciphertext, keyVersion) =>
			decryptPiCredential(ciphertext, keyVersion, key),
	};
}
