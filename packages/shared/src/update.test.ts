import { describe, expect, it } from "vitest";
import * as update from "./update.js";
import {
	hasAllReleaseArchives,
	isCatchUpTarget,
	isReleaseArchiveAvailable,
	parseReleaseUploadComplete,
	parseReleaseUploadCreateInput,
	parseReleaseUploadPartRefresh,
	ReleaseStatus,
	selectLatestCatchUpTarget,
	type ReleaseArchiveInfo,
	type ReleaseInfo,
} from "./update.js";

describe("Release archive 生命周期", () => {
	it("只有 available archive 可用于下载和编排", () => {
		const base = { sha256: "a".repeat(64), size: 1, fileName: "x.zip" };
		expect(
			isReleaseArchiveAvailable({ ...base, availability: "available" }),
		).toBe(true);
		expect(
			isReleaseArchiveAvailable({ ...base, availability: "deleting" }),
		).toBe(false);
		expect(
			isReleaseArchiveAvailable({
				...base,
				availability: "cleaned",
				cleanedAt: "2026-08-29T00:00:00.000Z",
				cleanupReason: "retention_policy",
			}),
		).toBe(false);
	});

	it("cleaned archive 保留审计摘要但不保留存储 key", () => {
		const cleaned: ReleaseArchiveInfo = {
			availability: "cleaned",
			sha256: "a".repeat(64),
			size: 1,
			fileName: "x.zip",
			storageSummary: { provider: "alibaba", mode: "direct" },
			cleanedAt: "2026-08-29T00:00:00.000Z",
			cleanupReason: "retention_policy",
		};
		expect(cleaned.storageSummary?.provider).toBe("alibaba");
		expect("storage" in cleaned).toBe(false);
	});
});

describe("Release 上传会话 parser", () => {
	it("严格解析创建会话输入", () => {
		expect(
			parseReleaseUploadCreateInput({
				version: "0.2.1",
				platform: "win-x64",
				sha256: "a".repeat(64),
				size: 123,
			}),
		).toEqual({
			version: "0.2.1",
			platform: "win-x64",
			sha256: "a".repeat(64),
			size: 123,
		});
		expect(() =>
			parseReleaseUploadCreateInput({
				version: "0.2.1",
				platform: "win-x64",
				sha256: "a".repeat(64),
				size: 123,
				psk: "secret",
			}),
		).toThrow("必须且只能包含");
	});

	it("严格解析刷新分片和完成输入", () => {
		expect(parseReleaseUploadPartRefresh({ partNumbers: [1, 2] })).toEqual({
			partNumbers: [1, 2],
		});
		expect(() => parseReleaseUploadPartRefresh({ partNumbers: [1, 1] })).toThrow(
			"不重复",
		);
		expect(parseReleaseUploadComplete({ uploadedBytes: 123 })).toEqual({
			uploadedBytes: 123,
		});
		expect(() => parseReleaseUploadComplete({ uploadedBytes: 0 })).toThrow(
			"uploadedBytes",
		);
	});

	it("首个 full 会话可声明 expectedFromVersions，且严格校验 x.y.z 去重与上限", () => {
		const base = {
			version: "0.2.1",
			platform: "win-x64" as const,
			sha256: "a".repeat(64),
			size: 123,
		};
		expect(
			parseReleaseUploadCreateInput({
				...base,
				expectedFromVersions: ["0.22.1", "0.22.0"],
			}),
		).toEqual({ ...base, expectedFromVersions: ["0.22.1", "0.22.0"] });
		expect(
			parseReleaseUploadCreateInput({ ...base, expectedFromVersions: [] }),
		).toEqual({ ...base, expectedFromVersions: [] });
		expect(() =>
			parseReleaseUploadCreateInput({
				...base,
				expectedFromVersions: "0.22.1",
			}),
		).toThrow("expectedFromVersions");
		expect(() =>
			parseReleaseUploadCreateInput({
				...base,
				expectedFromVersions: ["0.22"],
			}),
		).toThrow("expectedFromVersions");
		expect(() =>
			parseReleaseUploadCreateInput({
				...base,
				expectedFromVersions: ["0.22.1", "0.22.1"],
			}),
		).toThrow("expectedFromVersions");
		expect(() =>
			parseReleaseUploadCreateInput({
				...base,
				expectedFromVersions: ["1.0.0", "1.0.1", "1.0.2", "1.0.3"],
			}),
		).toThrow("expectedFromVersions");
	});
});

describe("Release 补更目标判定", () => {
	const archive = { sha256: "a".repeat(64), size: 1, fileName: "x.zip" };

	/** 构造最小可用的 release，仅覆盖判定所需字段。 */
	function release(
		overrides: Partial<ReleaseInfo> = {},
	): ReleaseInfo {
		return {
			version: "0.19.2",
			archives: {
				"win-x64": { ...archive },
				"linux-x64": { ...archive },
			},
			status: ReleaseStatus.DONE,
			createdAt: "2026-10-12T00:00:00.000Z",
			updatedAt: "2026-10-12T00:00:00.000Z",
			clientStates: {},
			...overrides,
		};
	}

	it("双平台构件齐备且已完成的 release 可作为补更目标", () => {
		expect(isCatchUpTarget(release())).toBe(true);
		expect(
			isCatchUpTarget(release({ status: ReleaseStatus.UPDATING_CLIENTS })),
		).toBe(true);
	});

	it("缺任一平台构件或状态不可用时不是补更目标", () => {
		expect(
			isCatchUpTarget(release({ archives: { "win-x64": { ...archive } } })),
		).toBe(false);
		expect(
			isCatchUpTarget(
				release({
					archives: {
						"win-x64": {
							...archive,
							availability: "cleaned",
							cleanedAt: "2026-08-29T00:00:00.000Z",
							cleanupReason: "retention_policy",
						},
						"linux-x64": { ...archive },
					},
				}),
			),
		).toBe(false);
		expect(isCatchUpTarget(release({ status: ReleaseStatus.FAILED }))).toBe(
			false,
		);
		expect(isCatchUpTarget(release({ status: ReleaseStatus.UPLOADED }))).toBe(
			false,
		);
	});

	it("构件齐备判定不受状态影响，补更目标判定才要求状态", () => {
		const uploaded = release({ status: ReleaseStatus.UPLOADED });
		expect(hasAllReleaseArchives(uploaded)).toBe(true);
		expect(isCatchUpTarget(uploaded)).toBe(false);
		expect(
			hasAllReleaseArchives(release({ archives: { "win-x64": { ...archive } } })),
		).toBe(false);
	});

	it("选出最近一条补更目标，无候选时为 null", () => {
		const older = release({
			version: "0.19.1",
			createdAt: "2026-10-12T00:00:00.000Z",
		});
		const newer = release({
			version: "0.19.2",
			createdAt: "2026-10-13T00:00:00.000Z",
		});
		expect(selectLatestCatchUpTarget([older, newer])?.version).toBe("0.19.2");
		expect(selectLatestCatchUpTarget([newer, older])?.version).toBe("0.19.2");
		expect(selectLatestCatchUpTarget([])).toBeNull();
		expect(
			selectLatestCatchUpTarget([release({ status: ReleaseStatus.FAILED })]),
		).toBeNull();
	});
});

// ── 内容寻址发布构件契约（ADR-0062，控制协议 v2）──

/** 命名空间访问：集中引用新增契约导出。 */
const releaseContract = update;

describe("Release 上传会话多产物 parser", () => {
	const base = {
		version: "0.22.2",
		platform: "win-x64",
		sha256: "a".repeat(64),
		size: 123,
	};

	it("接受 artifactKind / fromVersion 可选字段且保留既有四键输入", () => {
		expect(parseReleaseUploadCreateInput(base)).toEqual(base);
		expect(
			parseReleaseUploadCreateInput({
				...base,
				artifactKind: "delta",
				fromVersion: "0.22.1",
			}),
		).toEqual({ ...base, artifactKind: "delta", fromVersion: "0.22.1" });
		expect(
			parseReleaseUploadCreateInput({
				...base,
				artifactKind: "full",
				fromVersion: "",
			}),
		).toEqual({ ...base, artifactKind: "full", fromVersion: "" });
	});

	it("拒绝非法 artifactKind、fromVersion 与未知键", () => {
		expect(() =>
			parseReleaseUploadCreateInput({ ...base, artifactKind: "other" }),
		).toThrow("artifactKind");
		expect(() =>
			parseReleaseUploadCreateInput({ ...base, fromVersion: "latest" }),
		).toThrow("fromVersion");
		expect(() =>
			parseReleaseUploadCreateInput({ ...base, fromVersion: "0.22" }),
		).toThrow("fromVersion");
		expect(() =>
			parseReleaseUploadCreateInput({ ...base, unexpected: 1 }),
		).toThrow("必须且只能包含");
	});
});

describe("Release 清单文件条目与安全路径", () => {
	const parseFileEntry = (value: unknown): unknown =>
		(releaseContract.parseReleaseFileEntry as (v: unknown) => unknown)(value);
	const isSafePath = (value: string): boolean =>
		(releaseContract.isSafeReleaseFilePath as (v: string) => boolean)(value);

	const valid = {
		path: "server/dist/main.js",
		sha256: "a".repeat(64),
		size: 10,
		mode: 493,
	};

	it("严格解析文件条目并拒绝越界字段", () => {
		expect(parseFileEntry(valid)).toEqual(valid);
		expect(() => parseFileEntry({ ...valid, path: "../x" })).toThrow("path");
		expect(() => parseFileEntry({ ...valid, sha256: "ABC" })).toThrow("sha256");
		expect(() => parseFileEntry({ ...valid, size: -1 })).toThrow("size");
		expect(() => parseFileEntry({ ...valid, mode: 1.5 })).toThrow("mode");
		expect(() => parseFileEntry({ ...valid, extra: 1 })).toThrow(
			"必须且只能包含",
		);
	});

	it("isSafeReleaseFilePath 只接受相对 POSIX 路径", () => {
		expect(isSafePath("server/dist/main.js")).toBe(true);
		expect(isSafePath("../x")).toBe(false);
		expect(isSafePath("a/../b")).toBe(false);
		expect(isSafePath("/abs")).toBe(false);
		expect(isSafePath("C:\\x")).toBe(false);
		expect(isSafePath("C:/x")).toBe(false);
		expect(isSafePath("a\0b")).toBe(false);
		expect(isSafePath("")).toBe(false);
		expect(isSafePath("a/./b")).toBe(false);
		expect(isSafePath("a//b")).toBe(false);
		expect(isSafePath("a\\b")).toBe(false);
	});
});

describe("清单规范化与 delta 清单解析", () => {
	const canonical = (value: Record<string, unknown>): string =>
		(
			releaseContract.canonicalReleaseManifestJson as (
				v: Record<string, unknown>,
			) => string
		)(value);
	const parseDelta = (value: unknown): unknown =>
		(releaseContract.parseReleaseDeltaManifest as (v: unknown) => unknown)(
			value,
		);

	const manifest = {
		version: "0.22.2",
		protocolVersion: 2,
		kind: "delta",
		fromVersion: "0.22.1",
		files: [
			{
				path: "server/dist/main.js",
				sha256: "a".repeat(64),
				size: 1,
				mode: 493,
			},
		],
	};

	it("规范化字节与对象键序无关且键序固定", () => {
		const reordered = {
			files: manifest.files,
			fromVersion: manifest.fromVersion,
			kind: manifest.kind,
			protocolVersion: manifest.protocolVersion,
			version: manifest.version,
		};
		expect(canonical(manifest)).toBe(canonical(reordered));
		expect(canonical(manifest)).toBe(
			`{"version":"0.22.2","protocolVersion":2,"kind":"delta","fromVersion":"0.22.1","files":[{"path":"server/dist/main.js","sha256":"${"a".repeat(64)}","size":1,"mode":493}]}`,
		);
	});

	it("parseReleaseDeltaManifest 严格解析并拒绝篡改", () => {
		expect(parseDelta(manifest)).toEqual(manifest);
		expect(() => parseDelta({ ...manifest, kind: "full" })).toThrow("kind");
		expect(() => parseDelta({ ...manifest, protocolVersion: 1 })).toThrow(
			"protocolVersion",
		);
		expect(() =>
			parseDelta({
				...manifest,
				files: [{ ...manifest.files[0], path: "../x" }],
			}),
		).toThrow("path");
		expect(() => parseDelta({ ...manifest, extra: 1 })).toThrow(
			"必须且只能包含",
		);
	});
});

describe("控制协议常量与稳定错误码", () => {
	it("CONTROL_PROTOCOL_VERSION 为 2 且七个错误码自映射", () => {
		expect(releaseContract.CONTROL_PROTOCOL_VERSION).toBe(2);
		const codes = releaseContract.ReleaseArtifactErrorCode as Record<
			string,
			string
		>;
		expect(Object.keys(codes)).toHaveLength(7);
		for (const key of [
			"LAUNCHER_UPGRADE_REQUIRED",
			"MANIFEST_SIGNATURE_INVALID",
			"MANIFEST_PATH_UNSAFE",
			"FILE_HASH_MISMATCH",
			"DELTA_BASELINE_UNAVAILABLE",
			"ASSEMBLE_FAILED",
			"RELEASE_ARTIFACTS_INCOMPLETE",
		]) {
			expect(codes[key]).toBe(key);
		}
	});
});

describe("齐备判据覆盖声明的 delta 基线（ADR-0062:28 / ADR-0051 连带）", () => {
	const archive = { sha256: "a".repeat(64), size: 1, fileName: "x.zip" };
	const delta = {
		fromVersion: "0.22.1",
		sha256: "b".repeat(64),
		size: 2,
		fileName: "d.zip",
	};

	function release(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
		return {
			version: "0.22.2",
			archives: {
				"win-x64": { ...archive },
				"linux-x64": { ...archive },
			},
			status: ReleaseStatus.DONE,
			createdAt: "2026-11-11T00:00:00.000Z",
			updatedAt: "2026-11-11T00:00:00.000Z",
			clientStates: {},
			...overrides,
		};
	}

	const declared = (extra: Record<string, unknown>): ReleaseArchiveInfo =>
		({
			...archive,
			expectedFromVersions: ["0.22.1"],
			...extra,
		}) as ReleaseArchiveInfo;

	it("声明了 delta 基线但缺 deltas 时判为不齐备，并连带 isCatchUpTarget", () => {
		const r = release({
			archives: { "win-x64": declared({}), "linux-x64": declared({}) },
		});
		expect(hasAllReleaseArchives(r)).toBe(false);
		expect(isCatchUpTarget(r)).toBe(false);
	});

	it("deltas 覆盖 expectedFromVersions 后判为齐备", () => {
		const r = release({
			archives: {
				"win-x64": declared({ deltas: [delta] }),
				"linux-x64": declared({ deltas: [delta] }),
			},
		});
		expect(hasAllReleaseArchives(r)).toBe(true);
		expect(isCatchUpTarget(r)).toBe(true);
	});

	it("存量 Release 缺 expectedFromVersions 时双平台齐备即通过", () => {
		expect(hasAllReleaseArchives(release())).toBe(true);
	});
});
