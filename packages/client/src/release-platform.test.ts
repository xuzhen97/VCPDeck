import { describe, expect, it } from "vitest";
import { detectLibc, detectReleasePlatform } from "./release-platform.js";

describe("detectReleasePlatform（ADR-0065）", () => {
	it("Linux x64 musl → linux-x64-musl", () => {
		expect(
			detectReleasePlatform({ platform: "linux", arch: "x64", libc: "musl" }),
		).toBe("linux-x64-musl");
	});

	it("Linux x64 glibc → linux-x64", () => {
		expect(
			detectReleasePlatform({ platform: "linux", arch: "x64", libc: "glibc" }),
		).toBe("linux-x64");
	});

	it("libc 无法证明时不猜测平台", () => {
		expect(
			detectReleasePlatform({ platform: "linux", arch: "x64", libc: "unknown" }),
		).toBeUndefined();
	});

	it("非 x64 架构不上报发布平台", () => {
		expect(
			detectReleasePlatform({ platform: "linux", arch: "arm64", libc: "musl" }),
		).toBeUndefined();
		expect(
			detectReleasePlatform({ platform: "darwin", arch: "x64", libc: "unknown" }),
		).toBeUndefined();
	});

	it("Windows x64 → win-x64（与 libc 无关）", () => {
		expect(
			detectReleasePlatform({ platform: "win32", arch: "x64", libc: "unknown" }),
		).toBe("win-x64");
	});
});

describe("detectLibc（只看可信系统事实）", () => {
	it("process.report 的 glibcVersionRuntime 是 glibc 的直接证据", () => {
		expect(detectLibc({ glibcVersionRuntime: "2.36" })).toBe("glibc");
	});

	it("没有 glibc 字段但存在 musl loader → musl", () => {
		expect(detectLibc({ muslLoader: true })).toBe("musl");
	});

	it("只有 glibc loader → glibc", () => {
		expect(detectLibc({ glibcLoader: true })).toBe("glibc");
	});

	it("无任何证据 → unknown（不把缺字段等价 musl）", () => {
		expect(detectLibc({})).toBe("unknown");
	});
});
