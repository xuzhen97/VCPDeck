/**
 * Linux 特权命令包装（ADR-0023）。
 *
 * Linux 上的 Client 以专用 `vcpdeck` 账户运行，root 等价权限来自 sudoers 的
 * `(ALL:ALL) NOPASSWD: ALL`，而不是 uid 0。服务管理与 `tailscale up` 都需要
 * root，因此统一补 `sudo -n`：没有免密 sudo 时立即失败，绝不进入等待密码的
 * 交互流程。
 */
import { execFileSync } from "node:child_process";

/** 一条即将执行的命令。 */
export interface PrivilegedCommand {
	command: string;
	args: string[];
}

/** 当前进程 uid；非 POSIX 平台返回 null。 */
export function currentUid(): number | null {
	try {
		return typeof process.getuid === "function" ? process.getuid() : null;
	} catch {
		return null;
	}
}

/** 该平台与 uid 组合是否需要经 sudo 提权。 */
export function needsEscalation(
	platform: NodeJS.Platform = process.platform,
	uid: number | null = currentUid(),
): boolean {
	return platform === "linux" && uid !== 0;
}

/**
 * 为需要 root 的命令补 `sudo -n`。
 *
 * 只在「Linux 且非 root」时改写；Windows、macOS 和已是 root 的进程原样返回。
 */
export function privileged(
	command: string,
	args: string[],
	platform: NodeJS.Platform = process.platform,
	uid: number | null = currentUid(),
): PrivilegedCommand {
	if (!needsEscalation(platform, uid)) {
		return { command, args };
	}
	return { command: "sudo", args: ["-n", command, ...args] };
}

/**
 * 非交互 sudo 是否真的可用。
 *
 * 用 `sudo -n true` 探测：需要密码、未在 sudoers 中或 sudo 缺失都会立即失败。
 */
export function hasNonInteractiveSudo(): boolean {
	try {
		execFileSync("sudo", ["-n", "true"], {
			stdio: "ignore",
			timeout: 3_000,
		});
		return true;
	} catch {
		return false;
	}
}
