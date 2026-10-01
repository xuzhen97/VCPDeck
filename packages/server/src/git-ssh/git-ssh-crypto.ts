/**
 * Git SSH 私钥加解密与 Ed25519 密钥生成（Server 侧）。
 *
 * 权威边界见 docs/adr/0037 决策 1 与 docs/adr/0038：
 * - DB 只保存密文与安全元数据；私钥明文只存在于 Server 受控解密窗口与 Client 运行内存；
 * - 根密钥来自 Server 进程外部安全配置（`VCPDECK_GIT_SSH_KEY_FILE`），
 *   不与 ciphertext 同库形成等价明文；
 * - 密钥缺失或非法时返回 null，由调用方 fail closed（GIT_SSH_KEY_UNAVAILABLE），
 *   不得猜测、不得降级为明文存储。
 *
 * 算法与 Pi Provider 凭据一致：AES-256-GCM，每字段独立 12 字节 IV 与 16 字节 tag，
 * 存储格式 `base64(iv || tag || ciphertext)`；根密钥独立于 Pi 凭据密钥，互不复用。
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";

/** 根密钥文件环境变量（Server 进程外）。 */
export const GIT_SSH_KEY_FILE_ENV = "VCPDECK_GIT_SSH_KEY_FILE";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 本轮只写 1；解密按 keyVersion 分派，未知版本 fail closed。 */
const CURRENT_KEY_VERSION = 1;

/** OpenSSH 私钥未加密时的认证魔数前缀。 */
const AUTH_MAGIC = "openssh-key-v1\0";
/** OpenSSH 私钥块在无加密时的块大小。 */
const PRIVATE_BLOCK_SIZE = 8;
/** 写入私钥的注释（非秘密，仅用于人工辨识来源）。 */
const PRIVATE_KEY_COMMENT = "vcpdeck";

export function gitSshError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

export interface EncryptedGitSshPrivateKey {
	ciphertext: string;
	keyVersion: number;
}

export interface GitSshKeyCipher {
	encrypt(plaintext: string): EncryptedGitSshPrivateKey;
	decrypt(ciphertext: string, keyVersion: number): string;
}

function assertKey(key: Buffer): void {
	if (key.length !== KEY_BYTES) {
		throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "Git SSH 密钥长度非法");
	}
}

/** 用给定密钥加密；IV 随机，因此同一明文每次密文不同。 */
export function encryptGitSshPrivateKey(
	plaintext: string,
	key: Buffer,
): EncryptedGitSshPrivateKey {
	assertKey(key);
	const iv = randomBytes(IV_BYTES);
	const gcm = createCipheriv("aes-256-gcm", key, iv);
	const body = Buffer.concat([gcm.update(plaintext, "utf8"), gcm.final()]);
	return {
		ciphertext: Buffer.concat([iv, gcm.getAuthTag(), body]).toString("base64"),
		keyVersion: CURRENT_KEY_VERSION,
	};
}

/** 用给定密钥解密；未知 keyVersion 与认证失败均 fail closed。 */
export function decryptGitSshPrivateKey(
	ciphertext: string,
	keyVersion: number,
	key: Buffer,
): string {
	if (keyVersion !== CURRENT_KEY_VERSION) {
		throw gitSshError(
			"GIT_SSH_KEY_UNAVAILABLE",
			`未知的 Git SSH 密钥 keyVersion ${keyVersion}`,
		);
	}
	assertKey(key);
	const raw = Buffer.from(ciphertext, "base64");
	if (raw.length <= IV_BYTES + TAG_BYTES) {
		throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "Git SSH 密文格式非法");
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
 * 从 `VCPDECK_GIT_SSH_KEY_FILE` 读取根密钥并构造 cipher。
 * 未配置、读取失败或长度不符时返回 null（调用方 fail closed）。
 */
export async function loadGitSshKeyCipher(
	env: NodeJS.ProcessEnv = process.env,
	readFileImpl: (path: string) => Promise<string> = (path) =>
		readFile(path, "utf8"),
): Promise<GitSshKeyCipher | null> {
	const file = env[GIT_SSH_KEY_FILE_ENV];
	if (!file) return null;
	let key: Buffer;
	try {
		key = Buffer.from((await readFileImpl(file)).trim(), "base64");
	} catch {
		return null;
	}
	if (key.length !== KEY_BYTES) return null;
	return {
		encrypt: (plaintext) => encryptGitSshPrivateKey(plaintext, key),
		decrypt: (ciphertext, keyVersion) =>
			decryptGitSshPrivateKey(ciphertext, keyVersion, key),
	};
}

/** SSH wire format 的 uint32（大端）。 */
function u32(value: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value >>> 0, 0);
	return buffer;
}

/** SSH wire format 的 length-prefixed string。 */
function sshString(value: Buffer | string): Buffer {
	const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	return Buffer.concat([u32(body.length), body]);
}

/** 折行为 PEM 装甲。 */
function toPem(label: string, body: Buffer): string {
	const base64 = body.toString("base64");
	const lines: string[] = [];
	for (let offset = 0; offset < base64.length; offset += 64) {
		lines.push(base64.slice(offset, offset + 64));
	}
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export interface GeneratedGitSshKeyPair {
	/** OpenSSH 私钥（PEM 装甲，未加密）。 */
	privateKey: string;
	/** 单行 `ssh-ed25519 <base64>` 公钥。 */
	publicKey: string;
	/** `SHA256:<base64>` 指纹，仅用于人工比对。 */
	fingerprint: string;
}

/**
 * 生成 Ed25519 密钥对并序列化为 OpenSSH 私钥格式。
 *
 * Node 只提供 JWK/PKCS#8 导出，无法导出 OpenSSH 私钥格式（实测
 * `createPrivateKey` 也不能读 OpenSSH 私钥），因此这里按
 * `PROTOCOL.key` 手写 `openssh-key-v1` 未加密结构；
 * 正确性由真实 `ssh-keygen -y` 互操作测试守住。
 */
export function generateGitSshEd25519KeyPair(): GeneratedGitSshKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
	const privateJwk = privateKey.export({ format: "jwk" }) as {
		x?: string;
		d?: string;
	};
	if (!publicJwk.x || !privateJwk.x || !privateJwk.d) {
		throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "Ed25519 私钥导出失败");
	}
	const publicBytes = Buffer.from(publicJwk.x, "base64url");
	const seed = Buffer.from(privateJwk.d, "base64url");
	if (publicBytes.length !== 32 || seed.length !== 32) {
		throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "Ed25519 密钥长度非法");
	}
	if (!publicBytes.equals(Buffer.from(privateJwk.x, "base64url"))) {
		throw gitSshError("GIT_SSH_KEY_UNAVAILABLE", "Ed25519 公私钥不匹配");
	}

	const keyType = "ssh-ed25519";
	const publicBlob = Buffer.concat([
		sshString(keyType),
		sshString(publicBytes),
	]);
	const publicKeyLine = `${keyType} ${publicBlob.toString("base64")}`;
	const fingerprint = `SHA256:${createHash("sha256")
		.update(publicBlob)
		.digest("base64")
		.replace(/=+$/, "")}`;

	const checkInt = randomBytes(4).readUInt32BE(0);
	const privateBody = Buffer.concat([
		u32(checkInt),
		u32(checkInt),
		sshString(keyType),
		sshString(publicBytes),
		sshString(Buffer.concat([seed, publicBytes])),
		sshString(PRIVATE_KEY_COMMENT),
	]);
	const padLength =
		(PRIVATE_BLOCK_SIZE - (privateBody.length % PRIVATE_BLOCK_SIZE)) %
		PRIVATE_BLOCK_SIZE;
	const padding = Buffer.from(
		Array.from({ length: padLength }, (_, index) => index + 1),
	);
	const privateBlob = Buffer.concat([privateBody, padding]);

	const fileBody = Buffer.concat([
		Buffer.from(AUTH_MAGIC, "binary"),
		sshString("none"),
		sshString("none"),
		sshString(Buffer.alloc(0)),
		u32(1),
		sshString(publicBlob),
		sshString(privateBlob),
	]);

	return {
		privateKey: toPem("OPENSSH PRIVATE KEY", fileBody),
		publicKey: publicKeyLine,
		fingerprint,
	};
}
