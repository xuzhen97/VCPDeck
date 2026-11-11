/**
 * Tailnet 凭据加解密（Server 侧，ADR-0062）。
 *
 * 权威边界：
 * - DB 只保存密文与安全元数据；`authKey` 明文只存在于导入与短时交付窗口；
 * - 根密钥来自 Server 进程外部安全配置（`VCPDECK_TAILNET_KEY_FILE`），
 *   缺失或非法时 fail closed，**不自动生成、不复用 Git SSH 根密钥**；
 * - 解密失败只暴露固定 `TAILNET_KEY_UNAVAILABLE`，不泄露路径或底层异常。
 *
 * 算法：AES-256-GCM，每字段独立 12 字节 IV 与 16 字节 tag，
 * 存储格式 `base64(iv || tag || ciphertext)`，当前 `keyVersion` 为 1。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

/** 根密钥文件环境变量（Server 进程外）。 */
export const TAILNET_KEY_FILE_ENV = "VCPDECK_TAILNET_KEY_FILE";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 本轮只写 1；解密按 keyVersion 分派，未知版本 fail closed。 */
const CURRENT_KEY_VERSION = 1;

/** 构造带稳定 code（与可选 statusCode）的错误。 */
export function tailnetError(
	code: string,
	message: string,
	statusCode?: number,
): Error {
	return Object.assign(new Error(message), { code, statusCode });
}

export interface EncryptedTailnetKey {
	ciphertext: string;
	keyVersion: number;
}

export interface TailnetKeyCipher {
	encrypt(plaintext: string): EncryptedTailnetKey;
	decrypt(ciphertext: string, keyVersion: number): string;
}

function assertKey(key: Buffer): void {
	if (key.length !== KEY_BYTES) {
		throw tailnetError("TAILNET_KEY_UNAVAILABLE", "Tailnet 根密钥长度非法");
	}
}

/** 用给定密钥加密；IV 随机，因此同一明文每次密文不同。 */
export function encryptTailnetKey(
	plaintext: string,
	key: Buffer,
): EncryptedTailnetKey {
	assertKey(key);
	const iv = randomBytes(IV_BYTES);
	const gcm = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([gcm.update(plaintext, "utf8"), gcm.final()]);
	return {
		ciphertext: Buffer.concat([iv, gcm.getAuthTag(), body]).toString("base64"),
		keyVersion: CURRENT_KEY_VERSION,
	};
}

/** 用给定密钥解密；未知 keyVersion、格式非法与认证失败均 fail closed。 */
export function decryptTailnetKey(
	ciphertext: string,
	keyVersion: number,
	key: Buffer,
): string {
	if (keyVersion !== CURRENT_KEY_VERSION) {
		throw tailnetError(
			"TAILNET_KEY_UNAVAILABLE",
			`未知的 Tailnet 密钥 keyVersion ${keyVersion}`,
		);
	}
	assertKey(key);
	const raw = Buffer.from(ciphertext, "base64");
	if (raw.length <= IV_BYTES + TAG_BYTES) {
		throw tailnetError("TAILNET_KEY_UNAVAILABLE", "Tailnet 密文格式非法");
	}
	const iv = raw.subarray(0, IV_BYTES);
	const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const gcm = createDecipheriv("aes-256-gcm", key, iv, {
		authTagLength: TAG_BYTES,
	});
	gcm.setAuthTag(tag);
	try {
		return Buffer.concat([
			gcm.update(raw.subarray(IV_BYTES + TAG_BYTES)),
			gcm.final(),
		]).toString("utf8");
	} catch {
		// GCM 认证失败的具体原因不对外区分，统一按根密钥不可用处理。
		throw tailnetError("TAILNET_KEY_UNAVAILABLE", "Tailnet 凭据解密失败");
	}
}

/** 由已有 32 字节根密钥构造 cipher。 */
export function tailnetCipherFromKey(key: Buffer): TailnetKeyCipher {
	assertKey(key);
	return {
		encrypt: (plaintext) => encryptTailnetKey(plaintext, key),
		decrypt: (ciphertext, keyVersion) =>
			decryptTailnetKey(ciphertext, keyVersion, key),
	};
}

/**
 * 从 `VCPDECK_TAILNET_KEY_FILE` 读取根密钥并构造 cipher。
 * 未配置、读取失败或长度不符时返回 null（调用方 fail closed）。
 */
export async function loadTailnetKeyCipher(
	env: NodeJS.ProcessEnv = process.env,
	readFileImpl: (path: string) => Promise<string> = (path) =>
		readFile(path, "utf8"),
): Promise<TailnetKeyCipher | null> {
	const file = env[TAILNET_KEY_FILE_ENV];
	if (!file) return null;
	let key: Buffer;
	try {
		key = Buffer.from((await readFileImpl(file)).trim(), "base64");
	} catch {
		return null;
	}
	if (key.length !== KEY_BYTES) return null;
	return tailnetCipherFromKey(key);
}
