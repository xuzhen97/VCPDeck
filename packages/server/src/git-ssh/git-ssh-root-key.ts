/**
 * Git SSH 加密根密钥的受管文件（Server 侧）。
 *
 * 权威边界见 `docs/adr/0037`：
 * - 根密钥位于**版本目录外**的持久化数据根（`<appDir|cwd>/data/git-ssh/root.key`），
 *   自更新切换版本不会带走或丢失；
 * - 显式 `VCPDECK_GIT_SSH_KEY_FILE` 优先，此类路径**只读**，既不自动创建也不回退；
 * - 只有「数据库中没有历史 Git SSH 密钥记录」时才允许首次自动创建；
 *   已有密文而根密钥缺失/损坏/错绑时必须 fail closed，绝不静默换钥；
 * - 先收紧目录权限再写入秘密；并发首次创建只允许一个赢家，半写状态不外泄；
 * - 错误只暴露稳定安全码，不回显路径、密钥内容或原始 IO 异常。
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { GIT_SSH_KEY_FILE_ENV } from "./git-ssh-crypto.js";

/**
 * 密钥字节数（AES-256）。
 *
 * 模块内部使用；不作为对外契约导出，避免扩大公共面。
 */
const GIT_SSH_ROOT_KEY_BYTES = 32;
/** 受管文件名。 */
const ROOT_KEY_FILE = "root.key";
/** POSIX 权限：目录 0700、文件 0600。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function gitSshRootKeyError(message: string): Error {
	return Object.assign(new Error(message), { code: "GIT_SSH_KEY_UNAVAILABLE" });
}

/** 统一安全文案：不暴露路径与原始 IO 细节。 */
const UNAVAILABLE_MESSAGE = "Git SSH 根密钥不可用";

export interface GitSshRootKeyOptions {
	platform?: NodeJS.Platform;
	/** 收紧目录权限；返回 false 表示无法证明已限制 → 调用方 fail closed。 */
	restrict?: (dir: string) => Promise<boolean>;
	/** 测试注入随机源；缺省使用系统安全随机源。 */
	randomKey?: () => Buffer;
	/** 测试注入 `whoami` 解析（Windows ACL 授权当前账户用）。 */
	currentUser?: () => string | null;
}

function pathApi(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

/**
 * 解析根密钥文件位置。
 *
 * 显式 `VCPDECK_GIT_SSH_KEY_FILE` 原样优先（调用方须据此禁用自动创建）；
 * 否则为 `<VCPDECK_APP_DIR|cwd>/data/git-ssh/root.key`。
 */
export function resolveGitSshRootKeyPath(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	platform: NodeJS.Platform = process.platform,
): string {
	const explicit = env[GIT_SSH_KEY_FILE_ENV];
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const appDir = env.VCPDECK_APP_DIR || cwd;
	const p = pathApi(platform);
	const dataRoot = p.resolve(p.join(appDir, "data"));
	const releaseRoot = p.resolve(p.join(appDir, "apps"));
	const comparable = (value: string) =>
		platform === "win32" ? value.toLowerCase() : value;
	const data = comparable(dataRoot);
	const releases = comparable(releaseRoot);
	// 与 Client 受管目录同样的守卫：数据根不得落在 Launcher 版本目录内。
	if (data === releases || data.startsWith(`${releases}${p.sep}`)) {
		throw gitSshRootKeyError("Git SSH 根密钥数据根不得位于版本目录内");
	}
	return p.join(dataRoot, "git-ssh", ROOT_KEY_FILE);
}

/** 位置是否来自显式环境变量（显式路径永不被自动创建或回退）。 */
export function isExplicitGitSshRootKey(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const explicit = env[GIT_SSH_KEY_FILE_ENV];
	return typeof explicit === "string" && explicit.length > 0;
}

/** 逐级向上检查，拒绝路径经过符号链接/junction。 */
async function assertNoSymlinkAncestors(
	dir: string,
	platform: NodeJS.Platform,
): Promise<void> {
	const p = pathApi(platform);
	let current = p.resolve(dir);
	for (;;) {
		const info = await lstat(current).catch(() => null);
		if (info?.isSymbolicLink()) {
			throw gitSshRootKeyError("Git SSH 根密钥路径不得经过符号链接");
		}
		const parent = p.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

/** 规范 base64 的 32 字节解码；任何偏差 fail closed。 */
function decodeRootKey(content: string): Buffer {
	const trimmed = content.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	const key = Buffer.from(trimmed, "base64");
	if (key.length !== GIT_SSH_ROOT_KEY_BYTES) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	// 非规范 base64（多余填充位）同样拒绝，避免同一密钥有多种表示。
	if (key.toString("base64") !== trimmed) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	return key;
}

/**
 * 读取根密钥。
 *
 * 仅「文件不存在」返回 `null`（供调用方区分“未创建”与“已损坏”）；
 * 内容非法、指向符号链接、读取失败一律抛安全码，调用方不得据此覆盖重建。
 */
export async function readGitSshRootKey(
	path: string,
	options: Pick<GitSshRootKeyOptions, "platform"> = {},
): Promise<Buffer | null> {
	const platform = options.platform ?? process.platform;
	await assertNoSymlinkAncestors(pathApi(platform).dirname(path), platform);
	const info = await lstat(path).catch(() => null);
	if (info === null) return null;
	if (info.isSymbolicLink() || !info.isFile()) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	return decodeRootKey(content);
}

/** 授权名单里不允许出现的字符：会破坏 `name:(OI)(CI)F` 的 icacls 参数解析。 */
function isGrantableAccountName(value: string): boolean {
	return (
		value.length > 0 &&
		!value.includes('"') &&
		!value.includes(":") &&
		!value.includes("/")
	);
}

/**
 * 解析 Windows 当前账户名（icacls 需要 `DOMAIN\user` 形式）。
 *
 * 必须解析：Server 未必以 SYSTEM 运行，只授权 SYSTEM 与 Administrators
 * 会把运行账户自己挡在受管目录外。
 */
function resolveWindowsServerAccount(
	input: {
		whoami?: () => string | null;
		env?: NodeJS.ProcessEnv;
	} = {},
): string | null {
	const whoami =
		input.whoami ??
		(() => {
			const result = spawnSync("whoami", [], {
				windowsHide: true,
				encoding: "utf8",
			});
			return result.status === 0 && typeof result.stdout === "string"
				? result.stdout.trim()
				: null;
		});
	const fromWhoami = whoami();
	if (fromWhoami && isGrantableAccountName(fromWhoami)) return fromWhoami;
	const env = input.env ?? process.env;
	const name = env.USERNAME?.trim();
	if (!name) return null;
	const domain = env.USERDOMAIN?.trim();
	const candidate = domain ? `${domain}\\${name}` : name;
	return isGrantableAccountName(candidate) ? candidate : null;
}

/** icacls 授权参数：除 SYSTEM 与 Administrators 外必须带上当前运行账户。 */
function windowsRootKeyGrantArgs(currentUser: string | null): string[] {
	const args = [
		"/inheritance:r",
		"/grant:r",
		"SYSTEM:(OI)(CI)F",
		"Administrators:(OI)(CI)F",
	];
	if (currentUser && isGrantableAccountName(currentUser)) {
		args.push(`${currentUser}:(OI)(CI)F`);
	}
	return args;
}

/** 收紧后回读校验：确认当前进程仍能在受管目录内创建并删除文件。 */
async function verifyRootKeyDirWritable(dir: string): Promise<boolean> {
	// 探针名必须唯一：并发首次创建会同时校验，共用一个名字会互相 EEXIST。
	const probe = join(dir, `.acl-probe.${randomBytes(8).toString("hex")}`);
	try {
		const handle = await open(probe, "wx");
		await handle.close();
		await rm(probe, { force: true });
		return true;
	} catch {
		await rm(probe, { force: true }).catch(() => {});
		return false;
	}
}

/**
 * 同一目录的权限收紧串行化。
 *
 * 并发首次创建时逐个执行收紧与回读校验：仍各自完成证明，
 * 但不会让 `icacls`/探针在同一目录上互相干扰而误报失败。
 */
const restrictChains = new Map<string, Promise<unknown>>();

async function serializeByDir<T>(dir: string, task: () => Promise<T>): Promise<T> {
	const previous = restrictChains.get(dir) ?? Promise.resolve();
	const run = previous.then(() => task());
	const guarded = run.catch(() => {});
	restrictChains.set(dir, guarded);
	try {
		return await run;
	} finally {
		if (restrictChains.get(dir) === guarded) restrictChains.delete(dir);
	}
}

/** 默认权限收紧：POSIX 目录 0700，Windows 关闭继承并授权运行账户。 */
async function defaultRestrictPermissions(
	dir: string,
	platform: NodeJS.Platform,
	currentUser?: () => string | null,
): Promise<boolean> {
	if (platform === "win32") {
		const result = spawnSync(
			"icacls",
			[dir, ...windowsRootKeyGrantArgs((currentUser ?? resolveWindowsServerAccount)())],
			{ windowsHide: true, stdio: "ignore" },
		);
		if (result.status !== 0) return false;
		return verifyRootKeyDirWritable(dir);
	}
	try {
		await chmod(dir, DIR_MODE);
		const info = await stat(dir);
		return (info.mode & 0o777) === DIR_MODE;
	} catch {
		return false;
	}
}

/**
 * 首次发布受管根密钥；已有可读密钥时幂等复用。
 *
 * 流程：校验路径无符号链接 → 建目录 → 已有密钥则直接复用（不 chmod、不覆盖）
 * → 收紧目录权限 → 同目录独占临时文件写入并 sync → `link` 原子发布
 * → 回读校验。并发时只有一个赢家，其余读取赢家结果。
 */
export async function createGitSshRootKey(
	path: string,
	options: GitSshRootKeyOptions = {},
): Promise<Buffer> {
	const platform = options.platform ?? process.platform;
	const p = pathApi(platform);
	const dir = p.dirname(path);
	await assertNoSymlinkAncestors(dir, platform);
	await mkdir(dir, { recursive: true }).catch(() => {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	});
	const dirInfo = await lstat(dir).catch(() => null);
	if (dirInfo === null || dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}

	// 已有密钥：只读复用，不改变其权限或内容。损坏时读取本身即失败。
	const existing = await readGitSshRootKey(path, { platform });
	if (existing) return existing;

	const restrict =
		options.restrict ??
		((target: string) =>
			defaultRestrictPermissions(target, platform, options.currentUser));
	if (!(await serializeByDir(dir, () => restrict(dir)))) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}

	const key = (options.randomKey ?? (() => randomBytes(GIT_SSH_ROOT_KEY_BYTES)))();
	if (key.length !== GIT_SSH_ROOT_KEY_BYTES) {
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	}
	const payload = `${key.toString("base64")}\n`;
	const temp = p.join(dir, `.root.key.${randomBytes(8).toString("hex")}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(temp, "wx", FILE_MODE);
		await handle.writeFile(payload, "utf8");
		// 先落盘再去掉内存态，避免断电后留下空文件被当成合法密钥。
		await handle.sync();
		await handle.close();
		handle = null;
		try {
			await link(temp, path);
		} catch {
			// 可能是并发赢家已发布：读取并校验正式文件；不可读则失败。
			const winner = await readGitSshRootKey(path, { platform });
			if (winner) return winner;
			throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
		}
		const published = await readGitSshRootKey(path, { platform });
		if (!published || !published.equals(key)) {
			throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
		}
		return published;
	} catch (error) {
		if (error instanceof Error && (error as { code?: string }).code === "GIT_SSH_KEY_UNAVAILABLE") {
			throw error;
		}
		throw gitSshRootKeyError(UNAVAILABLE_MESSAGE);
	} finally {
		await handle?.close().catch(() => {});
		await rm(temp, { force: true }).catch(() => {});
	}
}
