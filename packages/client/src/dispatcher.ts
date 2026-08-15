import type { Socket } from "socket.io-client";
import { Events, type JobDispatch } from "@vcpdeck/shared";
import { executeExec } from "./executor.js";
import { handleFileOp } from "./file-handler.js";
import { handleTransfer } from "./transfer-handler.js";
import { isDraining } from "./update.js";
import {
	handleFrpCreate,
	handleFrpDelete,
	handleFrpList,
} from "./frpc-daemon.js";

export function dispatch(job: JobDispatch, socket: Socket) {
	// 优雅停机守卫：更新期间拒绝新任务（服务端不再派活，双重保险）
	if (isDraining()) {
		socket.emit(Events.JOB_DONE, {
			jobId: job.jobId,
			type: job.type,
			error: {
				code: "CLIENT_UPDATING",
				message: "客户端正在更新，拒绝新任务",
			},
		});
		return;
	}
	switch (job.type) {
		case "exec": {
			const execJob = job as {
				jobId: string;
				type: "exec";
				mode: "command" | "script";
				command?: string;
				executable?: string;
				args?: string[];
				script?: string;
				cwd?: string;
				timeout?: number;
			};

			if (execJob.mode === "script") {
				return executeExec(
					{
						jobId: execJob.jobId,
						mode: "script",
						executable: execJob.executable!,
						args: execJob.args!,
						script: execJob.script!,
						cwd: execJob.cwd,
						timeout: execJob.timeout,
					},
					socket,
				);
			}

			// command 模式（默认）
			return executeExec(
				{
					jobId: execJob.jobId,
					mode: "command",
					command: execJob.command!,
					cwd: execJob.cwd,
					timeout: execJob.timeout,
				},
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
		case "file.roots":
			return handleFileOp(
				{
					jobId: job.jobId,
					type: job.type,
					payload: (job as any).payload ?? {},
				},
				socket,
			);
		case "file.export":
		case "file.import":
			return handleTransfer(
				{
					jobId: job.jobId,
					type: job.type,
					payload: (job as any).payload ?? {},
				},
				socket,
			);
		case "frp.create":
			return handleFrpCreate(
				{ ...(job as any).payload, _jobId: job.jobId },
				socket,
			);
		case "frp.delete":
			return handleFrpDelete(
				{ ...(job as any).payload, _jobId: job.jobId },
				socket,
			);
		case "frp.list":
			return handleFrpList({ _jobId: job.jobId }, socket);
		case "agent.run":
			throw new Error(`Job type "${job.type}" not yet implemented`);
		default:
			throw new Error(`Unknown job type: ${(job as any).type}`);
	}
}
