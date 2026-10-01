/**
 * VCPDeck Git SSH 受管副本存储（Client 侧）。
 *
 * 权威边界见 docs/adr/0037 决策 2/3 与 docs/adr/0038：
 * - 私钥只落在 VCPDeck 数据根下的专用目录，绝不进入 `apps/<version>` 版本目录；
 * - 目录与文件权限必须可证明已收紧，否则安装 fail closed 且不留下可用私钥；
 * - 清理只删除受管副本，**不代表 Git 服务已撤销该机器的访问**。
 */
import { spawnSync } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import type { GitSshInstallCommand } from "@vcpdeck/shared";

const PRIVATE_KEY_FILE = "id_ed25519";
const PUBLIC_KEY_FILE = "id_ed25519.pub";
const KNOWN_HOSTS_FILE = "known_hosts";
const SSH_CONFIG_FILE = "ssh_config";
const VERSION_FILE = "version";

export function gitSshStoreError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

export interface GitSshStorePaths {
	/** 受管根目录（跨 Release 保留）。 */
	root: string;
	privateKeyPath: string;
	publicKeyPath: string;
	knownHostsPath: string;
	sshConfigPath: string;
	versionPath: string;
}

export interface GitSshStoreOptions {
	/** 显式根目录（测试注入）；缺省由 `resolveGitSshRoot` 推导。 */
	root?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	cwd?: string;
	/** 权限收紧；返回 false 表示无法证明权限已限制 → 安装 fail closed。 */
	restrictPermissions?: (root: string) => Promise<boolean>;
}

export interface GitSshStore {
	paths(): GitSshStorePaths;
	/** 当前已安装版本；未安装返回 null，指针内容非法时 fail closed。 */
	activeVersion(): Promise<number | null>;
	/** 是否存在可用的受管私钥。 */
	hasKey(): Promise<boolean>;
	install(command: GitSshInstallCommand): Promise<void>;
	/** 只清理指定版本；不匹配时为 no-op（防止过期指令清掉新版本）。 */
	clear(version: number): Promise<void>;
}

/**
 * 解析受管根目录：`<数据根>/git-ssh`。
 *
 * 数据根优先级与 Pi 运行时一致（`VCPDECK_CLIENT_DATA_DIR` → `VCPDECK_APP_DIR/data`），
 * 且必须位于版本目录之外，否则 Release 切换/回滚会带走或丢失密钥。
 */
export function resolveGitSshRoot(
	input: Partial<{
		env: NodeJS.ProcessEnv;
		platform: NodeJS.Platform;
		cwd: string;
	}> = {},
): string {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const cwd = input.cwd ?? process.cwd();
	const p = platform === "win32" ? win32 : posix;

	const appDir = env.VCPDECK_APP_DIR || cwd;
	const dataRoot = p.resolve(
		env.VCPDECK_CLIENT_DATA_DIR || p.join(appDir, "data"),
	);
	const releaseRoot = p.resolve(p.join(appDir, "apps"));
	const comparable = (value: string) =>
		platform === "win32" ? value.toLowerCase() : value;
	const root = comparable(dataRoot);
	const releases = comparable(releaseRoot);
	if (root === releases || root.startsWith(`${releases}${p.sep}`)) {
		throw gitSshStoreError(
			"GIT_SSH_UNAVAILABLE",
			"Git SSH 根目录不得位于版本目录内",
		);
	}
	return p.join(dataRoot, "git-ssh");
}

/** 原子写入：同目录临时文件 + rename；避免半写状态被 SSH 读取。 */
export async function atomicWriteFile(
	path: string,
	content: string,
	mode?: number,
): Promise<void> {
	const tmp = `${path}.tmp`;
	await writeFile(tmp, content, mode === undefined ? undefined : { mode });
	await rename(tmp, path);
}

/** POSIX 模式位；Windows 上忽略（权限由 ACL 收紧）。 */
function modeFor(platform: NodeJS.Platform, mode: number): number | undefined {
	return platform === "win32" ? undefined : mode;
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
 * 必须解析：Client 未必以 SYSTEM 运行（dev、PM2 用户态、手工启动），
 * 只授权 SYSTEM 与 Administrators 会把运行账户自己挡在受管目录外。
 * 解析不出可用账户名时返回 null，调用方不追加该授权，
 * 随后的可写性校验会 fail closed，而不是留下装不上的半成品。
 */
export function resolveWindowsGitSshUser(
	input: { whoami?: () => string | null; env?: NodeJS.ProcessEnv } = {},
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

/**
 * icacls 授权参数：关闭继承后，除 SYSTEM 与 Administrators 外必须带上当前账户。
 * 少授权当前账户会让非 SYSTEM 运行的 Client 在收紧瞬间失去目录访问权，
 * 后续写版本指针必然 EACCES。
 */
export function windowsGitSshGrantArgs(currentUser: string | null): string[] {
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
export async function verifyGitSshRootWritable(root: string): Promise<boolean> {
	const probe = join(root, ".acl-probe");
	try {
		await writeFile(probe, "probe");
		await rm(probe, { force: true });
		return true;
	} catch {
		await rm(probe, { force: true }).catch(() => {});
		return false;
	}
}

/**
 * 默认权限收紧：
 * - POSIX：目录 0700（私钥文件在写入时已用 0600），并回读校验；
 * - Windows：用 icacls 关闭继承，授权 SYSTEM、Administrators 与当前运行账户，
 *   再回读确认当前账户仍可写。
 */
async function defaultRestrictPermissions(
	root: string,
	platform: NodeJS.Platform,
): Promise<boolean> {
	if (platform === "win32") {
		const result = spawnSync(
			"icacls",
			[root, ...windowsGitSshGrantArgs(resolveWindowsGitSshUser())],
			{ windowsHide: true, stdio: "ignore" },
		);
		if (result.status !== 0) return false;
		// 收紧后必须回读可写性：ACL 可能把运行账户挡在目录外，
		// 此时下一步写版本指针会以 EACCES 失败并掩盖真实原因。
		return verifyGitSshRootWritable(root);
	}
	try {
		await chmod(root, 0o700);
		const info = await stat(root);
		return (info.mode & 0o777) === 0o700;
	} catch {
		return false;
	}
}

export function createGitSshStore(options: GitSshStoreOptions = {}): GitSshStore {
	const platform = options.platform ?? process.platform;
	const root = options.root ?? resolveGitSshRoot(options);
	const p = platform === "win32" ? win32 : posix;
	const paths: GitSshStorePaths = {
		root,
		privateKeyPath: p.join(root, PRIVATE_KEY_FILE),
		publicKeyPath: p.join(root, PUBLIC_KEY_FILE),
		knownHostsPath: p.join(root, KNOWN_HOSTS_FILE),
		sshConfigPath: p.join(root, SSH_CONFIG_FILE),
		versionPath: p.join(root, VERSION_FILE),
	};
	const restrict =
		options.restrictPermissions ??
		((dir: string) => defaultRestrictPermissions(dir, platform));

	async function activeVersion(): Promise<number | null> {
		let content: string;
		try {
			content = await readFile(paths.versionPath, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw gitSshStoreError(
				"GIT_SSH_UNAVAILABLE",
				"无法读取 Git SSH 版本指针",
			);
		}
		const trimmed = content.trim();
		if (!/^[1-9][0-9]*$/.test(trimmed)) {
			throw gitSshStoreError(
				"GIT_SSH_UNAVAILABLE",
				"Git SSH 版本指针内容非法",
			);
		}
		return Number.parseInt(trimmed, 10);
	}

	async function hasKey(): Promise<boolean> {
		let version: number | null;
		try {
			version = await activeVersion();
		} catch {
			return false;
		}
		if (version === null) return false;
		const info = await lstat(paths.privateKeyPath).catch(() => null);
		return info !== null && info.isFile() && !info.isSymbolicLink();
	}

	return {
		paths: () => paths,
		activeVersion,
		hasKey,
		async install(command: GitSshInstallCommand): Promise<void> {
			await mkdir(paths.root, { recursive: true });
			// 越界防护：受管根目录不得是符号链接/junction。
			const rootInfo = await lstat(paths.root).catch(() => null);
			if (rootInfo?.isSymbolicLink()) {
				throw gitSshStoreError(
					"GIT_SSH_INSTALL_FAILED",
					"Git SSH 根目录不得为符号链接",
				);
			}

			const current = await activeVersion();
			if (current !== null && command.version < current) {
				throw gitSshStoreError(
					"GIT_SSH_INSTALL_FAILED",
					`拒绝安装过期版本 ${command.version}（当前 ${current}）`,
				);
			}
			// 同版本重发（Client 重连对账、重复保存分发范围）：本地副本在位即视为已安装。
			// Server 保留重发能力是为了自愈“本地副本被删”的机器；若这里报失败，
			// 一台密钥完好的机器会在每次重连后变成 failed 且不自愈。
			if (current === command.version && (await hasKey())) return;

			try {
				// 先收紧目录权限再落盘密钥：收紧前写盘会让私钥在窗口内继承父目录默认 ACL。
				if (!(await restrict(paths.root))) {
					throw gitSshStoreError(
						"GIT_SSH_INSTALL_FAILED",
						"无法确认 Git SSH 目录权限已收紧且当前账户可写",
					);
				}
				await atomicWriteFile(
					paths.privateKeyPath,
					`${command.privateKey}\n`,
					modeFor(platform, 0o600),
				);
				await atomicWriteFile(
					paths.publicKeyPath,
					`${command.publicKey}\n`,
					modeFor(platform, 0o644),
				);
				// 版本指针最后提交：任何失败都不会让半成品被当成可用密钥。
				await atomicWriteFile(
					paths.versionPath,
					`${command.version}\n`,
					modeFor(platform, 0o600),
				);
			} catch (error) {
				await rm(paths.privateKeyPath, { force: true });
				await rm(paths.publicKeyPath, { force: true });
				await rm(paths.versionPath, { force: true });
				throw error;
			}
		},
		async clear(version: number): Promise<void> {
			const current = await activeVersion();
			// 未安装：幂等成功；版本不匹配：过期清理，不得动当前密钥。
			if (current === null || current !== version) return;
			await rm(paths.privateKeyPath, { force: true });
			await rm(paths.publicKeyPath, { force: true });
			await rm(paths.sshConfigPath, { force: true });
			await rm(paths.versionPath, { force: true });
		},
	};
}
