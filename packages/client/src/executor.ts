import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import { killProcessTree } from "./terminal/process-tree.js";
import { applyGitSshEnv } from "./git-ssh/runtime.js";
import { Events } from "@vcpdeck/shared";
import type {
	JobOutput,
	JobDone,
	ExecJobDone,
	JobCancelled,
	JobCancelFailed,
	JobStatusReport,
} from "@vcpdeck/shared";

interface ActiveJob {
	jobId: string;
	process: ChildProcess;
	startTime: number;
	cancelling?: boolean;
	timedOut?: boolean;
	timeoutTimer?: ReturnType<typeof setTimeout>;
}

const activeJobs = new Map<string, ActiveJob>();

/**
 * 进程本体退出后等待 stdout/stderr 排空的上限。
 * 被分离出去的长驻孙进程会一直持有管道，不能无限等（见 executeExec 里的 finalize）。
 */
const OUTPUT_DRAIN_GRACE_MS = 1000;

/** 幂等终态：只执行一次 action */
function settle(jobId: string, action: () => void) {
	const active = activeJobs.get(jobId);
	if (!active) return; // 已终态，忽略
	if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
	activeJobs.delete(jobId);
	action();
}

type ExecJob =
	| {
			jobId: string;
			mode: "command";
			command: string;
			cwd?: string;
			timeout?: number;
	  }
	| {
			jobId: string;
			mode: "script";
			executable: string;
			args: string[];
			script: string;
			cwd?: string;
			timeout?: number;
	  };

export function executeExec(job: ExecJob, socket: Socket) {
	let child: ChildProcess;
	let stdoutBuf = "";
	let stderrBuf = "";

	if (job.mode === "command") {
		// Windows cmd 默认输出 GBK，先切到 UTF-8 代码页
		const cmd =
			process.platform === "win32"
				? `chcp 65001 > nul && ${job.command}`
				: job.command;
		child = spawn(cmd, {
			shell: true,
			cwd: job.cwd,
			// 受管 Git SSH：只有 VCPDeck 启动的进程继承（不修改 process.env 全局）。
			env: applyGitSshEnv(),
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	} else {
		child = spawn(job.executable, job.args, {
			shell: false,
			cwd: job.cwd,
			// 受管 Git SSH：只有 VCPDeck 启动的进程继承（不修改 process.env 全局）。
			env: applyGitSshEnv(),
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	}

	// ── 注册 activeJob ──
	const active: ActiveJob = {
		jobId: job.jobId,
		process: child,
		startTime: Date.now(),
	};
	activeJobs.set(job.jobId, active);
	if (job.timeout !== undefined) {
		active.timeoutTimer = setTimeout(() => {
			const current = activeJobs.get(job.jobId);
			if (
				!current ||
				current.cancelling ||
				current.process.exitCode !== null ||
				current.process.signalCode !== null
			)
				return;
			current.timedOut = true;
			void terminateActiveJob(current);
		}, job.timeout);
	}

	// ── stdout ──
	child.stdout?.on("data", (data: Buffer) => {
		const text = data.toString();
		stdoutBuf += text;
		socket.emit(Events.JOB_STDOUT, {
			jobId: job.jobId,
			text,
		} satisfies JobOutput);
	});

	// ── stderr ──
	child.stderr?.on("data", (data: Buffer) => {
		const text = data.toString();
		stderrBuf += text;
		socket.emit(Events.JOB_STDERR, {
			jobId: job.jobId,
			text,
		} satisfies JobOutput);
	});

	// ── 结算（幂等） ──
	// 为什么不能只等 `close`：`close` 要求 stdio 全部关闭，而脚本常用 `Start-Process`
	// 或后台符把长驻子进程（redis、java、vite…）分离出去，这些孙进程会继承本 Job 的
	// stdout/stderr 管道并长期持有它 —— 脚本本体几秒就退出了，Job 却永远停在 running：
	// 占住该 Client 的并发槽，且让发布 drain 永远等不到收敛（2026-10-10 生产：两条
	// exec Job 卡了 17 小时，整个发版因此失败）。因此以 `exit`（进程本体退出）为准，
	// 只给它一个有限的输出排空窗口。
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (drainTimer) {
			clearTimeout(drainTimer);
			drainTimer = undefined;
		}
		// 先捕获终止原因，settle 会删除 map 条目
		const current = activeJobs.get(job.jobId);
		const wasCancelling = current?.cancelling ?? false;
		const timedOut = current?.timedOut ?? false;
		settle(job.jobId, () => {
			if (timedOut) {
				socket.emit(Events.JOB_DONE, {
					jobId: job.jobId,
					type: "exec" as const,
					error: {
						code: "EXEC_TIMEOUT",
						message: `Execution timed out after ${job.timeout} ms`,
					},
					stdout: stdoutBuf || undefined,
					stderr: stderrBuf || undefined,
				} satisfies JobDone);
				return;
			}
			if (wasCancelling) {
				socket.emit(Events.JOB_CANCELLED, {
					jobId: job.jobId,
				} satisfies JobCancelled);
				return;
			}
			if (code === null) {
				socket.emit(Events.JOB_DONE, {
					jobId: job.jobId,
					type: "exec" as const,
					error: {
						code: "EXEC_SIGNALLED",
						message: `Process terminated by ${signal ?? "an unknown signal"}`,
					},
					stdout: stdoutBuf || undefined,
					stderr: stderrBuf || undefined,
				} satisfies JobDone);
				return;
			}
			socket.emit(Events.JOB_DONE, {
				jobId: job.jobId,
				type: "exec" as const,
				exitCode: code,
				stdout: stdoutBuf || undefined,
				stderr: stderrBuf || undefined,
			} satisfies ExecJobDone);
		});
	};

	child.on("exit", (code, signal) => {
		// 进程本体已退出：给管道一个有限排空窗口后强制结算（`close` 可能永远不来）。
		drainTimer = setTimeout(
			() => finalize(code, signal),
			OUTPUT_DRAIN_GRACE_MS,
		);
		drainTimer.unref?.();
	});

	child.on("close", finalize);

	// ── spawn error（幂等） ──
	child.on("error", (err) => {
		settle(job.jobId, () => {
			socket.emit(Events.JOB_DONE, {
				jobId: job.jobId,
				type: "exec" as const,
				error: {
					code: "EXEC_SPAWN_FAILED",
					message: safeSpawnErrorMessage(err.message),
				},
			} satisfies JobDone);
		});
	});

	// ── script 模式：写 stdin ──
	if (job.mode === "script") {
		child.stdin?.on("error", () => {
			const current = activeJobs.get(job.jobId);
			settle(job.jobId, () => {
				if (current) void terminateActiveJob(current);
				socket.emit(Events.JOB_DONE, {
					jobId: job.jobId,
					type: "exec" as const,
					error: {
						code: "EXEC_STDIN_FAILED",
						message: "Failed to write script to stdin",
					},
				} satisfies JobDone);
			});
		});
		child.stdin?.end(job.script, "utf8");
	}
}

/** 终止 Job 进程树；平台树清理失败时至少终止直接子进程。 */
async function terminateActiveJob(active: ActiveJob): Promise<void> {
	if (
		active.process.exitCode !== null ||
		active.process.signalCode !== null
	)
		return;
	const pid = active.process.pid;
	if (pid) await killProcessTree(pid);
	if (active.process.exitCode === null) {
		try {
			active.process.kill("SIGKILL");
		} catch {
			/* 已退出 */
		}
	}
}

/** 去除 spawn error 中的明显本地路径 */
function safeSpawnErrorMessage(msg: string): string {
	return msg
		.replace(/[A-Za-z]:\\[^\s"]*/g, "<path>")
		.replace(/\/[^\s"]*/g, "<path>");
}

export function killJob(jobId: string, socket: Socket) {
	const active = activeJobs.get(jobId);
	if (!active) {
		socket.emit(Events.JOB_CANCEL_FAILED, {
			jobId,
			reason: "Job not found",
		} satisfies JobCancelFailed);
		return;
	}

	if (!active.timedOut) active.cancelling = true;
	if (active.timeoutTimer) {
		clearTimeout(active.timeoutTimer);
		active.timeoutTimer = undefined;
	}
	void terminateActiveJob(active).catch((error: unknown) => {
		socket.emit(Events.JOB_CANCEL_FAILED, {
			jobId,
			reason:
				error instanceof Error
					? safeSpawnErrorMessage(error.message)
					: "Cancellation failed",
		} satisfies JobCancelFailed);
	});
}

export function getRunningJobIds(): string[] {
	return [...activeJobs.keys()];
}

export function getStatusReport(): JobStatusReport[] {
	return [...activeJobs.values()].map((job) => ({
		jobId: job.jobId,
		status:
			job.process.exitCode === null
				? "running"
				: job.process.exitCode === 0
					? "done"
					: "error",
		exitCode: job.process.exitCode,
	}));
}
