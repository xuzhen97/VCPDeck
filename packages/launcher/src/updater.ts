/**
 * Launcher 两阶段更新执行器（详见 docs/design/release-and-update.md）。
 * - prepare：下载 → sha256 校验 → 解压到 apps/<version>/（服务进程仍在运行）
 * - apply：停旧进程 → 切换 current → 启动 → 探活 → 失败自动回退旧版本
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VersionStore } from "./versions.js";

export interface UpdaterDeps {
	versions: VersionStore;
	artifact: "server" | "client";
	/** 下载 zip 到目标路径 */
	downloadZip(url: string, destPath: string): Promise<void>;
	/** 流式 sha256 校验 */
	verifySha256(filePath: string, expected: string): Promise<boolean>;
	/** 解压 zip 到目标目录 */
	extractZip(zipPath: string, destDir: string): Promise<void>;
	/** 停止当前被守护进程 */
	stopProcess(): Promise<void>;
	/** 启动 current 版本进程 */
	startProcess(): Promise<unknown>;
	/** 健康探活（服务端：GET /api/status；客户端：进程存活） */
	probe(version: string): Promise<boolean>;
	/** 成功切换后的尽力记录钩子；失败不得影响已经健康的版本 */
	onSuccessfulApply?: (version: string, previous: string | null) => Promise<void>;
	probeRetries?: number;
	probeIntervalMs?: number;
}

const DEFAULT_PROBE_RETRIES = 3;
const DEFAULT_PROBE_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 距给定起点经过的秒数（一位小数） */
function secs(from: number): string {
	return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

/** zip 体积（MB，一位小数）；不可得时返回 null */
async function fileSizeMB(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		return (s.size / 1024 / 1024).toFixed(1);
	} catch {
		return null;
	}
}

export class Updater {
	constructor(private readonly deps: UpdaterDeps) {}

	/** 第一阶段：准备新版本（完整版本目录幂等跳过） */
	async prepare(input: {
		url: string;
		sha256: string;
		version: string;
	}): Promise<void> {
		if (await this.deps.versions.isPrepared(input.version, this.deps.artifact)) {
			return;
		}
		await this.deps.versions.removeVersion(input.version);

		const zipPath = join(tmpdir(), `vcpdeck-${input.version}.zip`);
		const startedAt = Date.now();
		try {
			let phaseStart = Date.now();
			await this.deps.downloadZip(input.url, zipPath);
			const sizeMB = await fileSizeMB(zipPath);
			console.log(
				`[launcher] prepare ${input.version} 下载完成: ${secs(phaseStart)}${sizeMB ? `，${sizeMB}MB` : ""}`,
			);
			phaseStart = Date.now();
			const ok = await this.deps.verifySha256(zipPath, input.sha256);
			if (!ok) {
				throw new Error(`sha256 校验失败: ${input.version}`);
			}
			console.log(`[launcher] prepare ${input.version} 校验通过: ${secs(phaseStart)}`);
			phaseStart = Date.now();
			await this.deps.extractZip(
				zipPath,
				this.deps.versions.versionDir(input.version),
			);
			console.log(`[launcher] prepare ${input.version} 解压完成: ${secs(phaseStart)}`);
			console.log(`[launcher] prepare ${input.version} 总耗时: ${secs(startedAt)}`);
		} finally {
			await rm(zipPath, { force: true }).catch(() => undefined);
		}
	}

	/** 第二阶段：切换并启动新版本；探活失败自动回退 */
	async apply(version: string): Promise<void> {
		const previous = await this.deps.versions.currentVersion();
		await this.deps.stopProcess();
		await this.deps.versions.switchTo(version);
		await this.deps.startProcess();

		const healthy = await this.probeWithRetry(version);
		if (healthy) {
			if (this.deps.onSuccessfulApply) {
				try {
					await this.deps.onSuccessfulApply(version, previous);
				} catch {
					console.warn("[launcher] 版本保留记录失败，继续使用已切换版本");
				}
			}
			return;
		}

		if (previous) {
			await this.deps.stopProcess();
			await this.deps.versions.switchTo(previous);
			await this.deps.startProcess();
		}
		throw new Error(
			previous
				? `版本 ${version} 健康检查失败，已回退 ${previous}`
				: `版本 ${version} 健康检查失败`,
		);
	}

	private async probeWithRetry(version: string): Promise<boolean> {
		const retries = this.deps.probeRetries ?? DEFAULT_PROBE_RETRIES;
		const interval = this.deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
		for (let i = 0; i < retries; i++) {
			if (await this.deps.probe(version)) return true;
			if (i < retries - 1) await sleep(interval);
		}
		return false;
	}
}
