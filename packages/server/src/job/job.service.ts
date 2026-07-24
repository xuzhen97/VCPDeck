import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobStatus } from "@vcpdeck/shared";
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
  ActorContext,
} from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

@Injectable()
export class JobService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
  ) {}

  async create(
    params: {
      clientId: string;
      type: string;
      payload: Record<string, unknown>;
      timeout?: number;
    },
    actor: ActorContext,
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
    const client = await this.prisma.client.findUnique({
      where: { id: params.clientId },
    });
    if (!client) {
      throw new Error(`Client "${params.clientId}" not found — register the client first`);
    }
    if (!client.online) {
      throw new Error(`Client "${params.clientId}" is offline`);
    }

    const jobId = randomUUID();
    await this.prisma.job.create({
      data: {
        id: jobId,
        clientId: params.clientId,
        type: params.type,
        status: "pending",
        payload: JSON.stringify(params.payload),
        timeout: params.timeout ?? null,
        createdByIdentityId: actor.identityId,
        createdByName: actor.displayName,
        createdVia: actor.source,
      },
    });

    const dispatch = await this.scheduler.tryDispatch(params.clientId);

    return {
      result: {
        jobId,
        status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING,
        type: params.type,
      },
      dispatch,
    };
  }

  async appendOutputRaw(jobId: string, _text: string) {
    // ponytail: stdout/stderr 暂不持久化，仅实时转发。后续加 output spool 时在此实现。
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
  }

  async markDone(
    jobId: string,
    type: string,
    result: Record<string, unknown>,
  ): Promise<DispatchPayload | null> {
    const effectiveStatus =
      type === "exec" && (result as any).exitCode !== 0 ? "error" : "done";

    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: effectiveStatus,
        result: JSON.stringify(result),
        finishedAt: new Date(),
      },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markCancelled(jobId: string): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: { status: "cancelled", finishedAt: new Date() },
    });
    return this.scheduler.onFinished(job.clientId);
  }

  async markDisconnected(clientId: string) {
    await this.prisma.job.updateMany({
      where: { clientId, status: { in: ["running", "waiting_input"] } },
      data: { status: "disconnected" },
    });
  }

  async reconcileOnReconnect(
    clientId: string,
    report: StatusReport,
  ): Promise<DispatchPayload[]> {
    const dispatches: DispatchPayload[] = [];

    for (const r of report.jobs) {
      const job = await this.prisma.job.findUnique({
        where: { id: r.jobId },
      });
      if (!job || job.clientId !== clientId) continue;

      if (r.status === "running" || r.status === "waiting_input") {
        if (
          job.status === "disconnected" ||
          job.status === "running" ||
          job.status === "waiting_input"
        ) {
          await this.prisma.job.update({
            where: { id: r.jobId },
            data: { status: r.status },
          });
        }
      } else {
        const newStatus = r.status === "done" ? "done" : "error";
        await this.prisma.job.update({
          where: { id: r.jobId },
          data: {
            status: newStatus,
            result: JSON.stringify({ exitCode: r.exitCode ?? 1 }),
            finishedAt: new Date(),
          },
        });
        const d = await this.scheduler.onFinished(clientId);
        if (d) dispatches.push(d);
      }
    }

    return dispatches;
  }

  async cancel(jobId: string, _actor: ActorContext): Promise<{ // ponytail: actor 预留，后续 cancel 时记录到 JobEvent
    cancelled: boolean;
    needsDispatch: boolean;
    clientId?: string;
  }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job "${jobId}" not found`);

    if (job.status === "pending" || job.status === "waiting_input") {
      await this.prisma.job.update({
        where: { id: jobId },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      return { cancelled: true, needsDispatch: false };
    }

    if (job.status === "running" || job.status === "disconnected") {
      return { cancelled: false, needsDispatch: true, clientId: job.clientId };
    }

    throw new Error(`Cannot cancel job in status "${job.status}"`);
  }

  async list(): Promise<JobInfo[]> {
    const jobs = await this.prisma.job.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return jobs.map(toJobInfo);
  }

  async findById(jobId: string): Promise<JobInfo | null> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
    });
    if (!job) return null;
    return toJobInfo(job);
  }
}

function toJobInfo(j: {
  id: string;
  clientId: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdByIdentityId: string | null;
  createdByName: string | null;
  createdVia: string | null;
}): JobInfo {
  return {
    jobId: j.id,
    clientId: j.clientId,
    type: j.type,
    status: j.status as JobStatus,
    payload: safeJsonParse(j.payload, {}),
    result: j.result ? safeJsonParse(j.result, null) : null,
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    createdByIdentityId: j.createdByIdentityId ?? null,
    createdByName: j.createdByName ?? null,
    createdVia: j.createdVia ?? null,
  };
}
