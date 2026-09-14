/**
 * 发布声明的 Ed25519 签名与验签（仅 Launcher / 发布工具使用）。
 *
 * 纯逻辑部分（规范化、严格解析、约束校验）在 `@vcpdeck/shared`，因为它同时被
 * 浏览器引用；这里只放依赖 `node:crypto` 的部分。
 *
 * 信任根必须由调用方内置传入，**绝不**从待验证的 Release、Server 响应或同一下载
 * 位置取得（[`ADR-0029`](../../docs/adr/0029-signed-privileged-release-artifacts.md)）。
 */

import { createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import {
	parseReleaseDeclaration,
	releaseDeclarationBytes,
	ReleaseDeclarationError,
	type ReleaseDeclaration,
} from "@vcpdeck/shared";

/** 一个受信发布公钥。`publicKey` 为 PEM 或 base64 DER（SPKI）。 */
export interface TrustedPublisherKey {
	keyId: string;
	publicKey: string;
}

/** 随构件分发、独立于构件的签名信封。 */
export interface SignedReleaseDeclaration {
	declaration: ReleaseDeclaration;
	/** base64 编码的 Ed25519 签名，覆盖声明的规范化字节。 */
	signature: string;
	keyId: string;
}

const ENVELOPE_KEYS = ["declaration", "signature", "keyId"] as const;

/** Ed25519 签名固定 64 字节；长度不符无需再进密码库。 */
const ED25519_SIGNATURE_BYTES = 64;

function fail(message: string): never {
	throw new ReleaseDeclarationError(message);
}

/** 用发布私钥签署声明；返回可直接分发且不含私钥的信封。 */
export function signReleaseDeclaration(
	declaration: unknown,
	privateKeyPem: string,
): SignedReleaseDeclaration {
	// 先严格解析再签名，保证“签名的字节”与“验签时重算的字节”同源。
	const parsed = parseReleaseDeclaration(declaration);
	const signature = cryptoSign(
		null,
		releaseDeclarationBytes(parsed),
		privateKeyPem,
	).toString("base64");
	return { declaration: parsed, signature, keyId: parsed.keyId };
}

/**
 * 校验签名信封并返回声明。
 *
 * 顺序是刻意的：先做信封与声明的严格解析，再选信任根，最后才验签。任何一步失败
 * 都 fail closed，且错误信息不包含路径或密钥内容。
 */
export function verifySignedReleaseDeclaration(
	value: unknown,
	trustedKeys: readonly TrustedPublisherKey[],
): ReleaseDeclaration {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail("签名信封必须是对象");
	}
	const envelope = value as Record<string, unknown>;
	for (const key of Object.keys(envelope)) {
		if (!ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number])) {
			fail(`签名信封含未知字段 ${key}`);
		}
	}
	if (typeof envelope.keyId !== "string" || envelope.keyId.trim().length === 0) {
		fail("签名信封缺少 keyId");
	}
	if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
		fail("签名信封缺少 signature");
	}
	// 先严格解析声明：签名正确但声明本身非法时同样必须拒绝。
	const declaration = parseReleaseDeclaration(envelope.declaration);
	if (declaration.keyId !== envelope.keyId) {
		// 信任根选择必须与实际签名指向同一把密钥。
		fail("签名信封的 keyId 与声明不一致");
	}
	const trusted = trustedKeys.find((key) => key.keyId === envelope.keyId);
	if (!trusted) fail("发布者密钥未知");

	const signature = Buffer.from(envelope.signature, "base64");
	if (signature.length !== ED25519_SIGNATURE_BYTES) {
		fail("签名长度不符合 Ed25519");
	}
	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		publicKey = createPublicKey(trusted.publicKey);
	} catch {
		fail("受信公钥无法解析");
	}
	// 重新从解析后的声明计算规范化字节：签名后被修改过就一定验不过。
	if (!cryptoVerify(null, releaseDeclarationBytes(declaration), publicKey, signature)) {
		fail("发布声明签名校验失败");
	}
	return declaration;
}
