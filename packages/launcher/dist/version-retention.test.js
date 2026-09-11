"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const version_retention_js_1 = require("./version-retention.js");
function makeVersions(overrides = {}) {
    return {
        currentVersion: vitest_1.vi.fn().mockResolvedValue("1.2.0"),
        listVersions: vitest_1.vi.fn().mockResolvedValue(["1.0.0", "1.1.0", "1.2.0"]),
        removeVersion: vitest_1.vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}
const state = (successfulVersions) => JSON.stringify({ successfulVersions });
(0, vitest_1.describe)("VersionRetention", () => {
    let appsDir;
    (0, vitest_1.afterEach)(async () => {
        if (appsDir)
            await (0, promises_1.rm)(appsDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("首次无 retention.json 时原子写入 current 基线且不删除旧目录", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue(["1.0.0", "1.2.0"]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        (0, vitest_1.expect)(JSON.parse(await (0, promises_1.readFile)((0, node_path_1.join)(appsDir, "retention.json"), "utf8"))).toEqual({
            successfulVersions: ["1.2.0"],
        });
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalled();
        (0, vitest_1.expect)((await (0, promises_1.readdir)(appsDir)).filter((name) => name.includes("retention.json.tmp"))).toEqual([]);
    });
    vitest_1.it.each([
        ["损坏 JSON", "{"],
        ["字段非数组", JSON.stringify({ successfulVersions: "1.2.0" })],
        ["版本名非法", state(["1.2.0", "latest"])],
    ])("%s 时返回 disabled，不覆盖状态且不删除目录", async (_name, raw) => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), raw);
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue(["1.0.0", "1.1.0", "1.2.0"]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        const result = await retention.cleanup();
        (0, vitest_1.expect)(result).toEqual({ removed: [], failed: [], disabled: true });
        (0, vitest_1.expect)(await (0, promises_1.readFile)((0, node_path_1.join)(appsDir, "retention.json"), "utf8")).toBe(raw);
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("recordSuccessful 去重并将成功版本置于首位", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions: makeVersions() });
        await retention.initialize();
        (0, vitest_1.expect)(await retention.recordSuccessful("1.1.0")).toBe(true);
        (0, vitest_1.expect)(JSON.parse(await (0, promises_1.readFile)((0, node_path_1.join)(appsDir, "retention.json"), "utf8"))).toEqual({
            successfulVersions: ["1.1.0", "1.2.0", "1.0.0"],
        });
    });
    (0, vitest_1.it)("历史不足 current 加两个已知成功版本时不清理未知 legacy 目录", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0"]));
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue(["0.9.0", "1.1.0", "1.2.0"]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        const result = await retention.cleanup();
        (0, vitest_1.expect)(result).toEqual({ removed: [], failed: [], disabled: false });
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("历史达到三项后只删除不在保护集合中的合法 SemVer 目录", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue([
                "0.9.0",
                "1.0.0",
                "1.1.0",
                "1.2.0",
                "2.0.0",
            ]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        const result = await retention.cleanup(new Set(["2.0.0"]));
        (0, vitest_1.expect)(result).toEqual({ removed: ["0.9.0"], failed: [], disabled: false });
        (0, vitest_1.expect)(versions.removeVersion).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
    });
    (0, vitest_1.it)("显式 protected target/previous、current 和特殊文件名永不删除", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue([
                "0.9.0",
                "1.0.0",
                "1.1.0",
                "1.2.0",
                "2.0.0",
                "state.json",
                "retention.json",
            ]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        await retention.cleanup(new Set(["2.0.0", "1.1.0"]));
        (0, vitest_1.expect)(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("1.0.0");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("1.1.0");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("1.2.0");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("2.0.0");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("state.json");
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalledWith("retention.json");
    });
    (0, vitest_1.it)("单个删除失败时继续处理其他候选并返回安全失败计数", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue(["0.8.0", "0.9.0", "1.0.0", "1.1.0", "1.2.0"]),
            removeVersion: vitest_1.vi
                .fn()
                .mockRejectedValueOnce(new Error("permission denied"))
                .mockResolvedValueOnce(undefined),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions });
        await retention.initialize();
        const result = await retention.cleanup();
        (0, vitest_1.expect)(result).toEqual({ removed: ["0.9.0"], failed: ["0.8.0"], disabled: false });
        (0, vitest_1.expect)(versions.removeVersion).toHaveBeenCalledWith("0.8.0");
        (0, vitest_1.expect)(versions.removeVersion).toHaveBeenCalledWith("0.9.0");
    });
    (0, vitest_1.it)("状态写入使用同目录 temp + rename 且不遗留临时文件", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions: makeVersions() });
        await retention.initialize();
        await retention.recordSuccessful("1.3.0");
        (0, vitest_1.expect)(JSON.parse(await (0, promises_1.readFile)((0, node_path_1.join)(appsDir, "retention.json"), "utf8"))).toEqual({
            successfulVersions: ["1.3.0", "1.2.0"],
        });
        (0, vitest_1.expect)((await (0, promises_1.readdir)(appsDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
    });
    (0, vitest_1.it)("合法历史补写 current 失败时 disabled，不把状态降级成 current 基线", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        const raw = state(["1.1.0", "1.0.0", "0.9.0"]);
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), raw);
        const fs = {
            readFile: async (path) => (0, promises_1.readFile)(path, "utf8"),
            writeFile: async () => {
                throw new Error("read-only");
            },
            rename: async () => undefined,
            rm: async () => undefined,
        };
        const versions = makeVersions({
            currentVersion: vitest_1.vi.fn().mockResolvedValue("1.2.0"),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions, fs });
        await retention.initialize();
        const result = await retention.cleanup();
        (0, vitest_1.expect)(result).toEqual({ removed: [], failed: [], disabled: true });
        (0, vitest_1.expect)(await (0, promises_1.readFile)((0, node_path_1.join)(appsDir, "retention.json"), "utf8")).toBe(raw);
    });
    (0, vitest_1.it)("成功历史写入失败时保留旧内存状态，不使用未持久化的新顺序清理", async () => {
        appsDir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "version-retention-"));
        await (0, promises_1.writeFile)((0, node_path_1.join)(appsDir, "retention.json"), state(["1.2.0", "1.1.0", "1.0.0"]));
        let writes = 0;
        const fs = {
            readFile: async (path) => (0, promises_1.readFile)(path, "utf8"),
            writeFile: async () => {
                writes++;
                throw new Error("read-only");
            },
            rename: async () => undefined,
            rm: async () => undefined,
        };
        const versions = makeVersions({
            listVersions: vitest_1.vi.fn().mockResolvedValue(["0.9.0", "1.0.0", "1.1.0", "1.2.0"]),
        });
        const retention = new version_retention_js_1.VersionRetention({ appsDir, versions, fs });
        await retention.initialize();
        (0, vitest_1.expect)(await retention.recordSuccessful("1.3.0")).toBe(false);
        const result = await retention.cleanup();
        (0, vitest_1.expect)(writes).toBe(1);
        (0, vitest_1.expect)(result).toEqual({ removed: [], failed: [], disabled: true });
        (0, vitest_1.expect)(versions.removeVersion).not.toHaveBeenCalled();
    });
});
