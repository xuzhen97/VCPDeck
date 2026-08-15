/**
 * 版本目录管理与原子切换（设计文档 §6.4）。
 * - Linux：apps/current 为符号链接，切换用「临时链接 + rename」原子完成
 * - Windows：不用 symlink（权限问题），apps/state.json 指针文件，写入用 tmp+rename
 * fs 操作可注入（测试在非 Linux 机器上模拟 symlink 语义）。
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";

export interface VersionStoreOptions {
	/** 应用目录下的 apps/ 目录 */
	appsDir: string;
	/** 切换策略：win32 用指针文件，其余用 symlink */
	platform?: NodeJS.Platform;
	/** 测试注入 */
	fs?: VersionFsOps;
}

/** VersionStore 用到的最小 fs 操作集（同步项用于原子切换） */
export interface VersionFsOps {
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	writeFile(path: string, data: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	readlink(path: string): Promise<string>;
	symlinkSync(target: string, path: string): void;
	renameSync(oldPath: string, newPath: string): void;
	unlinkSync(path: string): void;
	existsSync(path: string): boolean;
}

const realFs: VersionFsOps = {
	readFile: (p, e) => fsp.readFile(p, e),
	writeFile: (p, d) => fsp.writeFile(p, d, "utf-8"),
	readdir: (p) => fsp.readdir(p),
	readlink: (p) => fsp.readlink(p),
	symlinkSync: (t, p) => fs.symlinkSync(t, p, "dir"),
	renameSync: fs.renameSync,
	unlinkSync: fs.unlinkSync,
	existsSync: fs.existsSync,
};

interface StateFile {
	current: string;
}

export class VersionStore {
	private readonly appsDir: string;
	private readonly isWindows: boolean;
	private readonly stateFile: string;
	private readonly fs: VersionFsOps;

	constructor(options: VersionStoreOptions) {
		this.appsDir = options.appsDir;
		this.isWindows = (options.platform ?? process.platform) === "win32";
		this.stateFile = join(this.appsDir, "state.json");
		this.fs = options.fs ?? realFs;
	}

	/** 当前生效版本；未切换过返回 null */
	async currentVersion(): Promise<string | null> {
		if (this.isWindows) {
			try {
				const state = JSON.parse(
					await this.fs.readFile(this.stateFile, "utf-8"),
				) as Partial<StateFile>;
				return state.current ?? null;
			} catch {
				return null;
			}
		}
		try {
			const target = await this.fs.readlink(join(this.appsDir, "current"));
			const base = target.split(/[\\/]/).pop() ?? "";
			return /^\d+\.\d+\.\d+$/.test(base) ? base : null;
		} catch {
			return null;
		}
	}

	/** 切换 current 到指定版本（原子） */
	async switchTo(version: string): Promise<void> {
		if (this.isWindows) {
			await this.writeStateFileAtomic({ current: version });
			return;
		}
		const linkPath = join(this.appsDir, "current");
		const tmpLink = join(this.appsDir, `.current.tmp-${version}`);
		this.fs.symlinkSync(join(this.appsDir, version), tmpLink);
		try {
			this.fs.renameSync(tmpLink, linkPath);
		} catch {
			this.fs.unlinkSync(tmpLink);
			throw new Error(`切换版本失败: ${version}`);
		}
	}

	/** 全部已解压版本目录（x.y.z 命名） */
	async listVersions(): Promise<string[]> {
		const entries = await this.fs.readdir(this.appsDir);
		return entries.filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort();
	}

	/** 版本目录路径（解压目标） */
	versionDir(version: string): string {
		return join(this.appsDir, version);
	}

	/** 版本目录存在性（解压结果校验用） */
	exists(version: string): boolean {
		return this.fs.existsSync(join(this.appsDir, version));
	}

	private async writeStateFileAtomic(state: StateFile): Promise<void> {
		const tmpFile = `${this.stateFile}.tmp`;
		await this.fs.writeFile(tmpFile, JSON.stringify(state));
		this.fs.renameSync(tmpFile, this.stateFile);
	}
}
