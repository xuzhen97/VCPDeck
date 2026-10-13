import { describe, expect, it } from "vitest";
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
