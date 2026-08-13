import { spawn } from "node:child_process";
import type { TerminalOutputChunk, TerminalStateReport } from "@vcpdeck/shared";
import { TerminalLimits } from "@vcpdeck/shared";
import { utf8ByteLength } from "@vcpdeck/shared";

/** 平台进程树清理（Windows：taskkill /T /F；POSIX：进程组信号）。 */
export interface ProcessTreeKiller {
	killTree(pid: number): Promise<void>;
}

/** 平台抽象（测试注入）。 */
export interface ProcessTreeKillerEnv {
	platform: NodeJS.Platform;
	killGroupSignal: (pid: number, signal: NodeJS.Signals) => boolean;
	runTaskkill: (pid: number) => Promise<number>;
}

/** Windows：taskkill /PID <pid> /T /F（参数数组，非 shell 调用）。 */
function taskkill(pid: number): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
		});
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}

/**
 * 终止 PTY 进程树。
 * - POSIX：先 SIGTERM 进程组（-pid），兜底 kill(-pid, SIGKILL)；
 * - Windows：taskkill /T /F 结束进程树（ConPTY 关闭后仍可能残留子进程）。
 * 幂等：进程已退出时静默成功。
 */
export async function killProcessTree(
	pid: number,
	env: ProcessTreeKillerEnv = {
		platform: process.platform,
		killGroupSignal: (p, sig) => process.kill(-p, sig),
		runTaskkill: taskkill,
	},
): Promise<void> {
	if (env.platform === "win32") {
		await env.runTaskkill(pid);
		return;
	}
	try {
		env.killGroupSignal(-pid, "SIGTERM");
	} catch {
		/* 进程组不存在：尝试单进程 */
	}
	try {
		await new Promise((resolve) => setTimeout(resolve, 100));
		env.killGroupSignal(-pid, "SIGKILL");
	} catch {
		/* 已退出 */
	}
}
