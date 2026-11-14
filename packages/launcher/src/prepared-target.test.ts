/**
 * 目标目录复验的单测（ADR-0065 / 评审 I6）。
 *
 * 这里覆盖“停旧进程之前”必须成立的全部本地条件：清单、构件入口、musl 描述文件、
 * 描述文件哈希、清单签名。验证对象是纯函数，不启动进程也不访问网络。
 */
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTROL_PROTOCOL_VERSION,
	canonicalReleaseManifestJson,
	ReleaseArtifactErrorCode,
} from "@vcpdeck/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { assertPreparedTarget, localRuntimeIsMusl } from "./daemon.js";

const ENV_KEY = "VCPDECK_RELEASE_PUBLIC_KEY_PEM";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
const tempDirs: string[] = [];

function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function tempVersionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-target-"));
	tempDirs.push(dir);
	return dir;
}

const DESCRIPTOR = {
	schema: 1,
	platform: "linux-x64-musl",
	role: "client",
	runtime: {
		version: "24.22.3",
		url: "https://unofficial-builds.nodejs.org/download/release/v24.22.3/node-v24.22.3-linux-x64-musl.tar.gz",
		sha256: "b".repeat(64),
	},
};

interface ManifestOptions {
	withDescriptor?: boolean;
	withServer?: boolean;
	descriptorSha?: string;
}

function writePreparedVersion(
	options: ManifestOptions = {},
): { versionDir: string; manifest: Record<string, unknown> } {
	const versionDir = tempVersionDir();
	const descriptorBytes = `${JSON.stringify(DESCRIPTOR, null, 2)}\n`;
	mkdirSync(join(versionDir, "client", "dist"), { recursive: true });
	writeFileSync(join(versionDir, "client", "dist", "main.js"), "console.log(1)\n");
	const files: Array<Record<string, unknown>> = [
		{
			path: "client/dist/main.js",
			sha256: sha256Hex("console.log(1)\n"),
			size: 15,
			mode: 0o644,
		},
	];
	if (options.withDescriptor) {
		writeFileSync(join(versionDir, "client", "release-target.json"), descriptorBytes);
		files.push({
			path: "client/release-target.json",
			sha256: options.descriptorSha ?? sha256Hex(descriptorBytes),
			size: Buffer.byteLength(descriptorBytes),
			mode: 0o644,
		});
	}
	const manifest: Record<string, unknown> = {
		version: "1.2.3",
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		artifacts: options.withServer
			? {
					client: { dir: "client", entry: "dist/main.js" },
					server: { dir: "server", entry: "dist/main.js" },
				}
			: { client: { dir: "client", entry: "dist/main.js" } },
		nodeVersion: ">=24",
		files,
	};
	writeFileSync(join(versionDir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(
		join(versionDir, "manifest.json.sig"),
		sign(
			null,
			Buffer.from(canonicalReleaseManifestJson(manifest), "utf8"),
			privateKey,
		).toString("base64"),
	);
	return { versionDir, manifest };
}

beforeEach(() => {
	process.env[ENV_KEY] = publicPem;
});

afterAll(() => {
	delete process.env[ENV_KEY];
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("assertPreparedTarget", () => {
	it("清单缺失时以 RELEASE_ARTIFACTS_INCOMPLETE 失败", () => {
		const versionDir = tempVersionDir();
		expect(() =>
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: true }),
		).toThrow(/目标构件清单不完整/);
	});

	it("构件入口不存在时失败", () => {
		const { versionDir } = writePreparedVersion();
		rmSync(join(versionDir, "client", "dist", "main.js"));
		try {
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: false });
			expect.unreachable();
		} catch (error) {
			expect((error as { code?: string }).code).toBe(
				ReleaseArtifactErrorCode.RELEASE_ARTIFACTS_INCOMPLETE,
			);
		}
	});

	it("glibc 本机的普通 Client 包没有描述文件也算合格", () => {
		const { versionDir } = writePreparedVersion();
		expect(
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: false }),
		).toBeNull();
	});

	it("musl 本机缺描述文件时失败关闭", () => {
		const { versionDir } = writePreparedVersion();
		expect(() =>
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: true }),
		).toThrow(/缺少 release-target\.json/);
	});

	it("glibc 本机拿到 musl 包时拒绝跨 libc 切换", () => {
		const { versionDir } = writePreparedVersion({ withDescriptor: true });
		expect(() =>
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: false }),
		).toThrow(/本机运行时不一致/);
	});

	it("musl Client 包携带 Server 构件时拒绝", () => {
		const { versionDir } = writePreparedVersion({
			withDescriptor: true,
			withServer: true,
		});
		expect(() =>
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: true }),
		).toThrow(/不得携带 Server 构件/);
	});

	it("描述文件哈希与清单不一致时拒绝", () => {
		const { versionDir } = writePreparedVersion({
			withDescriptor: true,
			descriptorSha: "c".repeat(64),
		});
		expect(() =>
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: true }),
		).toThrow(/哈希不匹配/);
	});

	it("缺少清单签名时以 MANIFEST_SIGNATURE_INVALID 失败", () => {
		const { versionDir } = writePreparedVersion({ withDescriptor: true });
		rmSync(join(versionDir, "manifest.json.sig"));
		try {
			assertPreparedTarget({ versionDir, artifact: "client", localMusl: true });
			expect.unreachable();
		} catch (error) {
			expect((error as { code?: string }).code).toBe(
				ReleaseArtifactErrorCode.MANIFEST_SIGNATURE_INVALID,
			);
		}
	});

	it("完整的 musl Client 目标通过复验并返回描述文件", () => {
		const { versionDir } = writePreparedVersion({ withDescriptor: true });
		const target = assertPreparedTarget({
			versionDir,
			artifact: "client",
			localMusl: true,
		});
		expect(target?.platform).toBe("linux-x64-musl");
		expect(target?.runtime.version).toBe("24.22.3");
	});

	it("非 Linux 平台不按 musl 处理", () => {
		expect(localRuntimeIsMusl("win32")).toBe(false);
		expect(localRuntimeIsMusl("darwin")).toBe(false);
	});
});
