import {
	Inject,
	Injectable,
	type OnModuleDestroy,
	type OnModuleInit,
} from "@nestjs/common";
import {
	JOB_LOG_LIMITS,
	type JobLogData,
	type JobLogEvent,
	type JobLogEventName,
	type JobLogLevel,
	type JobLogPage,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { writeLogLine } from "../log/log-line.js";

/** 事件来源：Server 自行观察的事实 / Client 上报的相位。 */
export type JobLogSource = "server" | "client";

/** 一条待写入的 Job 日志事件。 */
export interface JobLogRecordInput {
	jobId: string;
	event: JobLogEventName;
	source: JobLogSource;
	level?: JobLogLevel;
	code?: string;
	message?: string;
	data?: JobLogData | null;
	/** 服务器接收时刻；缺省 now。 */
	at?: Date;
}

/** 列出事件时的过滤条件。 */
export interface JobLogListOptions {
	/** 增量游标：只返回 id 大于它的行。 */
	since?: number;
	limit?: number;
	level?: JobLogLevel;
}

/** 全局保留清理间隔（6 小时）。 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 每个 Client 的相位事件速率窗口。 */
const CLIENT_RATE_WINDOW_MS = 60_000;

function safeParseData(raw: string | null): JobLogData | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as JobLogData;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Job 诊断事件链（ADR-0054）。
 *
 * `record()` 是**唯一双写点**：同一行同时进入 stdout（JSONL，带 jobId）与
 * `JobLogEvent` 表，使"人可 grep 的运行日志"和"机器可查的事件链"不会漂移。
 * 写入 best-effort：数据库失败只落 stdout 警告，绝不抛出给业务调用方。
 */
@Injectable()
export class JobLogService implements OnModuleInit, OnModuleDestroy {
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	/** clientId → 速率窗口；只随在线 Client 数量增长。 */
	private readonly clientWindows = new Map<
		string,
		{ windowStart: number; count: number }
	>();

	constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

	onModuleInit(): void {
		this.cleanupTimer = setInterval(() => {
			void this.pruneExpired();
		}, CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
	}

	onModuleDestroy(): void {
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		this.cleanupTimer = null;
	}

	/** 写入一条事件（stdout + DB），失败不抛出。 */
	async record(input: JobLogRecordInput): Promise<void> {
		const at = input.at ?? new Date();
		const level: JobLogLevel = input.level ?? "info";
		const data = input.data ?? null;

		writeLogLine({
			level,
			scope: "job",
			jobId: input.jobId,
			event: input.event,
			source: input.source,
			...(input.code ? { code: input.code } : {}),
			...(input.message ? { message: input.message } : {}),
			...(data ? { data } : {}),
		});

		try {
			await this.prisma.jobLogEvent.create({
				data: {
					jobId: input.jobId,
					at,
					source: input.source,
					event: input.event,
					level,
					code: input.code ?? null,
					message: input.message ?? null,
					data: data ? JSON.stringify(data) : null,
				},
			});
			await this.pruneJob(input.jobId);
		} catch (error) {
			// 日志落库失败不能影响 Job 执行；只再记一行 stdout 便于发现。
			writeLogLine({
				level: "warn",
				scope: "job-log",
				msg: "job log event not persisted",
				jobId: input.jobId,
				event: input.event,
				error: (error as { message?: string })?.message ?? "unknown",
			});
		}
	}

	/** 按 seq 升序增量读取；返回本页最后一条的 seq 作为下一次游标。 */
	async list(
		jobId: string,
		options: JobLogListOptions = {},
	): Promise<JobLogPage> {
		const limit = Math.min(
			JOB_LOG_LIMITS.maxEventsPerJob,
			Math.max(1, options.limit ?? JOB_LOG_LIMITS.maxEventsPerJob),
		);
		const since = Number.isInteger(options.since) ? (options.since as number) : 0;
		const where: Record<string, unknown> = { jobId };
		if (since > 0) where.id = { gt: since };
		if (options.level) where.level = options.level;

		const rows = await this.prisma.jobLogEvent.findMany({
			where,
			orderBy: { id: "asc" },
			take: limit,
		});

		const events: JobLogEvent[] = rows.map((row) => ({
			seq: row.id,
			jobId: row.jobId,
			at: row.at.toISOString(),
			source: row.source === "client" ? "client" : "server",
			event: row.event as JobLogEventName,
			level: (row.level === "warn" || row.level === "error"
				? row.level
				: "info") as JobLogLevel,
			code: row.code,
			message: row.message,
			data: safeParseData(row.data),
		}));

		const last = events.length > 0 ? events[events.length - 1] : undefined;
		return {
			jobId,
			events,
			nextSeq: last ? last.seq : since,
		};
	}

	/**
	 * Client 相位上报准入：每 Job ≤8 条、每 Client ≤30 条/分钟。
	 *
	 * 每 Job 计数以库为准（重启安全）；速率窗口驻留内存（进程重启重置可接受）。
	 */
	async allowClientEvent(clientId: string, jobId: string): Promise<boolean> {
		const recorded = await this.prisma.jobLogEvent.count({
			where: { jobId, source: "client" },
		});
		if (recorded >= JOB_LOG_LIMITS.maxClientEventsPerJob) return false;

		const now = Date.now();
		const window = this.clientWindows.get(clientId);
		if (!window || now - window.windowStart >= CLIENT_RATE_WINDOW_MS) {
			this.clientWindows.set(clientId, { windowStart: now, count: 1 });
			return true;
		}
		if (window.count >= JOB_LOG_LIMITS.clientEventsPerMinute) return false;
		window.count += 1;
		return true;
	}

	/** 清理超过保留期的事件；返回删除行数。 */
	async pruneExpired(now = new Date()): Promise<number> {
		const cutoff = new Date(
			now.getTime() - JOB_LOG_LIMITS.retentionDays * 24 * 60 * 60 * 1000,
		);
		try {
			const result = await this.prisma.jobLogEvent.deleteMany({
				where: { at: { lt: cutoff } },
			});
			if (result.count > 0) {
				writeLogLine({
					level: "info",
					scope: "job-log",
					msg: "expired job log events pruned",
					deleted: result.count,
				});
			}
			return result.count;
		} catch (error) {
			writeLogLine({
				level: "warn",
				scope: "job-log",
				msg: "job log retention cleanup failed",
				error: (error as { message?: string })?.message ?? "unknown",
			});
			return 0;
		}
	}

	/** 单 Job 上限裁剪：优先删除最旧的非 error 事件，error 取证最后才动。 */
	private async pruneJob(jobId: string): Promise<void> {
		const total = await this.prisma.jobLogEvent.count({ where: { jobId } });
		if (total <= JOB_LOG_LIMITS.maxEventsPerJob) return;
		let overflow = total - JOB_LOG_LIMITS.maxEventsPerJob;

		const stale = await this.prisma.jobLogEvent.findMany({
			where: { jobId, level: { not: "error" } },
			orderBy: { id: "asc" },
			take: overflow,
			select: { id: true },
		});
		if (stale.length > 0) {
			await this.prisma.jobLogEvent.deleteMany({
				where: { id: { in: stale.map((row) => row.id) } },
			});
			overflow -= stale.length;
		}
		if (overflow <= 0) return;

		// 全是 error 事件（或删除后仍超限）：只能从最旧的删起。
		const oldest = await this.prisma.jobLogEvent.findMany({
			where: { jobId },
			orderBy: { id: "asc" },
			take: overflow,
			select: { id: true },
		});
		if (oldest.length > 0) {
			await this.prisma.jobLogEvent.deleteMany({
				where: { id: { in: oldest.map((row) => row.id) } },
			});
		}
	}
}
