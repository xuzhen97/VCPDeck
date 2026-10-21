// ── Job 日志事件链契约（ADR-0054） ──
//
// jobId 是唯一关联键；Server 记录能自行观察的生命周期事实，Client 只上报
// Server 推不出的内部相位（spawned/exited/local_settled…）。
// 事件不复述 payload、命令、路径或 stdout/stderr 正文：正文仍在 Job result 与
// 输出 spool 的既有路径上。

/** Server 侧事件：由 Server 在自身观察到的生命周期节点写入。 */
export const JOB_LOG_SERVER_EVENTS = [
	"created",
	"dispatched",
	"output_first",
	"cancel_requested",
	"cancel_confirmed",
	"cancel_failed",
	"client_offline",
	"reconciled",
	"frp_confirm",
	"orphaned",
	"settled",
] as const;

/** Client 侧事件：只能由 Client 通过 `job:log` 上报。 */
export const JOB_LOG_CLIENT_EVENTS = [
	"received",
	"spawned",
	"exited",
	"local_settled",
	"cancel_received",
	"kill_failed",
	"drain_timeout",
] as const;

export type JobLogServerEvent = (typeof JOB_LOG_SERVER_EVENTS)[number];
export type JobLogClientEvent = (typeof JOB_LOG_CLIENT_EVENTS)[number];
export type JobLogEventName = JobLogServerEvent | JobLogClientEvent;

/** 事件级别；未指定时按 info 处理。 */
export const JOB_LOG_LEVELS = ["info", "warn", "error"] as const;
export type JobLogLevel = (typeof JOB_LOG_LEVELS)[number];

/** 事件 data 只允许扁平标量，避免把正文或嵌套结构塞进诊断面。 */
export type JobLogDataValue = string | number | boolean;
export type JobLogData = Record<string, JobLogDataValue>;

/** 契约上限：解析器、Server 落库与 Client 上报共用同一组数字。 */
export const JOB_LOG_LIMITS = {
	/** jobId 最大长度（UUID 36，留余量给未来前缀）。 */
	maxJobId: 100,
	/** code 最大长度。 */
	maxCode: 64,
	/** message 最大长度（已脱敏文本）。 */
	maxMessage: 200,
	/** data 最多键数。 */
	maxDataKeys: 8,
	/** data 序列化后的最大字节数。 */
	maxDataBytes: 1024,
	/** 单个字符串型 data 值的最大长度。 */
	maxDataValue: 200,
	/** 每 Job 事件上限（超出时优先裁剪最旧的非 error 事件）。 */
	maxEventsPerJob: 200,
	/** 每 Job 允许的 Client 相位事件上限。 */
	maxClientEventsPerJob: 8,
	/** 每 Client 每分钟允许的相位事件数。 */
	clientEventsPerMinute: 30,
	/** 事件全局保留天数。 */
	retentionDays: 30,
} as const;

/** Client → Server 的相位上报载荷（`job:log`）。 */
export interface JobLogLine {
	jobId: string;
	event: JobLogClientEvent;
	level?: JobLogLevel;
	code?: string;
	message?: string;
	data?: JobLogData;
	/** Client 本地时间，仅用于计算本地耗时；权威时间是 Server 接收时刻。 */
	clientAt?: string;
}

/** 已落库的事件，同时是 REST 读取面 DTO。 */
export interface JobLogEvent {
	/** 全局自增序号，同时是增量拉取游标。 */
	seq: number;
	jobId: string;
	/** Server 接收时刻（ISO 8601）。 */
	at: string;
	source: "server" | "client";
	event: JobLogEventName;
	level: JobLogLevel;
	code: string | null;
	message: string | null;
	data: JobLogData | null;
}

/** `GET /api/jobs/:jobId/logs` 的响应。 */
export interface JobLogPage {
	jobId: string;
	events: JobLogEvent[];
	/** 本页最后一条的 seq；没有事件时回显入参 since（默认 0）。 */
	nextSeq: number;
}

/** Job 日志契约校验失败；调用方应丢弃载荷而不是猜测修正。 */
export class JobLogProtocolError extends Error {
	readonly code = "JOB_LOG_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "JobLogProtocolError";
	}
}

const JOB_LOG_LINE_KEYS = new Set([
	"jobId",
	"event",
	"level",
	"code",
	"message",
	"data",
	"clientAt",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireShortString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (typeof value !== "string" || value === "") {
		throw new JobLogProtocolError(`${field} must be a non-empty string`);
	}
	if (value.length > maxLength) {
		throw new JobLogProtocolError(`${field} exceeds ${maxLength} characters`);
	}
	return value;
}

function optionalShortString(
	value: unknown,
	field: string,
	maxLength: number,
): string | undefined {
	if (value === undefined) return undefined;
	return requireShortString(value, field, maxLength);
}

function parseData(value: unknown): JobLogData | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) {
		throw new JobLogProtocolError("data must be a flat object");
	}
	const entries = Object.entries(value);
	if (entries.length > JOB_LOG_LIMITS.maxDataKeys) {
		throw new JobLogProtocolError(
			`data exceeds ${JOB_LOG_LIMITS.maxDataKeys} keys`,
		);
	}
	const data: JobLogData = {};
	for (const [key, item] of entries) {
		if (key === "" || key.length > 64) {
			throw new JobLogProtocolError("data keys must be 1-64 characters");
		}
		if (
			typeof item === "string" ||
			typeof item === "number" ||
			typeof item === "boolean"
		) {
			if (typeof item === "string" && item.length > JOB_LOG_LIMITS.maxDataValue) {
				throw new JobLogProtocolError(
					`data.${key} exceeds ${JOB_LOG_LIMITS.maxDataValue} characters`,
				);
			}
			if (typeof item === "number" && !Number.isFinite(item)) {
				throw new JobLogProtocolError(`data.${key} must be finite`);
			}
			data[key] = item;
			continue;
		}
		throw new JobLogProtocolError(
			`data.${key} must be a string, number or boolean`,
		);
	}
	if (JSON.stringify(data).length > JOB_LOG_LIMITS.maxDataBytes) {
		throw new JobLogProtocolError(
			`data exceeds ${JOB_LOG_LIMITS.maxDataBytes} bytes`,
		);
	}
	return data;
}

/**
 * 严格解析 Client 上报的 `job:log` 载荷。
 *
 * 只接受 Client 方向的事件与已知字段：未知事件、未知字段、嵌套 data、
 * 超长文本一律抛 {@link JobLogProtocolError}，由调用方丢弃。
 */
export function parseJobLogLine(input: unknown): JobLogLine {
	if (!isPlainRecord(input)) {
		throw new JobLogProtocolError("job log line must be an object");
	}
	for (const key of Object.keys(input)) {
		if (!JOB_LOG_LINE_KEYS.has(key)) {
			throw new JobLogProtocolError(`unknown field: ${key}`);
		}
	}

	const jobId = requireShortString(
		input.jobId,
		"jobId",
		JOB_LOG_LIMITS.maxJobId,
	);
	const event = input.event;
	if (
		typeof event !== "string" ||
		!(JOB_LOG_CLIENT_EVENTS as readonly string[]).includes(event)
	) {
		throw new JobLogProtocolError("event is not a client job log event");
	}

	let level: JobLogLevel | undefined;
	if (input.level !== undefined) {
		if (
			typeof input.level !== "string" ||
			!(JOB_LOG_LEVELS as readonly string[]).includes(input.level)
		) {
			throw new JobLogProtocolError("level must be info, warn or error");
		}
		level = input.level as JobLogLevel;
	}

	const code = optionalShortString(input.code, "code", JOB_LOG_LIMITS.maxCode);
	const message = optionalShortString(
		input.message,
		"message",
		JOB_LOG_LIMITS.maxMessage,
	);
	const data = parseData(input.data);

	let clientAt: string | undefined;
	if (input.clientAt !== undefined) {
		clientAt = requireShortString(input.clientAt, "clientAt", 64);
		if (Number.isNaN(Date.parse(clientAt))) {
			throw new JobLogProtocolError("clientAt must be an ISO 8601 timestamp");
		}
	}

	const line: JobLogLine = {
		jobId,
		event: event as JobLogClientEvent,
	};
	if (level !== undefined) line.level = level;
	if (code !== undefined) line.code = code;
	if (message !== undefined) line.message = message;
	if (data !== undefined) line.data = data;
	if (clientAt !== undefined) line.clientAt = clientAt;
	return line;
}
