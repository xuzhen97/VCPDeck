"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractArchive = extractArchive;
/**
 * 压缩包解压（复用系统工具，参考 ensure-frpc.cjs 模式；argv 数组避免 shell 拼接）。
 * - .zip：Windows 优先系统 bsdtar（`System32\tar.exe`，libarchive 流式解压原生支持
 *   zip，比 PS 5.1 Expand-Archive 管道逐条目复制快数倍），失败兜底回退 Expand-Archive；
 *   Linux/macOS 用系统 unzip（目标机需可用）
 * - .tar.gz：Windows 用系统 bsdtar（不支持 GNU --force-local）；Linux/macOS 用 GNU tar
 */
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const isWin = process.platform === "win32";
async function extractArchive(archivePath, destDir) {
    await (0, promises_1.mkdir)(destDir, { recursive: true });
    try {
        if (archivePath.endsWith(".zip")) {
            if (isWin) {
                try {
                    (0, node_child_process_1.execFileSync)("C:\\Windows\\System32\\tar.exe", ["-xf", archivePath, "-C", destDir], { stdio: "inherit", windowsHide: true });
                    console.log(`[archive] zip 解压完成: bsdtar (${archivePath})`);
                    return;
                }
                catch (tarError) {
                    console.log(`[archive] bsdtar 解压失败，兜底 Expand-Archive: ${tarError instanceof Error ? tarError.message : String(tarError)}`);
                }
                (0, node_child_process_1.execFileSync)("powershell", [
                    "-NoProfile",
                    "-Command",
                    `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${destDir}" -Force`,
                ], { stdio: "inherit", windowsHide: true });
                console.log(`[archive] zip 解压完成: Expand-Archive (${archivePath})`);
            }
            else {
                (0, node_child_process_1.execFileSync)("unzip", ["-o", archivePath, "-d", destDir], {
                    stdio: "inherit",
                    windowsHide: true,
                });
            }
        }
        else {
            (0, node_child_process_1.execFileSync)(isWin ? "C:\\Windows\\System32\\tar.exe" : "tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit", windowsHide: true });
        }
    }
    catch (e) {
        throw new Error(`解压失败: ${e instanceof Error ? e.message : String(e)}`);
    }
}
