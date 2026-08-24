/**
 * 压缩包解压（复用系统工具，参考 ensure-frpc.cjs 模式；argv 数组避免 shell 拼接）。
 * - .zip：Windows 优先系统 bsdtar（`System32\tar.exe`，libarchive 流式解压原生支持
 *   zip，比 PS 5.1 Expand-Archive 管道逐条目复制快数倍），失败兜底回退 Expand-Archive；
 *   Linux/macOS 用系统 unzip（目标机需可用）
 * - .tar.gz：Windows 用系统 bsdtar（不支持 GNU --force-local）；Linux/macOS 用 GNU tar
 */
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

const isWin = process.platform === "win32";

export async function extractArchive(
	archivePath: string,
	destDir: string,
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	try {
		if (archivePath.endsWith(".zip")) {
			if (isWin) {
				try {
					execFileSync(
						"C:\\Windows\\System32\\tar.exe",
						["-xf", archivePath, "-C", destDir],
						{ stdio: "inherit", windowsHide: true },
					);
					console.log(`[archive] zip 解压完成: bsdtar (${archivePath})`);
					return;
				} catch (tarError) {
					console.log(
						`[archive] bsdtar 解压失败，兜底 Expand-Archive: ${
							tarError instanceof Error ? tarError.message : String(tarError)
						}`,
					);
				}
				execFileSync(
					"powershell",
					[
						"-NoProfile",
						"-Command",
						`Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${destDir}" -Force`,
					],
					{ stdio: "inherit", windowsHide: true },
				);
				console.log(`[archive] zip 解压完成: Expand-Archive (${archivePath})`);
			} else {
				execFileSync("unzip", ["-o", archivePath, "-d", destDir], {
					stdio: "inherit",
					windowsHide: true,
				});
			}
		} else {
			execFileSync(
				isWin ? "C:\\Windows\\System32\\tar.exe" : "tar",
				["-xzf", archivePath, "-C", destDir],
				{ stdio: "inherit", windowsHide: true },
			);
		}
	} catch (e) {
		throw new Error(`解压失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}
