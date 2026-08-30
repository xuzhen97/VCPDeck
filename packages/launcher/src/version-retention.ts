/** Launcher 本地版本保留与清理。
 *
 * retention.json 只记录 Launcher 已确认健康切换成功的版本。文件缺失时只建立
 * current 基线，不删除未知旧目录；文件损坏时停用自动清理，等待人工修复。
 */
import {
	readFile as readFileFs,
	rename as renameFs,
	rm as rmFs,
	writeFile as writeFileFs,
} from "node:fs/promises";
import { join } from "node:path";
import type { VersionStore } from "./versions.js";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface RetentionState {
	successfulVersions: string[];
}

export interface RetentionCleanupResult {
	removed: string[];
	failed: string[];
	disabled: boolean;
}

export interface VersionRetentionFsOps {
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	rm(path: string): Promise<void>;
}

const realFs: VersionRetentionFsOps = {
	readFile: (path, encoding) => readFileFs(path, encoding),
	writeFile: (path, data, encoding) => writeFileFs(path, data, encoding),
	rename: (oldPath, newPath) => renameFs(oldPath, newPath),
	rm: (path) => rmFs(path, { force: true }),
};

export interface VersionRetentionOptions {
	appsDir: string;
	versions: Pick<VersionStore, "currentVersion" | "listVersions" | "removeVersion">;
	/** 测试注入；生产使用 node:fs/promises。 */
	fs?: VersionRetentionFsOps;
}

function isValidVersion(version: unknown): version is string {
	return typeof version === "string" && VERSION_RE.test(version);
}

function parseState(raw: string): RetentionState | null {
	try {
		const value = JSON.parse(raw) as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			!Array.isArray((value as { successfulVersions?: unknown }).successfulVersions)
		) {
			return null;
		}
		const successfulVersions = (value as { successfulVersions: unknown[] })
			.successfulVersions;
		if (
			successfulVersions.length === 0 ||
			!successfulVersions.every(isValidVersion) ||
			new Set(successfulVersions).size !== successfulVersions.length
		) {
			return null;
		}
		return { successfulVersions: [...successfulVersions] };
	} catch {
		return null;
	}
}

export class VersionRetention {
	private readonly stateFile: string;
	private readonly tempStateFile: string;
	private state: RetentionState | null = null;
	private initialized = false;
	private disabled = false;
	private readonly fs: VersionRetentionFsOps;

	constructor(private readonly options: VersionRetentionOptions) {
		this.stateFile = join(options.appsDir, "retention.json");
		this.tempStateFile = `${this.stateFile}.tmp`;
		this.fs = options.fs ?? realFs;
	}

	/** 读取或建立保留状态；状态不可信时停用自动清理。 */
	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;

		let raw: string;
		try {
			raw = await this.fs.readFile(this.stateFile, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.disabled = true;
				return;
			}
			await this.initializeMissingState();
			return;
		}
		const parsed = parseState(raw);
		if (!parsed) {
			this.disabled = true;
			return;
		}
		this.state = parsed;
		const current = await this.options.versions.currentVersion();
		if (!isValidVersion(current) || !this.state.successfulVersions.includes(current)) {
			this.state = null;
			this.disabled = true;
		}
	}

	/** 记录一次已通过探活的成功切换，并将其置于历史首位。 */
	async recordSuccessful(version: string): Promise<boolean> {
		await this.initialize();
		if (this.disabled || !isValidVersion(version) || !this.state) return false;
		const nextState: RetentionState = {
			successfulVersions: [
				version,
				...this.state.successfulVersions.filter((item) => item !== version),
			],
		};
		try {
			await this.writeState(nextState);
			this.state = nextState;
			return true;
		} catch {
			// 新成功历史无法持久化时，旧历史已不足以证明当前保护集合，
			// 立即停用删除，避免在不可信状态下回收版本目录。
			this.disabled = true;
			return false;
		}
	}

	/** 清理不在 current、最近两个成功历史或调用方保护集合中的版本目录。 */
	async cleanup(
		protectedVersions: ReadonlySet<string> = new Set(),
	): Promise<RetentionCleanupResult> {
		await this.initialize();
		if (this.disabled || !this.state) {
			return { removed: [], failed: [], disabled: true };
		}

		const current = await this.options.versions.currentVersion();
		if (!isValidVersion(current)) {
			return { removed: [], failed: [], disabled: true };
		}
		const successful = this.state.successfulVersions;
		if (!successful.includes(current)) {
			return { removed: [], failed: [], disabled: true };
		}
		if (successful.length - 1 < 2) {
			return { removed: [], failed: [], disabled: false };
		}

		const keep = new Set<string>([
			current,
			...successful.filter((version) => version !== current).slice(0, 2),
		]);
		for (const version of protectedVersions) {
			if (isValidVersion(version)) keep.add(version);
		}

		const candidates = (await this.options.versions.listVersions()).filter(
			(version) => isValidVersion(version) && !keep.has(version),
		);
		const removed: string[] = [];
		const failed: string[] = [];
		for (const version of candidates) {
			try {
				await this.options.versions.removeVersion(version);
				removed.push(version);
			} catch {
				failed.push(version);
			}
		}
		return { removed, failed, disabled: false };
	}

	private async initializeMissingState(): Promise<void> {
		const current = await this.options.versions.currentVersion();
		if (!isValidVersion(current)) {
			this.disabled = true;
			return;
		}
		const nextState: RetentionState = { successfulVersions: [current] };
		try {
			await this.writeState(nextState);
			this.state = nextState;
		} catch {
			this.disabled = true;
		}
	}

	private async writeState(state: RetentionState): Promise<void> {
		try {
			await this.fs.writeFile(
				this.tempStateFile,
				JSON.stringify(state),
				"utf-8",
			);
			await this.fs.rename(this.tempStateFile, this.stateFile);
		} catch (error) {
			await this.fs.rm(this.tempStateFile).catch(() => undefined);
			throw error;
		}
	}
}
