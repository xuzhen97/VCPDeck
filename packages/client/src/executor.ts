import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import { killProcessTree } from "./terminal/process-tree.js";
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
			detached: process.platform !== "win32",
			windowsHide: true,
		});
	} else {
		child = spawn(job.executable, job.args, {
			shell: false,
			cwd: job.cwd,
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

	// ── close（幂等） ──
	child.on("close", (code, signal) => {
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
	});

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
