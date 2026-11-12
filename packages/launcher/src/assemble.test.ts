import {
	createHash,
	generateKeyPairSync,
	sign,
	type KeyObject,
} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalReleaseManifestJson,
	ReleaseArtifactErrorCode,
	type ReleaseFileEntry,
} from "@vcpdeck/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertSafeExtractedTree,
	assembleRelease,
	verifyManifestSignature,
} from "./assemble.js";
import { loadTrustedPublicKeyPem } from "./trusted-key.js";

const ENV_KEY = "VCPDECK_RELEASE_PUBLIC_KEY_PEM";

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function makeManifest(): Record<string, unknown> {
	return {
		version: "1.0.0",
		protocolVersion: 2,
		kind: "delta",
		fromVersion: "0.9.0",
		files: [
			{ path: "bin/app.js", sha256: "a".repeat(64), size: 3, mode: 0o755 },
		],
	};
}

/** 与打包侧 signManifest / Launcher verifyManifestSignature 共用规范化字节。 */
function signManifestWith(
	privateKey: KeyObject,
	manifest: Record<string, unknown>,
): string {
	const json = canonicalReleaseManifestJson(manifest);
	return sign(null, Buffer.from(json, "utf8"), privateKey).toString("base64");
}

function publicPem(publicKey: KeyObject): string {
	return publicKey.export({ type: "spki", format: "pem" }) as string;
}

describe("verifyManifestSignature / loadTrustedPublicKeyPem", () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env[ENV_KEY];
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = savedEnv;
	});

	it("合法签名 + 正确公钥 → 验签通过", () => {
		const kp = generateKeyPairSync("ed25519");
		const manifest = makeManifest();
		const signature = signManifestWith(kp.privateKey, manifest);

		expect(
			verifyManifestSignature(manifest, signature, publicPem(kp.publicKey)),
		).toBe(true);
	});

	it("篡改 files 后验签拒绝", () => {
		const kp = generateKeyPairSync("ed25519");
		const manifest = makeManifest();
		const signature = signManifestWith(kp.privateKey, manifest);
		const tampered: Record<string, unknown> = {
			...manifest,
			files: [
				{ path: "evil.js", sha256: "b".repeat(64), size: 99, mode: 0o777 },
			],
		};

		expect(
			verifyManifestSignature(tampered, signature, publicPem(kp.publicKey)),
		).toBe(false);
	});

	it("非法输入返回 false 而不抛", () => {
		const kp = generateKeyPairSync("ed25519");
		const manifest = makeManifest();
		const signature = signManifestWith(kp.privateKey, manifest);
		const pem = publicPem(kp.publicKey);

		expect(verifyManifestSignature(manifest, "", pem)).toBe(false);
		expect(verifyManifestSignature(manifest, "!!!not-base64!!!", pem)).toBe(
			false,
		);
		expect(verifyManifestSignature(manifest, signature, "not-a-pem")).toBe(
			false,
		);
		expect(verifyManifestSignature(manifest, signature, "")).toBe(false);
	});

	it("公钥轮换演练：env 覆盖后旧签名失效、新签名通过", () => {
		const oldKp = generateKeyPairSync("ed25519");
		const newKp = generateKeyPairSync("ed25519");
		const oldPem = publicPem(oldKp.publicKey);
		const newPem = publicPem(newKp.publicKey);
		const manifest = makeManifest();
		const oldSig = signManifestWith(oldKp.privateKey, manifest);
		const newSig = signManifestWith(newKp.privateKey, manifest);

		process.env[ENV_KEY] = oldPem;
		expect(loadTrustedPublicKeyPem()).toBe(oldPem);
		expect(
			verifyManifestSignature(manifest, oldSig, loadTrustedPublicKeyPem()),
		).toBe(true);
		expect(
			verifyManifestSignature(manifest, newSig, loadTrustedPublicKeyPem()),
		).toBe(false);

		process.env[ENV_KEY] = newPem;
		expect(loadTrustedPublicKeyPem()).toBe(newPem);
		expect(
			verifyManifestSignature(manifest, oldSig, loadTrustedPublicKeyPem()),
		).toBe(false);
		expect(
			verifyManifestSignature(manifest, newSig, loadTrustedPublicKeyPem()),
		).toBe(true);
	});

	it("无 env 覆盖时返回编译期内置占位公钥", () => {
		delete process.env[ENV_KEY];
		const pem = loadTrustedPublicKeyPem();

		expect(typeof pem).toBe("string");
		expect(pem).toContain("BEGIN PUBLIC KEY");
		expect(pem).toBe(loadTrustedPublicKeyPem());
	});
});

describe("assertSafeExtractedTree", () => {
	const hash = "a".repeat(64);
	const entry = (path: string): ReleaseFileEntry => ({
		path,
		sha256: hash,
		size: 1,
		mode: 0o644,
	});
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "assemble-tree-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	// Windows 用例只断言路径字符串校验，不触碰文件系统符号链接。
	it.each([
		"../evil",
		"a/../b",
		"/abs/path",
		"C:\\evil",
		"C:/evil",
		"a\0b",
		"a\\b",
		"",
	])("拒绝不安全清单路径 %j", (bad) => {
		expect(() => assertSafeExtractedTree(dir, [entry(bad)])).toThrow();
	});

	it("合法树（含 delta.json 与 .sig 元数据）通过", () => {
		mkdirSync(join(dir, "bin"));
		writeFileSync(join(dir, "bin", "app.js"), "x");
		writeFileSync(join(dir, "delta.json"), "{}");
		writeFileSync(join(dir, "delta.json.sig"), "sig");

		expect(() =>
			assertSafeExtractedTree(dir, [entry("bin/app.js")]),
		).not.toThrow();
	});

	it("拒绝非清单条目", () => {
		writeFileSync(join(dir, "extra.txt"), "x");

		expect(() =>
			assertSafeExtractedTree(dir, [entry("bin/app.js")]),
		).toThrow();
	});

	if (process.platform !== "win32") {
		it("拒绝符号链接条目", () => {
			const outside = mkdtempSync(join(tmpdir(), "assemble-outside-"));
			try {
				writeFileSync(join(outside, "secret.txt"), "x");
				symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));

				expect(() =>
					assertSafeExtractedTree(dir, [entry("link.txt")]),
				).toThrow();
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	}
});

describe("assembleRelease", () => {
	let root: string;
	let extractedDir: string;
	let targetDir: string;
	let baselineDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "assemble-release-"));
		extractedDir = join(root, "extracted");
		targetDir = join(root, "apps", "1.0.0");
		baselineDir = join(root, "apps", "0.9.0");
		mkdirSync(extractedDir, { recursive: true });
		mkdirSync(baselineDir, { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const opts = (files: ReleaseFileEntry[], baseline: string | null = baselineDir) => ({
		extractedDir,
		targetDir,
		baselineDir: baseline,
		files,
	});

	it("全链路：包内复制 + 基线硬链接 + chmod + 逐文件 hash 校验", async () => {
		const inPkg = "bin/app.js";
		const fromBase = "lib/data.txt";
		const contentA = "package-file";
		const contentB = "baseline-file";
		mkdirSync(join(extractedDir, "bin"));
		writeFileSync(join(extractedDir, inPkg), contentA);
		mkdirSync(join(baselineDir, "lib"));
		writeFileSync(join(baselineDir, fromBase), contentB);

		const files: ReleaseFileEntry[] = [
			{
				path: inPkg,
				sha256: sha256Hex(contentA),
				size: Buffer.byteLength(contentA),
				mode: 0o755,
			},
			{
				path: fromBase,
				sha256: sha256Hex(contentB),
				size: Buffer.byteLength(contentB),
				mode: 0o644,
			},
		];

		await assembleRelease(opts(files));

		for (const file of files) {
			const buf = readFileSync(join(targetDir, file.path));
			expect(buf.length).toBe(file.size);
			expect(sha256Hex(buf)).toBe(file.sha256);
		}
		if (process.platform !== "win32") {
			expect(statSync(join(targetDir, inPkg)).mode & 0o777).toBe(0o755);
			// 证明走的是硬链接（共享 inode），而非复制。
			expect(statSync(join(targetDir, fromBase)).ino).toBe(
				statSync(join(baselineDir, fromBase)).ino,
			);
		}
	});

	it("基线目录缺失抛 DELTA_BASELINE_UNAVAILABLE 并清理半成品", async () => {
		const files: ReleaseFileEntry[] = [
			{ path: "lib/missing.txt", sha256: sha256Hex("x"), size: 1, mode: 0o644 },
		];

		await expect(
			assembleRelease(opts(files, join(root, "no-such-baseline"))),
		).rejects.toMatchObject({
			code: ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
		});
		expect(existsSync(targetDir)).toBe(false);
	});

	it("baselineDir 为 null 且包内缺文件抛 DELTA_BASELINE_UNAVAILABLE", async () => {
		const files: ReleaseFileEntry[] = [
			{ path: "lib/missing.txt", sha256: sha256Hex("x"), size: 1, mode: 0o644 },
		];

		await expect(assembleRelease(opts(files, null))).rejects.toMatchObject({
			code: ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
		});
		expect(existsSync(targetDir)).toBe(false);
	});

	it("包内文件 hash 不符抛 FILE_HASH_MISMATCH 并清理半成品", async () => {
		mkdirSync(join(extractedDir, "bin"));
		writeFileSync(join(extractedDir, "bin", "app.js"), "tampered");
		const files: ReleaseFileEntry[] = [
			{
				path: "bin/app.js",
				sha256: sha256Hex("expected"),
				size: 8,
				mode: 0o644,
			},
		];

		await expect(assembleRelease(opts(files))).rejects.toMatchObject({
			code: ReleaseArtifactErrorCode.FILE_HASH_MISMATCH,
		});
		expect(existsSync(targetDir)).toBe(false);
	});

	it("非预期失败统一抛 ASSEMBLE_FAILED 并清理半成品目录", async () => {
		mkdirSync(join(extractedDir, "bin"));
		writeFileSync(join(extractedDir, "bin", "app.js"), "ok");
		// 非法 mode 令 chmodSync 抛 RangeError（非 AssembleError），应被兜底包装。
		const files: ReleaseFileEntry[] = [
			{ path: "bin/app.js", sha256: sha256Hex("ok"), size: 2, mode: -1 },
		];

		await expect(assembleRelease(opts(files))).rejects.toMatchObject({
			code: ReleaseArtifactErrorCode.ASSEMBLE_FAILED,
		});
		expect(existsSync(targetDir)).toBe(false);
	});
});
