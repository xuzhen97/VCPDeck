import { describe, expect, it } from "vitest";
import {
	RELEASE_DECLARATION_VERSION,
	assertArchiveEntriesAllowed,
	assertArtifactMatches,
	assertLauncherVersionSatisfies,
	canonicalizeReleaseDeclaration,
	parseReleaseDeclaration,
	type ReleaseDeclaration,
} from "./release-signature.js";

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
			{
				role: "desktop-host",
				path: "bin/desktop-host.exe",
				sha256: "b".repeat(64),
				size: 2048,
				executable: true,
			},
		],
		...overrides,
	};
}

describe("canonicalizeReleaseDeclaration", () => {
	it("produces identical bytes regardless of key insertion order", () => {
		// 签名覆盖的是规范化字节；字段顺序不同必须得到同一份字节。
		const a = declaration();
		const reordered = JSON.parse(JSON.stringify(declaration())) as Record<string, unknown>;
		const shuffled = {
			keyId: reordered.keyId,
			artifacts: reordered.artifacts,
			launcherMinVersion: reordered.launcherMinVersion,
			manifestVersion: reordered.manifestVersion,
			platform: reordered.platform,
			releaseVersion: reordered.releaseVersion,
			declarationVersion: reordered.declarationVersion,
		};
		expect(canonicalizeReleaseDeclaration(shuffled)).toBe(canonicalizeReleaseDeclaration(a));
	});

	it("sorts keys recursively and emits no insignificant whitespace", () => {
		const canonical = canonicalizeReleaseDeclaration(declaration());
		expect(canonical).not.toContain(" ");
		expect(canonical).not.toContain("\n");
		// artifacts 内的对象键同样要排序。
		expect(canonical).toContain('"artifacts":[{"executable":false,"path":');
	});

	it("refuses values that cannot round-trip deterministically", () => {
		// NaN/Infinity 会让不同平台的序列化结果不一致，必须拒绝而不是写出非法 JSON。
		expect(() =>
			canonicalizeReleaseDeclaration(declaration({ manifestVersion: Number.NaN })),
		).toThrow();
		expect(() =>
			canonicalizeReleaseDeclaration({ ...declaration(), extra: undefined }),
		).toThrow();
	});
});

describe("parseReleaseDeclaration", () => {
	it("accepts a well-formed declaration", () => {
		const parsed = parseReleaseDeclaration(JSON.parse(JSON.stringify(declaration())));
		expect(parsed.releaseVersion).toBe("1.2.3");
		expect(parsed.artifacts).toHaveLength(2);
	});

	it("rejects unknown fields instead of ignoring them", () => {
		expect(() =>
			parseReleaseDeclaration({ ...declaration(), signedBy: "attacker" }),
		).toThrow();
		expect(() =>
			parseReleaseDeclaration({
				...declaration(),
				artifacts: [{ ...declaration().artifacts[0], note: "x" }],
			}),
		).toThrow();
	});

	it("rejects a malformed digest, size, platform or role", () => {
		expect(() =>
			parseReleaseDeclaration({ ...declaration(), platform: "mac-arm64" }),
		).toThrow();
		expect(() =>
			parseReleaseDeclaration({
				...declaration(),
				artifacts: [{ ...declaration().artifacts[0], sha256: "A".repeat(64) }],
			}),
		).toThrow();
		expect(() =>
			parseReleaseDeclaration({
				...declaration(),
				artifacts: [{ ...declaration().artifacts[0], size: 0 }],
			}),
		).toThrow();
		expect(() =>
			parseReleaseDeclaration({
				...declaration(),
				artifacts: [{ ...declaration().artifacts[0], role: "rootkit" }],
			}),
		).toThrow();
	});

	it("rejects an empty artifact list and duplicate entries", () => {
		expect(() => parseReleaseDeclaration({ ...declaration(), artifacts: [] })).toThrow();
		// 同一 path 出现两次会让“验证过的那个”与“实际解压的那个”不是同一个文件。
		expect(() =>
			parseReleaseDeclaration({
				...declaration(),
				artifacts: [
					declaration().artifacts[1],
					{ ...declaration().artifacts[1], role: "session-helper" },
				],
			}),
		).toThrow();
	});

	it("rejects an unsupported declaration version", () => {
		expect(() =>
			parseReleaseDeclaration({ ...declaration(), declarationVersion: 2 }),
		).toThrow();
	});
});

describe("assertArtifactMatches", () => {
	it("accepts a matching artifact and rejects digest or size drift", () => {
		const artifact = declaration().artifacts[1];
		expect(() =>
			assertArtifactMatches(artifact, { sha256: artifact.sha256, size: artifact.size }),
		).not.toThrow();
		expect(() =>
			assertArtifactMatches(artifact, { sha256: "c".repeat(64), size: artifact.size }),
		).toThrow();
		expect(() =>
			assertArtifactMatches(artifact, { sha256: artifact.sha256, size: artifact.size + 1 }),
		).toThrow();
	});
});

describe("assertLauncherVersionSatisfies", () => {
	it("enforces launcherMinVersion as a hard gate", () => {
		const parsed = declaration({ launcherMinVersion: "2.0.0" });
		expect(() => assertLauncherVersionSatisfies(parsed, "2.0.0")).not.toThrow();
		expect(() => assertLauncherVersionSatisfies(parsed, "2.1.0")).not.toThrow();
		// 低于下限只能走受控引导升级，不能运行新特权构件。
		expect(() => assertLauncherVersionSatisfies(parsed, "1.9.9")).toThrow();
		expect(() => assertLauncherVersionSatisfies(parsed, "0.1.0")).toThrow();
	});

	it("compares numeric segments instead of strings", () => {
		const parsed = declaration({ launcherMinVersion: "1.10.0" });
		// 字符串比较会认为 "1.9.0" > "1.10.0"，必须按数字段比较。
		expect(() => assertLauncherVersionSatisfies(parsed, "1.9.0")).toThrow();
		expect(() => assertLauncherVersionSatisfies(parsed, "1.10.0")).not.toThrow();
	});

	it("refuses a malformed current version rather than assuming it is new enough", () => {
		expect(() => assertLauncherVersionSatisfies(declaration(), "not-a-version")).toThrow();
	});
});

describe("assertArchiveEntriesAllowed", () => {
	const parsed = declaration();

	it("accepts declared entries", () => {
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
				{ path: "bin/desktop-host.exe", executable: true },
			]),
		).not.toThrow();
	});

	it("allows undeclared non-executable payload such as the manifest", () => {
		// allowlist 只约束可执行文件；普通数据文件可以存在。
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
				{ path: "bin/desktop-host.exe", executable: true },
				{ path: "manifest.json", executable: false },
			]),
		).not.toThrow();
	});

	it("rejects an undeclared executable", () => {
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
				{ path: "bin/desktop-host.exe", executable: true },
				{ path: "bin/evil.exe", executable: true },
			]),
		).toThrow();
	});

	it("rejects entries that escape the archive root", () => {
		for (const path of [
			"../outside.exe",
			"bin/../../outside.exe",
			"/etc/passwd",
			"C:\\Windows\\System32\\evil.exe",
			"..\\..\\evil.exe",
		]) {
			expect(() =>
				assertArchiveEntriesAllowed(parsed, [
					{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
					{ path: "bin/desktop-host.exe", executable: true },
					{ path, executable: false },
				]),
			).toThrow();
		}
	});

	it("rejects duplicate entries case-insensitively", () => {
		// 大小写不敏感文件系统上这两个会互相覆盖，“验证过的”与“解压出来的”可能不是同一个。
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
				{ path: "bin/desktop-host.exe", executable: true },
				{ path: "BIN/Desktop-Host.exe", executable: true },
			]),
		).toThrow();
	});

	it("rejects a declaration whose artifact is missing from the archive", () => {
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: false },
			]),
		).toThrow();
	});

	it("rejects an executable flag that contradicts the declaration", () => {
		// 声明为非可执行却带着可执行位：必须 fail closed。
		expect(() =>
			assertArchiveEntriesAllowed(parsed, [
				{ path: "vcpdeck-1.2.3-win-x64.zip", executable: true },
				{ path: "bin/desktop-host.exe", executable: true },
			]),
		).toThrow();
	});
});
