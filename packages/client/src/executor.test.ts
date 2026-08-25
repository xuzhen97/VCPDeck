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
});
