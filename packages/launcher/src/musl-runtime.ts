/**
 * musl 私有 Node 运行时的解析与缓存（ADR-0065）。
 *
 * 与官方 glibc 分发不同：版本、URL 与 SHA 全部来自签名清单里的 release-target.json，
 * 缓存按「平台 + 版本 + 锁定内容」隔离，绝不复用 node-<version> 旧缓存。
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MuslReleaseTarget } from "@vcpdeck/shared";
import { satisfiesConstraint } from "./ensure-node.js";

export type MuslRuntimeErrorCode =
	| "MUSL_RUNTIME_DOWNLOAD_INVALID"
	| "MUSL_RUNTIME_SHA256_MISMATCH"
	| "MUSL_RUNTIME_EXEC_FAILED"
	| "MUSL_RUNTIME_EXEC_MISMATCH"
	| "MUSL_RUNTIME_LIBC_MISMATCH"
	| "MUSL_RUNTIME_CONSTRAINT_UNSATISFIED";

export class MuslRuntimeError extends Error {
	readonly code: MuslRuntimeErrorCode;

	constructor(code: MuslRuntimeErrorCode, message: string) {
		super(message);
		this.name = "MuslRuntimeError";
		this.code = code;
	}
}

export interface MuslRuntimeDeps {
	/** 下载到指定路径；默认用 fetch */
	download?: (url: string, dest: string) => Promise<void>;
	/** 解压 tar.gz；默认复用 launcher archive 解压 */
	extract?: (archivePath: string, destDir: string) => Promise<void>;
	/** 执行 node 并返回 stdout；默认 execFile */
	execNode?: (nodePath: string, script: string) => Promise<string>;
	/** 计算文件 sha256；默认流式读取 */
	sha256Of?: (filePath: string) => Promise<string>;
}

/** 缓存键：平台/版本/锁定内容三者任一变化都必须落到不同目录。 */
export function runtimeCacheKey(target: MuslReleaseTarget): string {
	return `${target.platform}/node-${target.runtime.version}-${target.runtime.sha256}`;
}

const PROBE_SCRIPT =
	'process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,glibc:process.report?.getReport()?.header?.glibcVersionRuntime ?? null}))';

/**
 * 确保锁定版本的 musl Node 可用并返回其可执行文件路径。
 *
 * 顺序：缓存存在 → 仍实际执行核验（不信任目录存在自报）→ 核验失败删除坏缓存并
 * 重新下载一次；不存在 → 下载到临时文件 → SHA 校验 → 解压到临时目录 → 执行核验
 * → 原子 rename 入缓存。
 */
export async function ensureMuslRuntime(
	target: MuslReleaseTarget,
	cacheDir: string,
	nodeConstraint = ">=24",
	deps: MuslRuntimeDeps = {},
): Promise<string> {
	if (!satisfiesConstraint(target.runtime.version, nodeConstraint)) {
		throw new MuslRuntimeError(
			"MUSL_RUNTIME_CONSTRAINT_UNSATISFIED",
			`锁定运行时 ${target.runtime.version} 不满足目标约束 ${nodeConstraint}`,
		);
	}

	const key = runtimeCacheKey(target);
	const runtimeDir = join(cacheDir, key);
	const nodePath = join(runtimeDir, "bin", "node");

	if (existsSync(runtimeDir)) {
		// 已缓存也重新执行一次：目录被替换或二进制被改都必须在这里暴露。
		// 核验失败按缓存损坏处理：删除后重新下载一次，避免设备永久卡在坏缓存上。
		try {
			await verifyExecutable(nodePath, target, deps);
			return nodePath;
		} catch {
			await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	await mkdir(join(cacheDir, target.platform), { recursive: true });
	const tag = `${process.pid}-${Date.now()}`;
	const archivePath = join(cacheDir, target.platform, `.download-${tag}.tar.gz`);
	const stagingDir = join(cacheDir, target.platform, `.staging-${tag}`);
	const sha256Of = deps.sha256Of ?? defaultSha256Of;
	const download = deps.download ?? defaultDownload;
	const extract = deps.extract ?? defaultExtract;

	try {
		await download(target.runtime.url, archivePath);
		if (!existsSync(archivePath) || (await stat(archivePath)).size === 0) {
			throw new MuslRuntimeError(
				"MUSL_RUNTIME_DOWNLOAD_INVALID",
				"运行时下载结果为空",
			);
		}
		const actual = await sha256Of(archivePath);
		if (actual.toLowerCase() !== target.runtime.sha256.toLowerCase()) {
			throw new MuslRuntimeError(
				"MUSL_RUNTIME_SHA256_MISMATCH",
				"运行时 SHA256 与锁定值不一致",
			);
		}
		await mkdir(stagingDir, { recursive: true });
		await extract(archivePath, stagingDir);
		// 官方 musl 归档自带顶层 node-v<version>-linux-x64-musl/ 目录：缓存根必须是
		// 该目录本身，否则 bin/node 位于下一层，自取路径会一直报缺少 bin/node。
		let stagedRoot = stagingDir;
		if (!existsSync(join(stagingDir, "bin", "node"))) {
			const entries = await readdir(stagingDir, { withFileTypes: true });
			const only = entries[0];
			if (entries.length !== 1 || !only || !only.isDirectory()) {
				throw new MuslRuntimeError(
					"MUSL_RUNTIME_EXEC_FAILED",
					"运行时归档结构不是预期的单顶层目录",
				);
			}
			stagedRoot = join(stagingDir, only.name);
		}
		const stagedNode = join(stagedRoot, "bin", "node");
		await verifyExecutable(stagedNode, target, deps);
		await rename(stagedRoot, runtimeDir);
	} finally {
		await rm(archivePath, { force: true }).catch(() => undefined);
		await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
	}

	return nodePath;
}

async function verifyExecutable(
	nodePath: string,
	target: MuslReleaseTarget,
	deps: MuslRuntimeDeps,
): Promise<void> {
	if (!existsSync(nodePath)) {
		throw new MuslRuntimeError(
			"MUSL_RUNTIME_EXEC_FAILED",
			"运行时缺少 bin/node",
		);
	}
	const execNode = deps.execNode ?? defaultExecNode;
	let raw: string;
	try {
		raw = await execNode(nodePath, PROBE_SCRIPT);
	} catch {
		throw new MuslRuntimeError("MUSL_RUNTIME_EXEC_FAILED", "运行时无法执行");
	}
	let facts: { version?: unknown; arch?: unknown; glibc?: unknown };
	try {
		facts = JSON.parse(raw) as typeof facts;
	} catch {
		throw new MuslRuntimeError("MUSL_RUNTIME_EXEC_MISMATCH", "运行时自检输出无效");
	}
	const expectedVersion = `v${target.runtime.version}`;
	if (facts.version !== expectedVersion || facts.arch !== "x64") {
		throw new MuslRuntimeError(
			"MUSL_RUNTIME_EXEC_MISMATCH",
			"运行时版本或架构与锁定值不一致",
		);
	}
	// musl 版 Node 不应报告 glibc 运行时；报告了就说明拿到的是 glibc 二进制。
	if (facts.glibc !== null) {
		throw new MuslRuntimeError(
			"MUSL_RUNTIME_LIBC_MISMATCH",
			"运行时并非 musl 构建",
		);
	}
}

async function defaultSha256Of(filePath: string): Promise<string> {
	const buf = await readFile(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

async function defaultDownload(url: string, dest: string): Promise<void> {
	const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function defaultExtract(archivePath: string, destDir: string): Promise<void> {
	const { extractArchive } = await import("./archive.js");
	await extractArchive(archivePath, destDir);
}

async function defaultExecNode(nodePath: string, script: string): Promise<string> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	const { stdout } = await run(nodePath, ["-e", script], { timeout: 10_000 });
	return stdout;
}
