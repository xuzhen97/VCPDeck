"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 真实压缩包集成冒烟：验证 bsdtar 对 PowerShell Compress-Archive 生成的 zip
 * 参数与行为正确（单测 mock 覆盖不到的最大风险点）。
 */
const vitest_1 = require("vitest");
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const archive_js_1 = require("./archive.js");
vitest_1.describe.skipIf(process.platform !== "win32")("extractArchive 真实 zip 冒烟（win32）", () => {
    (0, vitest_1.it)("Compress-Archive 生成的 zip 解压后内容一致", async () => {
        const src = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-arc-src-"));
        const dest = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "vcpdeck-arc-out-"));
        const zip = (0, node_path_1.join)((0, node_os_1.tmpdir)(), `vcpdeck-arc-${Date.now()}.zip`);
        try {
            await (0, promises_1.mkdir)((0, node_path_1.join)(src, "nested"), { recursive: true });
            await (0, promises_1.writeFile)((0, node_path_1.join)(src, "a.txt"), "hello");
            await (0, promises_1.writeFile)((0, node_path_1.join)(src, "nested", "b.txt"), "world");
            (0, node_child_process_1.execFileSync)("powershell", [
                "-NoProfile",
                "-Command",
                `Compress-Archive -Path "${src}/*" -DestinationPath "${zip}" -Force`,
            ]);
            await (0, archive_js_1.extractArchive)(zip, dest);
            (0, vitest_1.expect)(await (0, promises_1.readFile)((0, node_path_1.join)(dest, "a.txt"), "utf8")).toBe("hello");
            (0, vitest_1.expect)(await (0, promises_1.readFile)((0, node_path_1.join)(dest, "nested", "b.txt"), "utf8")).toBe("world");
        }
        finally {
            await (0, promises_1.rm)(zip, { force: true });
            await (0, promises_1.rm)(src, { recursive: true, force: true });
            await (0, promises_1.rm)(dest, { recursive: true, force: true });
        }
    });
});
