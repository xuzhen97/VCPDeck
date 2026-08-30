import { describe, expect, it } from "vitest";
import {
	isReleaseArchiveAvailable,
	parseReleaseUploadComplete,
	parseReleaseUploadCreateInput,
	parseReleaseUploadPartRefresh,
	type ReleaseArchiveInfo,
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
