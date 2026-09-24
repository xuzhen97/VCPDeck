import { describe, expect, it } from "vitest";
import { readSdkVersion } from "./probe-worker.js";

/**
 * 版本事实门禁：Pi SDK 版本必须来自运行时 VERSION 导出。
 * 硬编码版本字符串会在 SDK 升级后谎报版本，进而影响 Server 的兼容性判定。
 */
describe("probe worker 版本事实", () => {
	it("读取的 sdkVersion 等于 SDK VERSION，而不是硬编码", async () => {
		const { VERSION } = await import("@earendil-works/pi-coding-agent");
		await expect(readSdkVersion()).resolves.toBe(VERSION);
	});
});
