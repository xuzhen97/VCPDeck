/**
 * Tailnet 短时密钥文件（ADR-0062）。
 *
 * 密钥只存在于随机私有目录中的独占文件，消费结束立即删除。
 * Windows 不把 chmod 当 ACL：先限制目录权限并验证，再写正文。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TailnetErrorCode } from "@vcpdeck/shared";

/** 默认残留判定：十分钟。 */
const DEFAULT_STALE_MS = 10 * 60_000;

/** 本进程正在使用的目录，启动清理必须跳过。 */
const ACTIVE_DIRS = new Set<string>();

/** 可注入依赖；生产路径不对网络输入开放。 */
export interface TailnetSecretFileDeps {
	platform: NodeJS.Platform;
	rootDir: string;
	now: () => number;
	staleMs: number;
	removeDir: (dir: string) => Promise<void>;
	/** 仅 Windows 使用；失败即视为权限未收窄。 */
	restrictWindowsDirectory: (dir: string) => Promise<void>;
}

function secretError(code: TailnetErrorCode, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function defaultRootDir(platform: NodeJS.Platform): string {
	if (platform === "win32") {
		return join(
			process.env.LOCALAPPDATA ?? homedir(),
			"VCPDeck",
			"tailnet-secrets",
		);
	}
	return join(homedir(), ".vcpdeck", "tailnet-secrets");
}

function assertSecretText(authKey: string): void {
	if (
		typeof authKey !== "string" ||
		authKey.length === 0 ||
		authKey.length > 4096 ||
		/[\r\n\0]/.test(authKey)
	) {
		throw secretError("TAILNET_SECRET_DENIED", "密钥正文不合法");
	}
}

function runCommand(
	command: string,
	args: string[],
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolvePromise) => {
		execFile(
			command,
			args,
			{ timeout: 30_000, windowsHide: true },
			(error, stdout) => {
				if (!error) {
					resolvePromise({ code: 0, stdout: String(stdout ?? "") });
					return;
				}
				const raw = (error as NodeJS.ErrnoException).code;
				resolvePromise({
					code: typeof raw === "number" ? raw : 1,
					stdout: String(stdout ?? ""),
				});
			},
		);
	});
}

async function restrictWindowsDirectory(dir: string): Promise<void> {
	const who = await runCommand("whoami", []);
	const account = who.stdout.trim();
	if (who.code !== 0 || !account) {
		throw secretError("TAILNET_SECRET_DENIED", "无法确定当前账户");
	}
	const inheritance = await runCommand("icacls", [dir, "/inheritance:r"]);
	if (inheritance.code !== 0) {
		throw secretError("TAILNET_SECRET_DENIED", "无法关闭目录权限继承");
	}
	const grant = await runCommand("icacls", [
		dir,
		"/grant:r",
		`${account}:(OI)(CI)F`,
		"SYSTEM:(OI)(CI)F",
	]);
	if (grant.code !== 0) {
		throw secretError("TAILNET_SECRET_DENIED", "无法设置目录权限");
	}
	const verify = await runCommand("icacls", [dir]);
	const acl = verify.stdout;
	if (
		verify.code !== 0 ||
		/(Everyone|BUILTIN\\Users)/i.test(acl)
	) {
		throw secretError("TAILNET_SECRET_DENIED", "目录权限验证失败");
	}
}

async function removeOwnedDir(dir: string, rootDir: string): Promise<void> {
	const root = resolve(rootDir);
	const target = resolve(dir);
	if (target === root || !target.startsWith(root + sep)) {
		throw secretError("TAILNET_SECRET_CLEANUP_FAILED", "拒绝清理非自有路径");
	}
	let stats;
	try {
		stats = await fs.lstat(target);
	} catch {
		return;
	}
	if (stats.isSymbolicLink()) {
		await fs.unlink(target);
		return;
	}
	await fs.rm(target, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
}

function resolveDeps(
	overrides: Partial<TailnetSecretFileDeps>,
): TailnetSecretFileDeps {
	const platform = overrides.platform ?? process.platform;
	const rootDir = overrides.rootDir ?? defaultRootDir(platform);
	return {
		platform,
		rootDir,
		now: overrides.now ?? (() => Date.now()),
		staleMs: overrides.staleMs ?? DEFAULT_STALE_MS,
		removeDir:
			overrides.removeDir ?? ((dir) => removeOwnedDir(dir, rootDir)),
		restrictWindowsDirectory:
			overrides.restrictWindowsDirectory ?? restrictWindowsDirectory,
	};
}

/**
 * 在受限临时文件中短时暴露 auth key，并保证消费结束后删除。
 *
 * 清理失败一律返回 `TAILNET_SECRET_CLEANUP_FAILED`，不虚报成功。
 */
export async function withTailnetSecretFile<T>(
	authKey: string,
	run: (path: string) => Promise<T>,
	overrides: Partial<TailnetSecretFileDeps> = {},
): Promise<T> {
	const deps = resolveDeps(overrides);
	assertSecretText(authKey);

	await fs.mkdir(deps.rootDir, { recursive: true, mode: 0o700 });
	const dir = join(deps.rootDir, randomUUID());
	await fs.mkdir(dir, { mode: 0o700 });

	if (deps.platform === "win32") {
		try {
			await deps.restrictWindowsDirectory(dir);
		} catch (error) {
			await deps.removeDir(dir).catch(() => undefined);
			throw secretError(
				"TAILNET_SECRET_DENIED",
				(error as Error).message || "无法限制密钥目录权限",
			);
		}
	}

	const file = join(dir, "authkey");
	ACTIVE_DIRS.add(dir);
	let result: T | undefined;
	let thrown: unknown;
	let hasThrown = false;
	try {
		await fs.writeFile(file, authKey, { flag: "wx", mode: 0o600 });
		if (deps.platform !== "win32") {
			const stats = await fs.stat(file);
			if ((stats.mode & 0o077) !== 0) {
				throw secretError("TAILNET_SECRET_DENIED", "密钥文件权限过宽");
			}
		}
		result = await run(file);
	} catch (error) {
		hasThrown = true;
		thrown = error;
	} finally {
		ACTIVE_DIRS.delete(dir);
	}

	let cleanupFailed = false;
	try {
		await deps.removeDir(dir);
	} catch {
		cleanupFailed = true;
	}
	if (cleanupFailed) {
		throw secretError(
			"TAILNET_SECRET_CLEANUP_FAILED",
			"密钥文件清理失败",
		);
	}
	if (hasThrown) {
		throw thrown;
	}
	return result as T;
}

/**
 * 清理本进程此前遗留的过期密钥目录。
 *
 * 只处理自有根目录下的普通目录，不跟随符号链接，不删除在途目录。
 */
export async function cleanupTailnetSecretFiles(
	overrides: Partial<TailnetSecretFileDeps> = {},
): Promise<void> {
	const deps = resolveDeps(overrides);
	let entries;
	try {
		entries = await fs.readdir(deps.rootDir, { withFileTypes: true });
	} catch {
		return;
	}
	const threshold = deps.now() - deps.staleMs;
	let failed = false;
	for (const entry of entries) {
		if (!entry.isDirectory() || ACTIVE_DIRS.has(join(deps.rootDir, entry.name))) {
			continue;
		}
		const dir = join(deps.rootDir, entry.name);
		try {
			const stats = await fs.lstat(dir);
			if (stats.isSymbolicLink() || stats.mtimeMs > threshold) {
				continue;
			}
			await deps.removeDir(dir);
		} catch {
			failed = true;
		}
	}
	if (failed) {
		throw secretError(
			"TAILNET_SECRET_CLEANUP_FAILED",
			"存在无法清理的过期密钥目录",
		);
	}
}
