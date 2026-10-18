import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, JOB_LOG_LIMITS } from "@vcpdeck/shared";
import { emitJobLog } from "./job-log.js";

describe("emitJobLog", () => {
	it("已连接时上报相位，未连接时只写本地日志", () => {
		const emit = vi.fn();
		const online = { connected: true, emit } as unknown as Socket;

		emitJobLog(online, "job-1", "spawned", {
			data: { pid: 7, mode: "command" },
		});

		expect(emit).toHaveBeenCalledWith(
			Events.JOB_LOG,
			expect.objectContaining({
				jobId: "job-1",
				event: "spawned",
				data: { pid: 7, mode: "command" },
				clientAt: expect.any(String),
			}),
		);

		const offlineEmit = vi.fn();
		const offline = {
			connected: false,
			emit: offlineEmit,
		} as unknown as Socket;
		emitJobLog(offline, "job-2", "exited");
		expect(offlineEmit).not.toHaveBeenCalled();
	});

	it("超长 message 截断到契约上限", () => {
		const emit = vi.fn();
		const socket = { connected: true, emit } as unknown as Socket;

		emitJobLog(socket, "job-3", "kill_failed", {
			message: "x".repeat(JOB_LOG_LIMITS.maxMessage + 100),
		});

		const line = emit.mock.calls[0][1] as { message: string };
		expect(line.message.length).toBe(JOB_LOG_LIMITS.maxMessage);
	});

	it("上报抛错不影响调用方", () => {
		const socket = {
			connected: true,
			emit: vi.fn(() => {
				throw new Error("socket closed");
			}),
		} as unknown as Socket;

		expect(() =>
			emitJobLog(socket, "job-4", "local_settled", {
				data: { reason: "done", drainTimedOut: false },
			}),
		).not.toThrow();
	});
});
