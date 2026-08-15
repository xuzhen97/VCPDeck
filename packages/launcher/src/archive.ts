/**
 * 压缩包解压（复用系统工具，参考 ensure-frpc.cjs 模式）。
 * - .zip → PowerShell Expand-Archive（Windows）
 * - .tar.gz → tar -xzf（Linux/macOS）
 */
import { execSync } from "node:child_process";
import { mkdir } from "node:fs/promises";

export async function extractArchive(
	archivePath: string,
	destDir: string,
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	try {
		if (archivePath.endsWith(".zip")) {
			execSync(
				`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
				{ stdio: "inherit" },
			);
		} else {
			// GNU tar 在 Windows 下把反斜杠当转义符：路径统一转正斜杠 + --force-local
			// （--force-local 防盘符冒号被误判为远程主机）
			const archiveForTar = archivePath.replace(/\\/g, "/");
			const dirForTar = destDir.replace(/\\/g, "/");
			execSync(`tar --force-local -xzf "${archiveForTar}" -C "${dirForTar}"`, {
				stdio: "inherit",
			});
		}
	} catch (e) {
		throw new Error(`解压失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}
