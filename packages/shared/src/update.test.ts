import { describe, expect, it } from "vitest";
import {
	parseReleaseUploadComplete,
	parseReleaseUploadCreateInput,
	parseReleaseUploadPartRefresh,
} from "./update.js";

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
