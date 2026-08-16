/**
 * Launcher 两阶段更新执行器（详见 docs/design/release-and-update.md）。
 * - prepare：下载 → sha256 校验 → 解压到 apps/<version>/（服务进程仍在运行）
 * - apply：停旧进程 → 切换 current → 启动 → 探活 → 失败自动回退旧版本
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VersionStore } from "./versions.js";

export interface UpdaterDeps {
	versions: VersionStore;
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
	probeRetries?: number;
	probeIntervalMs?: number;
}

const DEFAULT_PROBE_RETRIES = 3;
const DEFAULT_PROBE_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Updater {
	constructor(private readonly deps: UpdaterDeps) {}

	/** 第一阶段：准备新版本（幂等，已存在版本目录直接跳过） */
	async prepare(input: {
		url: string;
		sha256: string;
		version: string;
	}): Promise<void> {
		if (this.deps.versions.exists(input.version)) return;

		const zipPath = join(tmpdir(), `vcpdeck-${input.version}.zip`);
		try {
			await this.deps.downloadZip(input.url, zipPath);
			const ok = await this.deps.verifySha256(zipPath, input.sha256);
			if (!ok) {
				throw new Error(`sha256 校验失败: ${input.version}`);
			}
			await this.deps.extractZip(
				zipPath,
				this.deps.versions.versionDir(input.version),
			);
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
		if (healthy) return;

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
