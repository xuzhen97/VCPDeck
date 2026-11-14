/**
 * musl 私有 Node 运行时缓存与执行核验（ADR-0065）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuslReleaseTarget } from "@vcpdeck/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	MuslRuntimeError,
	ensureMuslRuntime,
	runtimeCacheKey,
} from "./musl-runtime.js";

const target: MuslReleaseTarget = {
	schema: 1,
	platform: "linux-x64-musl",
	role: "client",
	runtime: {
		version: "24.0.0",
		url: "https://unofficial-builds.nodejs.org/download/release/v24.0.0/node-v24.0.0-linux-x64-musl.tar.gz",
		sha256: "a".repeat(64),
	},
};

const dirs: string[] = [];

function makeCache(): string {
	const dir = mkdtempSync(join(tmpdir(), "vcpdeck-musl-runtime-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Spy {
	downloads: number;
	execs: number;
}

function deps(
	overrides: {
		sha?: string;
		facts?: { version: string; arch: string; glibc: string | null };
		execThrows?: boolean;
	} = {},
): { deps: Parameters<typeof ensureMuslRuntime>[3]; spy: Spy } {
	const spy: Spy = { downloads: 0, execs: 0 };
	return {
		spy,
		deps: {
			download: async (_url, dest) => {
				spy.downloads += 1;
				writeFileSync(dest, "tarball-bytes");
			},
			sha256Of: async () => overrides.sha ?? target.runtime.sha256,
			extract: async (_archive, dir) => {
				mkdirSync(join(dir, "bin"), { recursive: true });
				writeFileSync(join(dir, "bin", "node"), "node-binary", { mode: 0o755 });
			},
			execNode: async () => {
				spy.execs += 1;
				if (overrides.execThrows) throw new Error("spawn ENOENT");
				const facts = overrides.facts ?? {
					version: `v${target.runtime.version}`,
					arch: "x64",
					glibc: null,
				};
				return JSON.stringify(facts);
			},
		},
	};
}

describe("runtimeCacheKey", () => {
	it("缓存按平台、版本和锁定内容隔离", () => {
		expect(runtimeCacheKey(target)).toBe(
			`linux-x64-musl/node-24.0.0-${"a".repeat(64)}`,
		);
	});
});

describe("ensureMuslRuntime", () => {
	it("下载→SHA→解压→执行核验→原子入缓存", async () => {
		const cacheDir = makeCache();
		const { deps: injected, spy } = deps();
		const nodePath = await ensureMuslRuntime(target, cacheDir, ">=24", injected);
		expect(nodePath.endsWith(join("bin", "node"))).toBe(true);
		expect(existsSync(nodePath)).toBe(true);
		expect(spy.downloads).toBe(1);
		expect(spy.execs).toBe(1);
		// 二次调用命中缓存但仍要执行核验
		await ensureMuslRuntime(target, cacheDir, ">=24", injected);
		expect(spy.execs).toBe(2);
		expect(spy.downloads).toBe(1);
	});

	it("SHA 不符直接拒绝，不留下可被下次命中的目录", async () => {
		const cacheDir = makeCache();
		const { deps: injected } = deps({ sha: "b".repeat(64) });
		await expect(ensureMuslRuntime(target, cacheDir, ">=24", injected)).rejects.toMatchObject({
			code: "MUSL_RUNTIME_SHA256_MISMATCH",
		});
		expect(existsSync(join(cacheDir, runtimeCacheKey(target)))).toBe(false);
	});

	it("执行自检架构不符时报错且不进缓存", async () => {
		const cacheDir = makeCache();
		const { deps: injected } = deps({
			facts: { version: "v24.0.0", arch: "arm64", glibc: null },
		});
		await expect(ensureMuslRuntime(target, cacheDir, ">=24", injected)).rejects.toMatchObject({
			code: "MUSL_RUNTIME_EXEC_MISMATCH",
		});
		expect(existsSync(join(cacheDir, runtimeCacheKey(target)))).toBe(false);
	});

	it("报告 glibc 运行时说明拿到的不是 musl 构建", async () => {
		const cacheDir = makeCache();
		const { deps: injected } = deps({
			facts: { version: "v24.0.0", arch: "x64", glibc: "2.36" },
		});
		await expect(ensureMuslRuntime(target, cacheDir, ">=24", injected)).rejects.toMatchObject({
			code: "MUSL_RUNTIME_LIBC_MISMATCH",
		});
	});

	it("已缓存目录被破坏时删除坏缓存并重新下载一次，不静默复用", async () => {
		const cacheDir = makeCache();
		const runtimeDir = join(cacheDir, runtimeCacheKey(target));
		mkdirSync(join(runtimeDir, "bin"), { recursive: true });
		writeFileSync(join(runtimeDir, "bin", "node"), "tampered");
		// 第一次执行核验失败 → 删除坏缓存；随后正常下载并核验通过。
		let failures = 1;
		const spyState = { downloads: 0, execs: 0 };
		const injected: Parameters<typeof ensureMuslRuntime>[3] = {
			download: async (_url, dest) => {
				spyState.downloads += 1;
				writeFileSync(dest, "tarball-bytes");
			},
			sha256Of: async () => target.runtime.sha256,
			extract: async (_archive, dir) => {
				mkdirSync(join(dir, "bin"), { recursive: true });
				writeFileSync(join(dir, "bin", "node"), "node-binary", { mode: 0o755 });
			},
			execNode: async () => {
				spyState.execs += 1;
				if (failures > 0) {
					failures -= 1;
					throw new Error("spawn ENOENT");
				}
				return JSON.stringify({
					version: `v${target.runtime.version}`,
					arch: "x64",
					glibc: null,
				});
			},
		};
		const nodePath = await ensureMuslRuntime(target, cacheDir, ">=24", injected);
		expect(existsSync(nodePath)).toBe(true);
		expect(spyState.downloads).toBe(1);
	});

	it("锁定版本不满足目标约束时在下载前拒绝", async () => {
		const cacheDir = makeCache();
		const { deps: injected, spy } = deps();
		await expect(ensureMuslRuntime(target, cacheDir, ">=26", injected)).rejects.toMatchObject({
			code: "MUSL_RUNTIME_CONSTRAINT_UNSATISFIED",
		});
		expect(spy.downloads).toBe(0);
	});

	it("归档自带顶层 node-v<version>-linux-x64-musl 目录时剥掉该层", async () => {
		const cacheDir = makeCache();
		const injected: Parameters<typeof ensureMuslRuntime>[3] = {
			download: async (_url, dest) => writeFileSync(dest, "tarball-bytes"),
			sha256Of: async () => target.runtime.sha256,
			extract: async (_archive, dir) => {
				const nested = join(dir, `node-v${target.runtime.version}-linux-x64-musl`);
				mkdirSync(join(nested, "bin"), { recursive: true });
				writeFileSync(join(nested, "bin", "node"), "node-binary", { mode: 0o755 });
			},
			execNode: async () =>
				JSON.stringify({ version: `v${target.runtime.version}`, arch: "x64", glibc: null }),
		};
		const nodePath = await ensureMuslRuntime(target, cacheDir, ">=24", injected);
		expect(nodePath).toBe(join(cacheDir, runtimeCacheKey(target), "bin", "node"));
		expect(existsSync(nodePath)).toBe(true);
	});
});
