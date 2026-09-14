import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	RELEASE_DECLARATION_VERSION,
	type ReleaseDeclaration,
} from "@vcpdeck/shared";
import {
	signReleaseDeclaration,
	verifySignedReleaseDeclaration,
	type TrustedPublisherKey,
} from "./release-signature.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");

const trusted: TrustedPublisherKey[] = [
	{ keyId: "vcpdeck-2026-a", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() },
];

function declaration(overrides: Partial<ReleaseDeclaration> = {}): ReleaseDeclaration {
	return {
		declarationVersion: RELEASE_DECLARATION_VERSION,
		releaseVersion: "1.2.3",
		platform: "win-x64",
		manifestVersion: 1,
		launcherMinVersion: "1.0.0",
		keyId: "vcpdeck-2026-a",
		artifacts: [
			{
				role: "release-archive",
				path: "vcpdeck-1.2.3-win-x64.zip",
				sha256: "a".repeat(64),
				size: 1024,
				executable: false,
			},
		],
		...overrides,
	};
}

function sign(value: ReleaseDeclaration, key = privateKey) {
	return signReleaseDeclaration(value, key.export({ type: "pkcs8", format: "pem" }).toString());
}

describe("verifySignedReleaseDeclaration", () => {
	it("accepts a declaration signed by a trusted publisher key", () => {
		const verified = verifySignedReleaseDeclaration(sign(declaration()), trusted);
		expect(verified.releaseVersion).toBe("1.2.3");
		expect(verified.keyId).toBe("vcpdeck-2026-a");
	});

	it("rejects a declaration modified after signing", () => {
		const signed = sign(declaration());
		// 签名后修改版本：即使哈希自洽，来源信任也必须失效。
		const tampered = {
			...signed,
			declaration: { ...signed.declaration, releaseVersion: "9.9.9" },
		};
		expect(() => verifySignedReleaseDeclaration(tampered, trusted)).toThrow();
	});

	it("rejects a signature produced by an untrusted key", () => {
		const signed = sign(declaration(), other.privateKey);
		expect(() => verifySignedReleaseDeclaration(signed, trusted)).toThrow();
	});

	it("rejects an unknown key id instead of falling back to any key", () => {
		const signed = sign(declaration({ keyId: "unknown-key" }));
		expect(() => verifySignedReleaseDeclaration(signed, trusted)).toThrow();
	});

	it("rejects an envelope whose key id disagrees with the declaration", () => {
		const signed = sign(declaration());
		// 声明里写 A、信封里写 B：信任根选择与实际签名必须指向同一把钥匙。
		expect(() =>
			verifySignedReleaseDeclaration({ ...signed, keyId: "vcpdeck-2026-b" }, [
				...trusted,
				{ keyId: "vcpdeck-2026-b", publicKey: trusted[0]!.publicKey },
			]),
		).toThrow();
	});

	it("rejects unknown envelope fields", () => {
		expect(() =>
			verifySignedReleaseDeclaration({ ...sign(declaration()), note: "extra" }, trusted),
		).toThrow();
	});

	it("rejects a malformed envelope or signature", () => {
		for (const value of [null, "x", [], {}, { declaration: {}, signature: "!!" }]) {
			expect(() => verifySignedReleaseDeclaration(value, trusted)).toThrow();
		}
	});

	it("rejects everything when no trusted key is configured", () => {
		// 信任根为空等于无法证明来源；此时绝不能默认放行。
		expect(() => verifySignedReleaseDeclaration(sign(declaration()), [])).toThrow();
	});

	it("rejects a well-formed but wrongly-shaped signature", () => {
		const signed = sign(declaration());
		expect(() =>
			verifySignedReleaseDeclaration(
				{ ...signed, signature: Buffer.alloc(64).toString("base64") },
				trusted,
			),
		).toThrow();
	});

	it("still validates the declaration strictly before verifying", () => {
		// 声明本身非法（未知字段）时，即使签名正确也必须拒绝。
		const bad = { ...declaration(), signedBy: "attacker" } as unknown as ReleaseDeclaration;
		expect(() => verifySignedReleaseDeclaration(sign(bad), trusted)).toThrow();
	});
});
