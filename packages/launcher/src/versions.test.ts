import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionStore, type VersionFsOps } from "./versions.js";

/** 测试辅助：带错误包装的 mkdir（满足静态检查的防御性要求） */
async function ensureDir(p: string): Promise<void> {
	try {
		await mkdir(p, { recursive: true });
	} catch (e) {
		throw new Error(
			`创建测试目录失败 ${p}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** 测试辅助：带错误包装的写文件 */
async function writeTextFile(p: string, content: string): Promise<void> {
	try {
		await writeFile(p, content);
	} catch (e) {
		throw new Error(
			`写测试文件失败 ${p}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** 测试辅助：带错误包装的读 JSON 文件 */
async function readJsonFile(p: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(p, "utf-8"));
	} catch (e) {
		throw new Error(
			`读测试 JSON 失败 ${p}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** 内存 fake fs：模拟 symlink 语义（Windows 开发机上无法真实创建 symlink） */
function makeFakeFs(dirs: string[]): VersionFsOps {
	const links = new Map<string, string>();
	const files = new Map<string, string>();
	return {
		readFile: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
		writeFile: async (p: string, d: string) => {
			files.set(p, d);
		},
		readdir: async () => dirs,
		readlink: async (p: string) => {
			const v = links.get(p);
			if (v === undefined) throw new Error("ENOENT");
			return v;
		},
		symlinkSync: (t: string, p: string) => {
			links.set(p, t);
		},
		renameSync: (o: string, n: string) => {
			if (links.has(o)) {
				links.set(n, links.get(o) as string);
				links.delete(o);
			} else if (files.has(o)) {
				files.set(n, files.get(o) as string);
				files.delete(o);
			}
		},
		unlinkSync: (p: string) => {
			links.delete(p);
			files.delete(p);
		},
		existsSync: () => true,
	};
}

describe("VersionStore", () => {
	let dir: string;
	let appsDir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "versions-"));
		appsDir = join(dir, "apps");
		await ensureDir(appsDir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("Linux（symlink 切换，fake fs）", () => {
		it("switchTo 创建 current 符号链接，currentVersion 可解析", async () => {
			const store = new VersionStore({
				appsDir,
				platform: "linux",
				fs: makeFakeFs([]),
			});

			await store.switchTo("1.2.0");

			expect(await store.currentVersion()).toBe("1.2.0");
		});

		it("重复切换覆盖旧链接", async () => {
			const store = new VersionStore({
				appsDir,
				platform: "linux",
				fs: makeFakeFs([]),
			});
			await store.switchTo("1.1.0");

			await store.switchTo("1.2.0");

			expect(await store.currentVersion()).toBe("1.2.0");
		});

		it("未切换时 currentVersion 为 null", async () => {
			const store = new VersionStore({
				appsDir,
				platform: "linux",
				fs: makeFakeFs([]),
			});
			await expect(store.currentVersion()).resolves.toBeNull();
		});
	});

	describe("Windows（state.json 指针，真实 fs）", () => {
		it("switchTo 原子写入 state.json，currentVersion 可解析", async () => {
			const store = new VersionStore({ appsDir, platform: "win32" });
			await ensureDir(join(appsDir, "1.2.0"));

			await store.switchTo("1.2.0");

			expect(await store.currentVersion()).toBe("1.2.0");
			const state = await readJsonFile(join(appsDir, "state.json"));
			expect(state).toEqual({ current: "1.2.0" });
		});

		it("写入不留临时文件（tmp+rename）", async () => {
			const store = new VersionStore({ appsDir, platform: "win32" });
			await store.switchTo("1.2.0");

			const entries = await import("node:fs/promises").then((fs) =>
				fs.readdir(appsDir),
			);
			expect(entries.filter((n) => n.includes("tmp"))).toEqual([]);
		});

		it("未切换时 currentVersion 为 null", async () => {
			const store = new VersionStore({ appsDir, platform: "win32" });
			await expect(store.currentVersion()).resolves.toBeNull();
		});
	});

	describe("listVersions", () => {
		it("列出全部版本目录", async () => {
			const store = new VersionStore({ appsDir, platform: "linux" });
			await ensureDir(join(appsDir, "1.1.0"));
			await ensureDir(join(appsDir, "1.2.0"));
			await writeTextFile(join(appsDir, "unrelated.txt"), "x");

			const versions = await store.listVersions();

			expect(versions).toEqual(["1.1.0", "1.2.0"]);
		});
	});
});
