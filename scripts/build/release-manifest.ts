/**
 * 打包侧清单、签名与 delta 差集纯函数（ADR-0063:24）。
 *
 * 规范化字节必须与 Launcher 验签共用 @vcpdeck/shared 的
 * canonicalReleaseManifestJson，不得在本文件复制键序或自行拼装 JSON。
 */
import * as crypto from "node:crypto";
import {
	canonicalReleaseManifestJson,
	type ReleaseFileEntry,
} from "@vcpdeck/shared";

/** 将收集到的文件元数据整理为目标清单条目，并按 path 升序排列。 */
export function buildFileList(
	files: Array<{ name: string; sha256: string; size: number; mode: number }>,
): ReleaseFileEntry[] {
	return files
		.map((file) => ({
			path: file.name,
			sha256: file.sha256,
			size: file.size,
			mode: file.mode,
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 求当前清单相对基线的差集：新增，或 sha256/size/mode 任一变化；基线多余条目忽略。 */
export function diffFileList(
	current: ReleaseFileEntry[],
	baseline: ReleaseFileEntry[],
): ReleaseFileEntry[] {
	const baselineByPath = new Map<string, ReleaseFileEntry>(
		baseline.map((entry): [string, ReleaseFileEntry] => [entry.path, entry]),
	);
	return current.filter((entry) => {
		const previous = baselineByPath.get(entry.path);
		if (!previous) return true;
		return (
			previous.sha256 !== entry.sha256 ||
			previous.size !== entry.size ||
			previous.mode !== entry.mode
		);
	});
}

/** 用调用方注入的私钥对清单规范化字节签名，返回 base64；不读取任何环境变量。 */
export function signManifest(
	manifest: Record<string, unknown>,
	privateKeyPem: string,
): string {
	const json = canonicalReleaseManifestJson(manifest);
	return crypto
		.sign(null, Buffer.from(json, "utf8"), privateKeyPem)
		.toString("base64");
}

/**
 * 从 Ed25519 私钥（PKCS#8 PEM）派生 SPKI 公钥 PEM。
 *
 * 打包管线用同一份私钥签名，再把派生公钥注入 Launcher 单文件，保证包内信任根
 * 与签名密钥同源，避免手工替换错配；不读取任何环境变量。
 */
export function derivePublicKeyPem(privateKeyPem: string): string {
	return crypto
		.createPublicKey(privateKeyPem)
		.export({ type: "spki", format: "pem" })
		.toString();
}
