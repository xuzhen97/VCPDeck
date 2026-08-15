/**
 * Node 运行时保障（设计文档 §6.2「确保 Node」）：
 * 1) 系统 node 满足约束 → 直接用
 * 2) 否则检查缓存目录（launcher/node/node-<version>/）→ 命中即用
 * 3) 否则从 index.json 解析满足约束的最高版本 → 下载解压入缓存
 * 下载源默认官方，可配镜像（npmmirror）；参考 ensure-frpc.cjs 的复用模式。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractArchive } from "./archive.js";

const execFileAsync = promisify(execFile);

export interface NodeRuntimeOptions {
	/** 版本约束，如 ">=24"（只比较主版本） */
	constraint: string;
	/** Node 运行时缓存目录（launcher/node/） */
	cacheDir: string;
	platform?: NodeJS.Platform;
	arch?: string;
	/** 下载源基址，默认 https://nodejs.org/dist，可配镜像 */
	downloadBase?: string;
	/** 测试注入 */
	execNodeVersion?: () => Promise<string | null>;
	fetchIndex?: () => Promise<Array<{ version: string }>>;
	downloadAndExtract?: (
		version: string,
		cacheDir: string,
		ctx: { platform: string; arch: string; downloadBase: string },
	) => Promise<string>;
}

const DEFAULT_DOWNLOAD_BASE = "https://nodejs.org/dist";

/** ">=24" 约束只比较主版本；非法返回 false */
export function satisfiesConstraint(
	version: string,
	constraint: string,
): boolean {
	const major = Number.parseInt(version.replace(/^v/, ""), 10);
	if (Number.isNaN(major)) return false;
	const m = /^>=(\d+)$/.exec(constraint.trim());
	if (!m) return false;
	return major >= Number.parseInt(m[1], 10);
}

/** 解析 `node -v` 输出（"v24.5.0\n" → "24.5.0"） */
export function parseNodeVersion(output: string): string | null {
	const m = /^v?(\d+\.\d+\.\d+)/.exec(output.trim());
	return m ? m[1] : null;
}

/** 探测系统 node 版本 */
async function detectSystemNode(): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("node", ["-v"], { timeout: 5000 });
		return parseNodeVersion(stdout);
	} catch {
		return null;
	}
}

/** 缓存目录中满足约束的最高版本目录名（如 node-24.5.0） */
function findCachedRuntime(
	cacheDir: string,
	constraint: string,
): string | null {
	if (!existsSync(cacheDir)) return null;
	let best: { version: string; dir: string } | null = null;
	for (const name of readdirSync(cacheDir)) {
		const m = /^node-(v?\d+\.\d+\.\d+)$/.exec(name);
		if (!m) continue;
		if (!satisfiesConstraint(m[1], constraint)) continue;
		if (!best || compareVersions(m[1], best.version) > 0) {
			best = { version: m[1], dir: name };
		}
	}
	return best?.dir ?? null;
}

/** 简单版本比较（x.y.z） */
function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".").map(Number);
	const pb = b.replace(/^v/, "").split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	}
	return 0;
}

function nodeBinPath(
	cacheDir: string,
	dirName: string,
	platform: string,
): string {
	return platform === "win32"
		? join(cacheDir, dirName, "node.exe")
		: join(cacheDir, dirName, "bin", "node");
}

/**
 * 确保 Node 运行时可用，返回可执行文件路径（"node" 或缓存内绝对路径）。
 */
export async function ensureNodeRuntime(
	options: NodeRuntimeOptions,
): Promise<string> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const downloadBase = options.downloadBase ?? DEFAULT_DOWNLOAD_BASE;

	const systemVersion = options.execNodeVersion
		? await options.execNodeVersion()
		: await detectSystemNode();
	if (systemVersion && satisfiesConstraint(systemVersion, options.constraint)) {
		return "node";
	}

	const cachedDir = findCachedRuntime(options.cacheDir, options.constraint);
	if (cachedDir) {
		return nodeBinPath(options.cacheDir, cachedDir, platform);
	}

	await mkdir(options.cacheDir, { recursive: true });
	const fetchIndex =
		options.fetchIndex ??
		(async () => {
			const res = await fetch(`${downloadBase}/index.json`, {
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) throw new Error(`index.json HTTP ${res.status}`);
			return (await res.json()) as Array<{ version: string }>;
		});
	const index = await fetchIndex();
	const candidates = index
		.map((e) => e.version.replace(/^v/, ""))
		.filter((v) => satisfiesConstraint(v, options.constraint))
		.sort(compareVersions);
	const target = candidates[candidates.length - 1];
	if (!target) {
		throw new Error(`无满足约束 ${options.constraint} 的 Node 版本`);
	}

	const extract =
		options.downloadAndExtract ??
		(async (version: string, cache: string, ctx) => {
			await downloadNodeArchive(version, cache, ctx);
			return nodeBinPath(cache, `node-${version}`, ctx.platform);
		});
	return extract(target, options.cacheDir, { platform, arch, downloadBase });
}

/** 下载并解压官方 Node 发行包（zip / tar.gz，复用系统解压工具） */
async function downloadNodeArchive(
	version: string,
	cacheDir: string,
	ctx: { platform: string; arch: string; downloadBase: string },
): Promise<void> {
	const plat = ctx.platform.replace("win32", "win");
	const ext = ctx.platform === "win32" ? "zip" : "tar.gz";
	const fileName = `node-v${version}-${plat}-${ctx.arch}.${ext}`;
	const url = `${ctx.downloadBase}/v${version}/${fileName}`;
	const archivePath = join(cacheDir, fileName);

	if (!existsSync(archivePath)) {
		const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
		if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		await writeFile(archivePath, buf);
	}

	await extractArchive(archivePath, cacheDir);
}
