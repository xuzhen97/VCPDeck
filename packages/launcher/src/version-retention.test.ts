import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	VersionRetention,
	type VersionRetentionFsOps,
} from "./version-retention.js";

interface FakeVersions {
	currentVersion: ReturnType<typeof vi.fn>;
	listVersions: ReturnType<typeof vi.fn>;
	removeVersion: ReturnType<typeof vi.fn>;
}

function makeVersions(overrides: Partial<FakeVersions> = {}): FakeVersions {
	return {
		currentVersion: vi.fn().mockResolvedValue("1.2.0"),
		listVersions: vi.fn().mockResolvedValue(["1.0.0", "1.1.0", "1.2.0"]),
		removeVersion: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

const state = (successfulVersions: string[]) =>
	JSON.stringify({ successfulVersions });

describe("VersionRetention", () => {
	let appsDir: string;

	afterEach(async () => {
		if (appsDir) await rm(appsDir, { recursive: true, force: true });
	});

	it("首次无 retention.json 时原子写入 current 基线且不删除旧目录", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue(["1.0.0", "1.2.0"]),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();

		expect(JSON.parse(await readFile(join(appsDir, "retention.json"), "utf8"))).toEqual({
			successfulVersions: ["1.2.0"],
		});
		expect(versions.removeVersion).not.toHaveBeenCalled();
		expect((await readdir(appsDir)).filter((name) => name.includes("retention.json.tmp"))).toEqual([]);
	});

	it.each([
		["损坏 JSON", "{"],
		["字段非数组", JSON.stringify({ successfulVersions: "1.2.0" })],
		["版本名非法", state(["1.2.0", "latest"])],
	])("%s 时返回 disabled，不覆盖状态且不删除目录", async (_name, raw) => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), raw);
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue(["1.0.0", "1.1.0", "1.2.0"]),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();
		const result = await retention.cleanup();

		expect(result).toEqual({ removed: [], failed: [], disabled: true });
		expect(await readFile(join(appsDir, "retention.json"), "utf8")).toBe(raw);
		expect(versions.removeVersion).not.toHaveBeenCalled();
	});

	it("recordSuccessful 去重并将成功版本置于首位", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
		const retention = new VersionRetention({ appsDir, versions: makeVersions() });

		await retention.initialize();
		expect(await retention.recordSuccessful("1.1.0")).toBe(true);

		expect(JSON.parse(await readFile(join(appsDir, "retention.json"), "utf8"))).toEqual({
			successfulVersions: ["1.1.0", "1.2.0", "1.0.0"],
		});
	});

	it("历史不足 current 加两个已知成功版本时不清理未知 legacy 目录", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0"]));
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue(["0.9.0", "1.1.0", "1.2.0"]),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();
		const result = await retention.cleanup();

		expect(result).toEqual({ removed: [], failed: [], disabled: false });
		expect(versions.removeVersion).not.toHaveBeenCalled();
	});

	it("历史达到三项后只删除不在保护集合中的合法 SemVer 目录", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue([
				"0.9.0",
				"1.0.0",
				"1.1.0",
				"1.2.0",
				"2.0.0",
			]),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();
		const result = await retention.cleanup(new Set(["2.0.0"]));

		expect(result).toEqual({ removed: ["0.9.0"], failed: [], disabled: false });
		expect(versions.removeVersion).toHaveBeenCalledTimes(1);
		expect(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
	});

	it("显式 protected target/previous、current 和特殊文件名永不删除", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue([
				"0.9.0",
				"1.0.0",
				"1.1.0",
				"1.2.0",
				"2.0.0",
				"state.json",
				"retention.json",
			]),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();
		await retention.cleanup(new Set(["2.0.0", "1.1.0"]));

		expect(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("1.0.0");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("1.1.0");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("1.2.0");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("2.0.0");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("state.json");
		expect(versions.removeVersion).not.toHaveBeenCalledWith("retention.json");
	});

	it("单个删除失败时继续处理其他候选并返回安全失败计数", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue(["0.8.0", "0.9.0", "1.0.0", "1.1.0", "1.2.0"]),
			removeVersion: vi
				.fn()
			.mockRejectedValueOnce(new Error("permission denied"))
			.mockResolvedValueOnce(undefined),
		});
		const retention = new VersionRetention({ appsDir, versions });

		await retention.initialize();
		const result = await retention.cleanup();

		expect(result).toEqual({ removed: ["0.9.0"], failed: ["0.8.0"], disabled: false });
		expect(versions.removeVersion).toHaveBeenCalledWith("0.8.0");
		expect(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
	});

	it("状态写入使用同目录 temp + rename 且不遗留临时文件", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		const retention = new VersionRetention({ appsDir, versions: makeVersions() });

		await retention.initialize();
		await retention.recordSuccessful("1.3.0");

		expect(JSON.parse(await readFile(join(appsDir, "retention.json"), "utf8"))).toEqual({
			successfulVersions: ["1.3.0", "1.2.0"],
		});
		expect((await readdir(appsDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
	});

	it("合法历史补写 current 失败时 disabled，不把状态降级成 current 基线", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		const raw = state(["1.1.0", "1.0.0", "0.9.0"]);
		await writeFile(join(appsDir, "retention.json"), raw);
		const fs: VersionRetentionFsOps = {
			readFile: async (path) => readFile(path, "utf8"),
			writeFile: async () => {
				throw new Error("read-only");
			},
			rename: async () => undefined,
			rm: async () => undefined,
		};
		const versions = makeVersions({
			currentVersion: vi.fn().mockResolvedValue("1.2.0"),
		});
		const retention = new VersionRetention({ appsDir, versions, fs });

		await retention.initialize();
		const result = await retention.cleanup();

		expect(result).toEqual({ removed: [], failed: [], disabled: true });
		expect(await readFile(join(appsDir, "retention.json"), "utf8")).toBe(raw);
	});

	it("成功历史写入失败时保留旧内存状态，不使用未持久化的新顺序清理", async () => {
		appsDir = await mkdtemp(join(tmpdir(), "version-retention-"));
		await writeFile(join(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
		let writes = 0;
		const fs: VersionRetentionFsOps = {
			readFile: async (path) => readFile(path, "utf8"),
			writeFile: async () => {
				writes++;
				throw new Error("read-only");
			},
			rename: async () => undefined,
			rm: async () => undefined,
		};
		const versions = makeVersions({
			listVersions: vi.fn().mockResolvedValue(["0.9.0", "1.0.0", "1.1.0", "1.2.0"]),
		});
		const retention = new VersionRetention({ appsDir, versions, fs });

		await retention.initialize();
		expect(await retention.recordSuccessful("1.3.0")).toBe(false);
		const result = await retention.cleanup();

		expect(writes).toBe(1);
		expect(result).toEqual({ removed: [], failed: [], disabled: true });
		expect(versions.removeVersion).not.toHaveBeenCalled();
	});
});
