import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type {
  JobDispatch,
  JobOutput,
  JobDone,
  JobCancelled,
  JobCancelFailed,
  JobStatusReport,
} from "@vcpdeck/shared";

interface ActiveJob {
  jobId: string;
  process: ChildProcess;
  startTime: number;
}

const activeJobs = new Map<string, ActiveJob>();

export function executeJob(job: JobDispatch, socket: Socket) {
  const child = spawn(job.command, {
    shell: true,
    timeout: job.timeout,
  });

  activeJobs.set(job.jobId, {
    jobId: job.jobId,
    process: child,
    startTime: Date.now(),
  });

  child.stdout?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDOUT, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  child.stderr?.on("data", (data: Buffer) => {
    socket.emit(Events.JOB_STDERR, {
      jobId: job.jobId,
      text: data.toString(),
    } satisfies JobOutput);
  });

  child.on("close", (code) => {
    activeJobs.delete(job.jobId);
    socket.emit(Events.JOB_DONE, {
      jobId: job.jobId,
      exitCode: code ?? 1,
    } satisfies JobDone);
  });

  child.on("error", (err) => {
    if (!activeJobs.has(job.jobId)) return;
    activeJobs.delete(job.jobId);
    socket.emit(Events.JOB_STDERR, {
      jobId: job.jobId,
      text: err.message,
    } satisfies JobOutput);
    socket.emit(Events.JOB_DONE, {
      jobId: job.jobId,
      exitCode: 1,
    } satisfies JobDone);
  });
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
      socket.emit(Events.JOB_CANCELLED, { jobId } satisfies JobCancelled);
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
