/**
 * VCPDeck Git SSH 进程环境注入（Client 侧）。
 *
 * 权威边界见 docs/adr/0037 决策 3/4 与 docs/adr/0038：
 * - 只有 VCPDeck 启动的 Job/Terminal/Pi 及其子进程使用受管密钥；
 * - 不修改用户或整机 SSH 配置，不把私钥正文放进环境变量；
 * - 不限制 Git 服务主机，但要求主机公钥校验可用：首次自动记录（TOFU），
 *   已记录主机公钥变化时由 OpenSSH 拒绝连接（`accept-new`），不得降级为 `no`；
 * - 任何一项无法保证（SSH 缺失、版本过旧、路径无法安全表示）都不注入（fail closed）。
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { atomicWriteFile, type GitSshStore, type GitSshStorePaths } from "./git-ssh-store.js";

/** 经探测确认可用的 SSH 程序。 */
export interface GitSshSshProgram {
	path: string;
	/** OpenSSH >= 7.6 才支持 `StrictHostKeyChecking accept-new`。 */
	supportsAcceptNew: boolean;
}

export interface GitSshChildEnvOptions {
	store: GitSshStore;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** 探测 SSH 程序；测试注入，缺省走真实探测。 */
	probeSsh?: () => Promise<GitSshSshProgram | null>;
}

/** 无法安全引用为 shell 命令的字符（含引号、变量、命令替换与换行）。 */
const UNSAFE_SHELL_PATH = /["$`\\\r\n]/;

/** 解析 `ssh -V` 输出的 OpenSSH 版本。 */
export function parseOpenSshVersion(output: string): [number, number] | null {
	const match = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(output);
	if (!match) return null;
	return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10)];
}

/** `accept-new`（首次接受并记录、变更即拒绝）自 OpenSSH 7.6 起可用。 */
export function supportsAcceptNew(version: [number, number]): boolean {
	const [major, minor] = version;
	return major > 7 || (major === 7 && minor >= 6);
}

/**
 * 生成受管 ssh_config。
 *
 * 刻意不设置 `GlobalKnownHostsFile`：该指令的 `none` 取值对 OpenSSH 版本敏感，
 * 写错会让 ssh 直接报配置错误；保留全局 known_hosts 只会更严格（命中不同公钥即拒绝），
 * 不会削弱 TOFU 语义。
 */
export function buildSshConfig(paths: {
	privateKeyPath: string;
	knownHostsPath: string;
}): string {
	return [
		"# VCPDeck 受管配置（自动生成，请勿手工编辑）",
		"Host *",
		`  IdentityFile ${paths.privateKeyPath}`,
		"  IdentitiesOnly yes",
		"  StrictHostKeyChecking accept-new",
		`  UserKnownHostsFile ${paths.knownHostsPath}`,
		"  BatchMode yes",
		"",
	].join("\n");
}

/** 构造 `GIT_SSH_COMMAND`；路径无法安全表示时返回 null（调用方 fail closed）。 */
export function buildGitSshCommand(
	sshPath: string,
	configPath: string,
): string | null {
	if (
		sshPath.length === 0 ||
		configPath.length === 0 ||
		UNSAFE_SHELL_PATH.test(sshPath) ||
		UNSAFE_SHELL_PATH.test(configPath)
	) {
		return null;
	}
	return `"${sshPath}" -F "${configPath}"`;
}

/** 读取 `ssh -V`（版本信息写在 stderr）。 */
function readSshVersion(program: string): Promise<string | null> {
	return new Promise((resolve) => {
		let output = "";
		const child = spawn(program, ["-V"], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", () => resolve(null));
		child.on("close", () => resolve(output.length > 0 ? output : null));
	});
}

/** Windows 候选：Git 自带 OpenSSH 优先，其次系统 OpenSSH。 */
function candidateSshPaths(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string[] {
	const explicit = env.VCPDECK_GIT_SSH_PATH;
	const base = explicit ? [explicit] : [];
	if (platform !== "win32") {
		return [...base, "ssh", "/usr/bin/ssh"];
	}
	const programFiles = env.ProgramFiles ?? "C:\\Program Files";
	return [
		...base,
		`${programFiles}\\Git\\usr\\bin\\ssh.exe`,
		"C:\\Windows\\System32\\OpenSSH\\ssh.exe",
	];
}

/** 真实探测本机可用于受管密钥的 SSH 程序。 */
export async function probeGitSshSshProgram(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Promise<GitSshSshProgram | null> {
	for (const candidate of candidateSshPaths(platform, env)) {
		if (platform === "win32" && candidate.includes("\\")) {
			const exists = await stat(candidate).catch(() => null);
			if (!exists?.isFile()) continue;
		}
		const version = await readSshVersion(candidate);
		if (version === null) continue;
		const parsed = parseOpenSshVersion(version);
		if (parsed === null) continue;
		return { path: candidate, supportsAcceptNew: supportsAcceptNew(parsed) };
	}
	return null;
}

/**
 * 受管命令/配置中使用的路径形式。
 *
 * Windows 路径统一转成正斜杠：Windows API 与 OpenSSH 都接受，
 * 同时避免 `\` 在 `GIT_SSH_COMMAND` 的 shell 解析里成为转义前缀。
 */
function toManagedPath(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.replace(/\\/g, "/") : value;
}

/**
 * 生成 VCPDeck 子进程环境。
 *
 * 受管密钥可用时：写入受限 ssh_config 并注入 `GIT_SSH_COMMAND`；
 * 否则：返回不继承 `GIT_SSH_COMMAND` 的环境（避免用错密钥），且不改动 process.env。
 */
export async function gitSshChildEnv(
	base: NodeJS.ProcessEnv,
	options: GitSshChildEnvOptions,
): Promise<NodeJS.ProcessEnv> {
	const platform = options.platform ?? process.platform;
	const next: NodeJS.ProcessEnv = { ...base };
	// 先清除继承值：无论后续是否注入，都不允许环境里的外部 ssh 命令生效。
	delete next.GIT_SSH_COMMAND;

	let hasKey = false;
	try {
		hasKey = await options.store.hasKey();
	} catch {
		hasKey = false;
	}
	if (!hasKey) return next;

	try {
		const probe =
			options.probeSsh ?? (() => probeGitSshSshProgram(platform, options.env));
		const program = await probe();
		if (!program || !program.supportsAcceptNew) return next;

		const paths: GitSshStorePaths = options.store.paths();
		await atomicWriteFile(
			paths.sshConfigPath,
			buildSshConfig({
				privateKeyPath: toManagedPath(paths.privateKeyPath, platform),
				knownHostsPath: toManagedPath(paths.knownHostsPath, platform),
			}),
			platform === "win32" ? undefined : 0o600,
		);
		const command = buildGitSshCommand(
			toManagedPath(program.path, platform),
			toManagedPath(paths.sshConfigPath, platform),
		);
		if (command === null) return next;
		next.GIT_SSH_COMMAND = command;
		return next;
	} catch {
		// 任何探测/写入失败都不注入：宁可 Git 用不到密钥，也不使用不受管的连接参数。
		return next;
	}
}
