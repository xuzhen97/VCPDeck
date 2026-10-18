import type { Socket } from "socket.io-client";
import {
	Events,
	JOB_LOG_LIMITS,
	type JobLogClientEvent,
	type JobLogData,
	type JobLogLevel,
	type JobLogLine,
} from "@vcpdeck/shared";

/** 相位上报选项：只允许与 Job 生命周期有关的小字段。 */
export interface JobLogPhaseOptions {
	level?: JobLogLevel;
	code?: string;
	message?: string;
	data?: JobLogData;
}

/**
 * Client 侧 Job 日志：写一行本地 JSONL，并在连接可用时上报相位（ADR-0054）。
 *
 * 相位通道只承载"进程起了/退了/结算了"这类事实，**不承载 stdout/stderr 正文**；
 * 任何失败都静默，绝不影响 Job 执行。
 */
export function emitJobLog(
	socket: Socket,
	jobId: string,
	event: JobLogClientEvent,
	options: JobLogPhaseOptions = {},
): void {
	const message = options.message
		? options.message.slice(0, JOB_LOG_LIMITS.maxMessage)
		: undefined;
	const line: JobLogLine = {
		jobId,
		event,
		...(options.level ? { level: options.level } : {}),
		...(options.code ? { code: options.code } : {}),
		...(message ? { message } : {}),
		...(options.data ? { data: options.data } : {}),
		clientAt: new Date().toISOString(),
	};

	writeClientJobLogLine(line);

	if (!socket.connected) return;
	try {
		socket.emit(Events.JOB_LOG, line);
	} catch {
		// 上报失败不重试：Server 侧重连对账与 Job 终态仍会收敛
	}
}

/** 本地 JSONL 行：与 Server 侧同一行形状，便于在目标机日志里按 jobId 检索。 */
function writeClientJobLogLine(line: JobLogLine): void {
	try {
		process.stdout.write(
			`${JSON.stringify({
				ts: new Date().toISOString(),
				level: line.level ?? "info",
				scope: "job",
				source: "client",
				jobId: line.jobId,
				event: line.event,
				...(line.code ? { code: line.code } : {}),
				...(line.message ? { message: line.message } : {}),
				...(line.data ? { data: line.data } : {}),
			})}\n`,
		);
	} catch {
		// 本地日志失败忽略
	}
}
