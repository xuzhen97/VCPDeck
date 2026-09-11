"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const vitest_1 = require("vitest");
const ensure_node_js_1 = require("./ensure-node.js");
(0, vitest_1.describe)("satisfiesConstraint", () => {
    (0, vitest_1.it)(">=24 语义：只比较主版本", () => {
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("24.0.0", ">=24")).toBe(true);
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("v25.1.0", ">=24")).toBe(true);
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("23.9.9", ">=24")).toBe(false);
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("22.19.0", ">=24")).toBe(false);
    });
    (0, vitest_1.it)("非法版本/约束返回 false", () => {
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("abc", ">=24")).toBe(false);
        (0, vitest_1.expect)((0, ensure_node_js_1.satisfiesConstraint)("24.0.0", "bogus")).toBe(false);
    });
});
(0, vitest_1.describe)("parseNodeVersion", () => {
    (0, vitest_1.it)("解析 node -v 输出", () => {
        (0, vitest_1.expect)((0, ensure_node_js_1.parseNodeVersion)("v24.5.0")).toBe("24.5.0");
        (0, vitest_1.expect)((0, ensure_node_js_1.parseNodeVersion)("v24.5.0\n")).toBe("24.5.0");
        (0, vitest_1.expect)((0, ensure_node_js_1.parseNodeVersion)("not found")).toBeNull();
    });
});
(0, vitest_1.describe)("ensureNodeRuntime", () => {
    let dir;
    let cacheDir;
    let execNodeVersion;
    let fetchIndex;
    let downloadAndExtract;
    (0, vitest_1.beforeEach)(async () => {
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "ensure-node-"));
        cacheDir = (0, node_path_1.join)(dir, "node");
        execNodeVersion = vitest_1.vi.fn();
        fetchIndex = vitest_1.vi.fn();
        downloadAndExtract = vitest_1.vi.fn();
    });
    (0, vitest_1.afterEach)(async () => {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    });
    function run(constraint = ">=24", currentRuntime = { version: "22.0.0", execPath: "/private/node" }) {
        return (0, ensure_node_js_1.ensureNodeRuntime)({
            constraint,
            cacheDir,
            execNodeVersion,
            fetchIndex,
            downloadAndExtract,
            platform: "linux",
            arch: "x64",
            currentRuntime,
        });
    }
    (0, vitest_1.it)("Launcher 当前运行时满足约束 → 直接复用绝对路径，不依赖 PATH 或下载", async () => {
        await (0, vitest_1.expect)(run(">=24", {
            version: "26.8.1",
            execPath: "/home/user/.vcpdeck/runtime/node/node-26.8.1/bin/node",
        })).resolves.toBe("/home/user/.vcpdeck/runtime/node/node-26.8.1/bin/node");
        (0, vitest_1.expect)(execNodeVersion).not.toHaveBeenCalled();
        (0, vitest_1.expect)(fetchIndex).not.toHaveBeenCalled();
        (0, vitest_1.expect)(downloadAndExtract).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("系统 node 满足约束 → 直接用系统 node，不下载", async () => {
        execNodeVersion.mockResolvedValue("v24.5.0");
        await (0, vitest_1.expect)(run()).resolves.toBe("node");
        (0, vitest_1.expect)(fetchIndex).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("系统 node 版本过低 → 缓存中有满足版本 → 返回缓存路径", async () => {
        execNodeVersion.mockResolvedValue("v22.19.0");
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-24.5.0", "bin"), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(cacheDir, "node-24.5.0", "bin", "node"), "x");
        const path = await run();
        (0, vitest_1.expect)(path).toContain("node-24.5.0");
        (0, vitest_1.expect)(fetchIndex).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("无可用系统 node → 下载 index 中满足约束的最高版本", async () => {
        execNodeVersion.mockResolvedValue(null);
        fetchIndex.mockResolvedValue([
            { version: "v24.5.0" },
            { version: "v25.0.0" },
            { version: "v23.9.0" },
        ]);
        downloadAndExtract.mockResolvedValue((0, node_path_1.join)(cacheDir, "node-25.0.0", "bin", "node"));
        const path = await run();
        (0, vitest_1.expect)(path).toContain("node-25.0.0");
        (0, vitest_1.expect)(downloadAndExtract).toHaveBeenCalledWith("25.0.0", vitest_1.expect.stringContaining(cacheDir), vitest_1.expect.objectContaining({ platform: "linux", arch: "x64" }));
    });
    (0, vitest_1.it)("缓存多个版本时选满足约束的最高版本", async () => {
        execNodeVersion.mockResolvedValue(null);
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-24.1.0", "bin"), { recursive: true });
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-25.3.0", "bin"), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(cacheDir, "node-25.3.0", "bin", "node"), "x");
        const path = await run();
        (0, vitest_1.expect)(path).toContain("node-25.3.0");
    });
    (0, vitest_1.it)("缓存条目二进制缺失（损坏半成品）→ 跳过并回退下载", async () => {
        execNodeVersion.mockResolvedValue(null);
        // node-25.3.0 目录存在但二进制缺失（历史 bug 留下的半成品）
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-25.3.0", "bin"), { recursive: true });
        fetchIndex.mockResolvedValue([{ version: "v24.5.0" }]);
        downloadAndExtract.mockResolvedValue((0, node_path_1.join)(cacheDir, "node-24.5.0", "bin", "node"));
        const path = await run();
        (0, vitest_1.expect)(path).toContain("node-24.5.0");
        (0, vitest_1.expect)(fetchIndex).toHaveBeenCalled();
    });
    (0, vitest_1.it)("index 中无满足版本 → 抛错", async () => {
        execNodeVersion.mockResolvedValue(null);
        fetchIndex.mockResolvedValue([{ version: "v22.0.0" }]);
        await (0, vitest_1.expect)(run()).rejects.toThrow("无满足");
        (0, vitest_1.expect)(downloadAndExtract).not.toHaveBeenCalled();
    });
});
(0, vitest_1.describe)("normalizeNodeCacheLayout", () => {
    let dir;
    let cacheDir;
    (0, vitest_1.beforeEach)(async () => {
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "ensure-node-layout-"));
        cacheDir = (0, node_path_1.join)(dir, "node");
    });
    (0, vitest_1.afterEach)(async () => {
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("Windows zip：顶层目录归一化为 node-<version> 并返回二进制路径", async () => {
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-v26.7.0-win-x64"), { recursive: true });
        await (0, promises_1.writeFile)((0, node_path_1.join)(cacheDir, "node-v26.7.0-win-x64", "node.exe"), "x");
        const path = (0, ensure_node_js_1.normalizeNodeCacheLayout)("26.7.0", cacheDir, "win32", "x64");
        (0, vitest_1.expect)(path).toBe((0, node_path_1.join)(cacheDir, "node-26.7.0", "node.exe"));
    });
    (0, vitest_1.it)("Linux tar.gz：顶层目录归一化后返回 bin/node 路径", async () => {
        await (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-v24.5.0-linux-x64", "bin"), {
            recursive: true,
        });
        await (0, promises_1.writeFile)((0, node_path_1.join)(cacheDir, "node-v24.5.0-linux-x64", "bin", "node"), "x");
        const path = (0, ensure_node_js_1.normalizeNodeCacheLayout)("24.5.0", cacheDir, "linux", "x64");
        (0, vitest_1.expect)(path).toBe((0, node_path_1.join)(cacheDir, "node-24.5.0", "bin", "node"));
    });
    (0, vitest_1.it)("标准布局已存在时直接复用，不要求解压目录存在", () => {
        // 模拟重复调用：目标布局已归一化完成
        return (0, promises_1.mkdir)((0, node_path_1.join)(cacheDir, "node-26.7.0"), { recursive: true })
            .then(() => (0, promises_1.writeFile)((0, node_path_1.join)(cacheDir, "node-26.7.0", "node.exe"), "x"))
            .then(() => {
            const path = (0, ensure_node_js_1.normalizeNodeCacheLayout)("26.7.0", cacheDir, "win32", "x64");
            (0, vitest_1.expect)(path).toBe((0, node_path_1.join)(cacheDir, "node-26.7.0", "node.exe"));
        });
    });
    (0, vitest_1.it)("解压结果与目标布局均缺失二进制 → 抛错", async () => {
        await (0, promises_1.mkdir)(cacheDir, { recursive: true });
        (0, vitest_1.expect)(() => (0, ensure_node_js_1.normalizeNodeCacheLayout)("26.7.0", cacheDir, "win32", "x64")).toThrow("未找到 Node 可执行文件");
    });
});
