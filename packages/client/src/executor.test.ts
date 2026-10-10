import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, type JobDone } from "@vcpdeck/shared";
import { executeExec, killJob } from "./executor.js";

describe("executeExec", () => {
	it("超时终止命令进程树并上报 EXEC_TIMEOUT，而不是伪造 exitCode 1", async () => {
		const done = new Promise<JobDone>((resolve) => {
			const socket = {
				emit: vi.fn((event: string, data: JobDone) => {
					if (event === Events.JOB_DONE) resolve(data);
				}),
			} as unknown as Socket;

			executeExec(
				{
					jobId: "timeout-job",
					mode: "command",
					command:
						'node -e "console.log(\'READY\'); setInterval(() => {}, 1000)"',
					timeout: 500,
				},
				socket,
			);
		});

		await expect(done).resolves.toMatchObject({
			jobId: "timeout-job",
			type: "exec",
			error: {
				code: "EXEC_TIMEOUT",
				message: "Execution timed out after 500 ms",
			},
			stdout: expect.stringContaining("READY"),
		});
	}, 10_000);

	it("用户取消终止命令进程树并上报 cancelled", async () => {
		const cancelled = new Promise<JobDone>((resolve) => {
			const socket = {
				emit: vi.fn((event: string, data: JobDone) => {
					if (event === Events.JOB_STDOUT && "text" in data) {
						killJob("cancel-job", socket);
					}
					if (event === Events.JOB_CANCELLED) resolve(data);
				}),
			} as unknown as Socket;

			executeExec(
				{
					jobId: "cancel-job",
					mode: "command",
					command:
						'node -e "console.log(\'READY\'); setInterval(() => {}, 1000)"',
				},
				socket,
			);
		});

				await expect(cancelled).resolves.toMatchObject({ jobId: "cancel-job" });
	}, 10_000);

it("脚本已退出但被分离的孙进程仍持有管道时，仍按有限排空窗口结算", async () => {
		const started = Date.now();
		const done = new Promise<JobDone>((resolve) => {
			const socket = {
				emit: vi.fn((event: string, data: JobDone) => {
					if (event === Events.JOB_DONE) resolve(data);
				}),
			} as unknown as Socket;

			// 复现 2026-10-10 生产事故：脚本派生一个「继承本 Job 管道」的孙进程（保留 20s）
			// 后立即退出。旧实现只等 `close`，会一直等到孙进程结束才结算（生产里是 17 小时）；
			// 现在以 `exit` 为准 + 有限排空窗口，必须在窗口内完成。
			executeExec(
				{
					jobId: "drain-job",
					mode: "command",
					command:
						'node -e "require(\'child_process\').spawn(process.execPath,[\'-e\',\'setTimeout(()=>{},20000)\'],{detached:true,stdio:[\'ignore\',\'inherit\',\'inherit\']}).unref();console.log(\'SPAWNED\')"',
				},
				socket,
			);
		});

		await expect(done).resolves.toMatchObject({
			jobId: "drain-job",
			type: "exec",
			exitCode: 0,
			stdout: expect.stringContaining("SPAWNED"),
		});
		// 孙进程还活着（20s），所以这里证明的是「不依赖 close」而不是「孙进程先结束」。
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 30_000);
});
