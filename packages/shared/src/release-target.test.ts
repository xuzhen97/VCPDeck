import { describe, expect, it } from "vitest";
import {
	clientReleasePlatform,
	parseMuslReleaseTarget,
	parseReleasePlatform,
	RELEASE_PLATFORMS,
	REQUIRED_RELEASE_PLATFORMS,
	selectClientReleaseArchive,
} from "./release-target.js";
import type { ReleaseInfo } from "./update.js";

describe("发布目标平台（ADR-0065）", () => {
	it("识别 musl 平台，拒绝拼错值与空值", () => {
		expect(parseReleasePlatform("linux-x64-musl")).toBe("linux-x64-musl");
		expect(parseReleasePlatform("win-x64")).toBe("win-x64");
		expect(parseReleasePlatform("linux-x64")).toBe("linux-x64");
		expect(() => parseReleasePlatform("linux-arm64-musl")).toThrow();
		expect(() => parseReleasePlatform("linux-x64-musl ")).toThrow();
		expect(() => parseReleasePlatform(undefined)).toThrow();
	});

	it("常规发布必须齐备的平台不含 musl，musl 仍属已知平台", () => {
		expect([...REQUIRED_RELEASE_PLATFORMS]).toEqual(["win-x64", "linux-x64"]);
		expect([...RELEASE_PLATFORMS]).toEqual([
			"win-x64",
			"linux-x64",
			"linux-x64-musl",
		]);
	});

	it("由 OS 与可选上报推导发布目标，旧客户端保持历史 glibc 映射", () => {
		expect(clientReleasePlatform("linux", "linux-x64-musl")).toBe(
			"linux-x64-musl",
		);
		expect(clientReleasePlatform("linux", "linux-x64")).toBe("linux-x64");
		expect(clientReleasePlatform("linux")).toBe("linux-x64");
		expect(clientReleasePlatform("win32", "win-x64")).toBe("win-x64");
		expect(clientReleasePlatform("win32")).toBe("win-x64");
		expect(clientReleasePlatform("win32", "linux-x64-musl")).toBeUndefined();
		expect(clientReleasePlatform("linux", "win-x64")).toBeUndefined();
		expect(clientReleasePlatform("darwin", "win-x64")).toBeUndefined();
		expect(clientReleasePlatform("darwin")).toBeUndefined();
	});
});

const muslTargetFixture = {
	schema: 1,
	platform: "linux-x64-musl",
	role: "client",
	runtime: {
		version: "24.11.1",
		url: "https://unofficial-builds.nodejs.org/download/release/v24.11.1/node-v24.11.1-linux-x64-musl.tar.gz",
		sha256: "a".repeat(64),
	},
};

describe("musl 发布目标描述（ADR-0065）", () => {
	it("解析合法描述并与原件等价", () => {
		expect(parseMuslReleaseTarget(muslTargetFixture)).toEqual(
			muslTargetFixture,
		);
	});

	it("拒绝未知字段，避免未签名语义被偷带", () => {
		expect(() =>
			parseMuslReleaseTarget({ ...muslTargetFixture, extra: true }),
		).toThrow();
		expect(() =>
			parseMuslReleaseTarget({
				...muslTargetFixture,
				runtime: { ...muslTargetFixture.runtime, extra: 1 },
			}),
		).toThrow();
	});

	it("只接受批准的 https 构建源、Node 24 与同名 tarball", () => {
		const withRuntime = (patch: Record<string, unknown>) =>
			parseMuslReleaseTarget({
				...muslTargetFixture,
				runtime: { ...muslTargetFixture.runtime, ...patch },
			});
		expect(() =>
			withRuntime({ url: "http://unofficial-builds.nodejs.org/x.tar.gz" }),
		).toThrow();
		expect(() =>
			withRuntime({ url: "https://example.com/node-v24.11.1-linux-x64-musl.tar.gz" }),
		).toThrow();
		expect(() =>
			withRuntime({
				url: "https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64-musl.tar.gz",
			}),
		).not.toThrow();
		expect(() =>
			withRuntime({
				url: "https://unofficial-builds.nodejs.org/download/release/v24.11.1/node-v24.11.1-linux-x64.tar.gz",
			}),
		).toThrow();
		expect(() => withRuntime({ version: "20.20.2" })).toThrow();
	});

	it("拒绝错误 hash、平台、角色与 schema", () => {
		expect(() =>
			parseMuslReleaseTarget({
				...muslTargetFixture,
				runtime: { ...muslTargetFixture.runtime, sha256: "ABC" },
			}),
		).toThrow();
		expect(() =>
			parseMuslReleaseTarget({ ...muslTargetFixture, platform: "linux-x64" }),
		).toThrow();
		expect(() =>
			parseMuslReleaseTarget({ ...muslTargetFixture, role: "server" }),
		).toThrow();
		expect(() =>
			parseMuslReleaseTarget({ ...muslTargetFixture, schema: 2 }),
		).toThrow();
	});
});

describe("selectClientReleaseArchive（Task 6）", () => {
	const fileOf = (name: string) => ({
		sha256: "b".repeat(64),
		size: 1024,
		fileName: name,
	});
	const releaseOf = (
		archives: Record<string, unknown>,
	): ReleaseInfo =>
		({
			version: "0.24.0",
			archives,
			status: "done",
			createdAt: "2026-11-14T00:00:00.000Z",
			updatedAt: "2026-11-14T00:00:00.000Z",
			clientStates: {},
		}) as unknown as ReleaseInfo;

	it("显式 musl 机器拿到 musl 全量包", () => {
		const release = releaseOf({
			"linux-x64": fileOf("vcpdeck-0.24.0-linux-x64.zip"),
			"linux-x64-musl": fileOf("vcpdeck-0.24.0-linux-x64-musl.zip"),
		});
		expect(
			selectClientReleaseArchive(release, "linux 6.6.144", "linux-x64-musl")
				?.fileName,
		).toBe("vcpdeck-0.24.0-linux-x64-musl.zip");
	});

	it("缺 musl 构件时 fail closed，不回落到 glibc 包", () => {
		const release = releaseOf({
			"linux-x64": fileOf("vcpdeck-0.24.0-linux-x64.zip"),
		});
		expect(
			selectClientReleaseArchive(release, "linux 6.6.144", "linux-x64-musl"),
		).toBeUndefined();
	});

	it("旧 Client 未上报平台时仍按 os 走 glibc", () => {
		const release = releaseOf({
			"linux-x64": fileOf("vcpdeck-0.24.0-linux-x64.zip"),
			"linux-x64-musl": fileOf("vcpdeck-0.24.0-linux-x64-musl.zip"),
		});
		expect(
			selectClientReleaseArchive(release, "linux 6.6.144")?.fileName,
		).toBe("vcpdeck-0.24.0-linux-x64.zip");
	});

	it("Windows 只认 win-x64", () => {
		const release = releaseOf({
			"win-x64": fileOf("vcpdeck-0.24.0-win-x64.zip"),
			"linux-x64": fileOf("vcpdeck-0.24.0-linux-x64.zip"),
		});
		expect(selectClientReleaseArchive(release, "win32 10.0.26200")?.fileName).toBe(
			"vcpdeck-0.24.0-win-x64.zip",
		);
	});

	it("被清理的构件不可下发", () => {
		const release = releaseOf({
			"linux-x64-musl": {
				...fileOf("vcpdeck-0.24.0-linux-x64-musl.zip"),
				availability: "cleaned",
				cleanedAt: "2026-11-14T00:00:00.000Z",
				cleanupReason: "retention_policy",
			},
		});
		expect(
			selectClientReleaseArchive(release, "linux 6.6.144", "linux-x64-musl"),
		).toBeUndefined();
	});
});
