import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
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
}

const activeJobs = new Map<string, ActiveJob>();

/** 幂等终态：只执行一次 action */
function settle(jobId: string, action: () => void) {
	if (!activeJobs.has(jobId)) return; // 已终态，忽略
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
			timeout: job.timeout,
			windowsHide: true,
		});
	} else {
		child = spawn(job.executable, job.args, {
			shell: false,
			cwd: job.cwd,
			timeout: job.timeout,
			windowsHide: true,
		});
	}

	// ── 注册 activeJob ──
	activeJobs.set(job.jobId, {
		jobId: job.jobId,
		process: child,
		startTime: Date.now(),
	});

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
	child.on("close", (code) => {
		// 先捕获 cancelling 标记，settle 会删除 map 条目
		const wasCancelling = activeJobs.get(job.jobId)?.cancelling ?? false;
		settle(job.jobId, () => {
			if (wasCancelling) {
				socket.emit(Events.JOB_CANCELLED, {
					jobId: job.jobId,
				} satisfies JobCancelled);
				return;
			}
			socket.emit(Events.JOB_DONE, {
				jobId: job.jobId,
				type: "exec" as const,
				exitCode: code ?? 1,
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
			settle(job.jobId, () => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
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

	try {
		active.cancelling = true;
		active.process.kill("SIGTERM");

		const killTimer = setTimeout(() => {
			if (active.process.exitCode === null) {
				try {
					active.process.kill("SIGKILL");
				} catch {
					// process already gone
				}
			}
		}, 5000);

		active.process.on("close", () => {
			clearTimeout(killTimer);
			// 幂等：close 事件中已通过 settle 处理
		});
	} catch (err: any) {
		socket.emit(Events.JOB_CANCEL_FAILED, {
			jobId,
			reason: err.message,
		} satisfies JobCancelFailed);
	}
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
