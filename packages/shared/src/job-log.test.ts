import { describe, expect, it } from "vitest";
import {
	JOB_LOG_CLIENT_EVENTS,
	JOB_LOG_LIMITS,
	JOB_LOG_SERVER_EVENTS,
	JobLogProtocolError,
	parseJobLogLine,
} from "./index.js";

describe("Job 日志契约（ADR-0054）", () => {
	it("事件枚举封闭且方向分离", () => {
		expect(JOB_LOG_SERVER_EVENTS).toEqual([
			"created",
			"dispatched",
			"output_first",
			"cancel_requested",
			"cancel_confirmed",
			"cancel_failed",
			"client_offline",
			"reconciled",
			"orphaned",
			"settled",
		]);
		expect(JOB_LOG_CLIENT_EVENTS).toEqual([
			"received",
			"spawned",
			"exited",
			"local_settled",
			"cancel_received",
			"kill_failed",
			"drain_timeout",
		]);
	});

	it("接受最小载荷并补齐可选字段为空", () => {
		const line = parseJobLogLine({ jobId: "job-1", event: "received" });
		expect(line).toEqual({ jobId: "job-1", event: "received" });
		expect(line.data).toBeUndefined();
		expect(line.level).toBeUndefined();
	});

	it("保留完整相位载荷", () => {
		const line = parseJobLogLine({
			jobId: "job-1",
			event: "local_settled",
			level: "warn",
			code: "EXEC_TIMEOUT",
			message: "Execution timed out",
			data: { reason: "timeout", drainTimedOut: true, spawnToExitMs: 1200 },
			clientAt: "2026-10-17T14:30:00.000Z",
		});
		expect(line).toEqual({
			jobId: "job-1",
			event: "local_settled",
			level: "warn",
			code: "EXEC_TIMEOUT",
			message: "Execution timed out",
			data: { reason: "timeout", drainTimedOut: true, spawnToExitMs: 1200 },
			clientAt: "2026-10-17T14:30:00.000Z",
		});
	});

	it("拒绝 Server 侧事件：相位通道只接受 Client 事实", () => {
		expect(() => parseJobLogLine({ jobId: "job-1", event: "settled" })).toThrow(
			JobLogProtocolError,
		);
	});

	it("拒绝未知事件", () => {
		expect(() =>
			parseJobLogLine({ jobId: "job-1", event: "exploded" }),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝未知字段（不宽松丢弃）", () => {
		expect(() =>
			parseJobLogLine({ jobId: "job-1", event: "received", command: "rm -rf /" }),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝非对象载荷", () => {
		for (const value of [null, undefined, "x", 1, ["job"]]) {
			expect(() => parseJobLogLine(value)).toThrow(JobLogProtocolError);
		}
	});

	it("拒绝非法 level", () => {
		expect(() =>
			parseJobLogLine({ jobId: "job-1", event: "received", level: "debug" }),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝超长 message", () => {
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				message: "x".repeat(JOB_LOG_LIMITS.maxMessage + 1),
			}),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝嵌套 data 与非标量值", () => {
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				data: { nested: { a: 1 } as unknown as string },
			}),
		).toThrow(JobLogProtocolError);
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				data: { list: [1, 2] as unknown as number },
			}),
		).toThrow(JobLogProtocolError);
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				data: { infinite: Number.POSITIVE_INFINITY },
			}),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝超过键数上限的 data", () => {
		const data: Record<string, number> = {};
		for (let i = 0; i <= JOB_LOG_LIMITS.maxDataKeys; i += 1) {
			data[`k${i}`] = i;
		}
		expect(() =>
			parseJobLogLine({ jobId: "job-1", event: "received", data }),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝超过长度上限的 data 值", () => {
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				data: { value: "x".repeat(JOB_LOG_LIMITS.maxDataValue + 1) },
			}),
		).toThrow(JobLogProtocolError);
	});

	it("拒绝非法 clientAt", () => {
		expect(() =>
			parseJobLogLine({
				jobId: "job-1",
				event: "received",
				clientAt: "昨天",
			}),
		).toThrow(JobLogProtocolError);
	});
});
