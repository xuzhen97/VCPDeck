/**
 * 真实压缩包集成冒烟：验证 bsdtar 对 PowerShell Compress-Archive 生成的 zip
 * 参数与行为正确（单测 mock 覆盖不到的最大风险点）。
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractArchive } from "./archive.js";

describe.skipIf(process.platform !== "win32")(
	"extractArchive 真实 zip 冒烟（win32）",
	() => {
		it("Compress-Archive 生成的 zip 解压后内容一致", async () => {
			const src = await mkdtemp(join(tmpdir(), "vcpdeck-arc-src-"));
			const dest = await mkdtemp(join(tmpdir(), "vcpdeck-arc-out-"));
			const zip = join(tmpdir(), `vcpdeck-arc-${Date.now()}.zip`);
			try {
				await mkdir(join(src, "nested"), { recursive: true });
				await writeFile(join(src, "a.txt"), "hello");
				await writeFile(join(src, "nested", "b.txt"), "world");
				execFileSync("powershell", [
					"-NoProfile",
					"-Command",
					`Compress-Archive -Path "${src}/*" -DestinationPath "${zip}" -Force`,
				]);

				await extractArchive(zip, dest);

				expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("hello");
				expect(await readFile(join(dest, "nested", "b.txt"), "utf8")).toBe(
					"world",
				);
			} finally {
				await rm(zip, { force: true });
				await rm(src, { recursive: true, force: true });
				await rm(dest, { recursive: true, force: true });
			}
		});
	},
);
