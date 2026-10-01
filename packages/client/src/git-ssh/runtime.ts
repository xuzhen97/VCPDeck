/**
 * Git SSH 受管密钥运行时（Client 侧单例）。
 *
 * 负责三件事：
 * 1. 惰性解析受管存储（数据根非法时能力不可用，不影响其它能力）；
 * 2. 缓存「是否注入受管 SSH 命令」的结论，使 Job/PTY 启动路径保持同步；
 * 3. 向注册流程提供能力摘要（目录可写 + SSH 可实行 accept-new）。
 *
 * 注入只作用于 VCPDeck 自己创建的进程：不改动 process.env 全局。
 */
import type { GitSshCapability } from "@vcpdeck/shared";
import { probeGitSshCapability } from "./git-ssh-bridge.js";
import { gitSshChildEnv, probeGitSshSshProgram } from "./git-ssh-env.js";
import { createGitSshStore, type GitSshStore } from "./git-ssh-store.js";

let store: GitSshStore | null = null;
let storeUnavailable = false;
/** 已解析的受管 `GIT_SSH_COMMAND`；null 表示当前不注入。 */
let managedCommand: string | null = null;

/** 测试注入或显式替换。 */
export function setGitSshStore(next: GitSshStore | null): void {
	store = next;
	storeUnavailable = next === null;
}

/** 惰性解析受管存储；数据根非法（如位于版本目录内）时返回 null。 */
export function gitSshStoreOrNull(): GitSshStore | null {
	if (store) return store;
	if (storeUnavailable) return null;
	try {
		store = createGitSshStore();
	} catch {
		storeUnavailable = true;
		return null;
	}
	return store;
}

/**
 * 在给定环境上应用受管注入，返回新对象（不修改 `base`）。
 *
 * 未安装受管密钥时**移除**继承来的 `GIT_SSH_COMMAND`：避免 VCPDeck 子进程
 * 使用环境里其它来源的 SSH 命令。
 */
export function applyGitSshEnv(
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...base };
	delete next.GIT_SSH_COMMAND;
	if (managedCommand !== null) next.GIT_SSH_COMMAND = managedCommand;
	return next;
}

/** 重新计算受管注入结论；在注册成功与每次安装/清理回执后调用。 */
export async function refreshGitSshEnv(): Promise<void> {
	const current = gitSshStoreOrNull();
	if (!current) {
		managedCommand = null;
		return;
	}
	try {
		const env = await gitSshChildEnv(
			{},
			{ store: current, probeSsh: () => probeGitSshSshProgram() },
		);
		managedCommand = env.GIT_SSH_COMMAND ?? null;
	} catch {
		managedCommand = null;
	}
}

/** 注册时上报的能力摘要：目录可写 + SSH 能实行主机公钥校验。 */
export async function probeGitSshCapabilityForClient(): Promise<GitSshCapability> {
	const current = gitSshStoreOrNull();
	if (!current) return { available: false, code: "GIT_SSH_UNAVAILABLE" };
	return probeGitSshCapability(current, async () => {
		const program = await probeGitSshSshProgram();
		return program !== null && program.supportsAcceptNew;
	});
}
