import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
	ActorContext,
	PiAgentState,
	PiStateReport,
} from "@vcpdeck/shared";
import { JobStatus } from "@vcpdeck/shared";

/** 项目锁：key = `${clientId}:${projectKey}`，只存内存，不持久化 */
interface ProjectLock {
	clientId: string;
	projectKey: string;
	jobId: string;
}

/** settlement 30 秒可取消 grace */
const SETTLEMENT_GRACE_MS = 30_000;

function piError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function safeJsonParse<T>(raw: string, fallback: T): T {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export interface CreateRunInput {
	clientId: string;
	sessionId: string;
	projectKey: string;
	imageCount?: number;
}

/**
 * Pi 运行的 sanitized Job 编排与 Owner 状态机。
 * Job payload/result 只含安全元数据；prompt/路径/附件 URL 永不持久化。
 */
@Injectable()
export class PiRunService {
	private readonly locks = new Map<string, ProjectLock>();
	private readonly settlementTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
	) {}

	private lockKey(clientId: string, projectKey: string): string {
		return `${clientId}:${projectKey}`;
	}

	async createRun(
		actor: ActorContext,
		input: CreateRunInput,
	): Promise<{ jobId: string; runId: string }> {
		const key = this.lockKey(input.clientId, input.projectKey);
		if (this.locks.has(key)) {
			throw piError("PI_PROJECT_BUSY", "Project has an active turn");
		}
		const jobId = randomUUID();
		await this.prisma.job.create({
			data: {
				id: jobId,
				clientId: input.clientId,
				type: "agent.run",
				status: JobStatus.PENDING,
				payload: JSON.stringify({
					mode: "interactive",
					operation: "prompt",
					sessionId: input.sessionId,
					hasImages: (input.imageCount ?? 0) > 0,
					imageCount: input.imageCount ?? 0,
				}),
				createdByIdentityId: actor.identityId,
				createdByName: actor.displayName,
				createdVia: actor.source,
			},
		});
		this.locks.set(key, {
			clientId: input.clientId,
			projectKey: input.projectKey,
			jobId,
		});
		return { jobId, runId: jobId };
	}

	async accept(jobId: string): Promise<void> {
		await this.update(jobId, { status: JobStatus.RUNNING, startedAt: new Date() });
	}

	async waitForInput(jobId: string): Promise<void> {
		await this.update(jobId, { status: JobStatus.WAITING_INPUT });
	}

	async resume(jobId: string): Promise<void> {
		await this.update(jobId, { status: JobStatus.RUNNING });
	}

	async settle(jobId: string, state: PiAgentState): Promise<void> {
		this.cancelSettlement(jobId);
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		const payload = safeJsonParse(job.payload, {}) as { sessionId?: string };
		await this.update(jobId, {
			status: JobStatus.DONE,
			result: JSON.stringify({
				sessionId: payload.sessionId ?? "",
				runId: jobId,
				stopReason: "settled",
				...(state.model ? { model: { provider: state.model.provider, modelId: state.model.modelId } } : {}),
			}),
		});
		this.releaseLock(jobId);
	}

	async fail(jobId: string, code: string, message: string): Promise<void> {
		await this.update(jobId, {
			status: JobStatus.ERROR,
			errorCode: code,
			errorMessage: message,
		});
		this.releaseLock(jobId);
	}

	async cancel(jobId: string): Promise<void> {
		await this.update(jobId, { status: JobStatus.CANCELLED });
		this.releaseLock(jobId);
	}

	/** Client socket 断线：活动回合标记 disconnected（锁保留，重连后 reconcile） */
	async markDisconnected(clientId: string): Promise<void> {
		await this.prisma.job.updateMany({
			where: { clientId, status: { in: [JobStatus.RUNNING, JobStatus.WAITING_INPUT] } },
			data: { status: JobStatus.DISCONNECTED },
		});
	}

	/** 根据 Client 上报的 PI_STATE 恢复活动/终态 */
	async reconcileState(clientId: string, report: PiStateReport): Promise<void> {
		for (const run of report.runs) {
			const job = await this.prisma.job.findUnique({ where: { id: run.jobId } });
			if (!job || job.clientId !== clientId) continue;
			if (run.projectKey) {
				this.locks.set(this.lockKey(clientId, run.projectKey), {
					clientId,
					projectKey: run.projectKey,
					jobId: run.jobId,
				});
			}
			if (run.status === "running" || run.status === "waiting_input") {
				await this.update(run.jobId, { status: run.status });
			} else if (run.status === "done" || run.status === "error") {
				if (job.status !== JobStatus.DONE && job.status !== JobStatus.ERROR) {
					await this.update(run.jobId, {
						status: run.status === "done" ? JobStatus.DONE : JobStatus.ERROR,
					});
				}
				this.releaseLock(run.jobId);
			}
		}
	}

	/**
	 * 安排 30 秒可取消的 settlement：首次 idle+queue empty 只 schedule；
	 * 同 run 任一新 activity 调用 cancelSettlement 取消；grace 到期执行 onSettle。
	 */
	async scheduleSettlement(
		jobId: string,
		onSettle: () => Promise<void>,
	): Promise<void> {
		this.cancelSettlement(jobId);
		const timer = setTimeout(() => {
			this.settlementTimers.delete(jobId);
			void onSettle().catch(() => {});
		}, SETTLEMENT_GRACE_MS);
		this.settlementTimers.set(jobId, timer);
	}

	/** 取消待执行的 settlement（grace 内出现新 activity 时调用） */
	cancelSettlement(jobId: string): void {
		const timer = this.settlementTimers.get(jobId);
		if (timer) {
			clearTimeout(timer);
			this.settlementTimers.delete(jobId);
		}
	}

	/** 活动回合控制权校验：Owner + active status */
	async assertOwner(jobId: string, identityId: string): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		if (job.createdByIdentityId !== identityId) {
			throw piError("PI_CONTROL_FORBIDDEN", "Only the run owner can control this turn");
		}
		if (![JobStatus.RUNNING, JobStatus.WAITING_INPUT, JobStatus.DISCONNECTED].includes(job.status as JobStatus)) {
			throw piError("PI_CONTROL_FORBIDDEN", "Run is not active");
		}
	}

	/** 空闲 mutation 短锁：活动回合存在时拒绝 */
	async assertIdleMutation(clientId: string, projectKey: string): Promise<void> {
		if (this.locks.has(this.lockKey(clientId, projectKey))) {
			throw piError("PI_PROJECT_BUSY", "Project has an active turn");
		}
	}

	/** 供 Task 14 集成测试扫描数据库泄漏 */
	async listAllRuns(): Promise<Array<Record<string, unknown>>> {
		return this.prisma.job.findMany({ where: { type: "agent.run" } });
	}

	/** 列出某 Client 的活动回合（running/reattach 用） */
	async listActiveByClient(
		clientId: string,
	): Promise<Array<{ jobId: string; runId: string; sessionId: string; status: string }>> {
		const jobs = await this.prisma.job.findMany({
			where: {
				clientId,
				type: "agent.run",
				status: {
					in: [JobStatus.RUNNING, JobStatus.WAITING_INPUT, JobStatus.DISCONNECTED],
				},
			},
		});
		return jobs.map((j) => {
			const payload = safeJsonParse(j.payload, {}) as { sessionId?: string };
			return {
				jobId: j.id,
				runId: j.id,
				sessionId: payload.sessionId ?? "",
				status: j.status,
			};
		});
	}

	private async update(
		jobId: string,
		data: {
			status?: string;
			result?: string;
			errorCode?: string;
			errorMessage?: string;
			startedAt?: Date;
		},
	): Promise<void> {
		const existing = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!existing) throw piError("PI_SESSION_NOT_FOUND", "Run not found");
		const updateData: Record<string, unknown> = { ...data };
		// settle 幂等：终态后不再改动 finishedAt
		if (
			data.status === JobStatus.DONE &&
			existing.finishedAt != null
		) {
			delete updateData.finishedAt;
		} else if (
			data.status === JobStatus.DONE ||
			data.status === JobStatus.ERROR ||
			data.status === JobStatus.CANCELLED
		) {
			updateData.finishedAt = new Date();
		}
		await this.prisma.job.update({ where: { id: jobId }, data: updateData });
	}

	private releaseLock(jobId: string): void {
		for (const [key, lock] of this.locks) {
			if (lock.jobId === jobId) {
				this.locks.delete(key);
				return;
			}
		}
	}
}
