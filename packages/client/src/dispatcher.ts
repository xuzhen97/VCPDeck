import type { Socket } from "socket.io-client";
import type { JobDispatch } from "@vcpdeck/shared";
import { executeExec } from "./executor.js";

export function dispatch(job: JobDispatch, socket: Socket) {
  switch (job.type) {
    case "exec": {
      const execJob = job as { jobId: string; command: string; timeout?: number };
      return executeExec(
        { jobId: execJob.jobId, command: execJob.command, timeout: execJob.timeout },
        socket,
      );
    }
    case "file.list":
    case "file.stat":
    case "file.readText":
    case "file.writeText":
    case "file.mkdir":
    case "file.delete":
    case "file.move":
    case "file.download":
    case "file.upload":
    case "agent.run":
      // ponytail: 扩展点在 switch，后续每个 type 收敛到独立 handler 文件
      throw new Error(`Job type "${job.type}" not yet implemented`);
    default:
      throw new Error(`Unknown job type: ${(job as any).type}`);
  }
}
