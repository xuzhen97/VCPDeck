import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { JobScheduler } from "./job.scheduler.js";
import { JobStatus } from "@vcpdeck/shared";
import type {
  JobCreateResult,
  DispatchPayload,
  StatusReport,
  JobInfo,
} from "@vcpdeck/shared";
import { randomUUID } from "node:crypto";

@Injectable()
export class JobService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
  ) {}

  async create(
    clientId: string,
    command: string,
    timeout?: number,
  ): Promise<{ result: JobCreateResult; dispatch: DispatchPayload | null }> {
    const jobId = randomUUID();
    await this.prisma.client.upsert({
      where: { id: clientId },
      update: {},
      create: {
        id: clientId,
        hostname: "",
        os: "",
        cpuModel: "",
        totalMemMB: 0,
        totalDiskMB: 0,
        clientVersion: "",
        capabilities: "[]",
      },
    });
    await this.prisma.job.create({
      data: {
        id: jobId,
        clientId,
        command,
        status: "pending",
        timeout: timeout ?? null,
      },
    });

    const dispatch = await this.scheduler.tryDispatch(clientId);

    return {
      result: {
        jobId,
        status: dispatch ? JobStatus.RUNNING : JobStatus.PENDING,
      },
      dispatch,
    };
  }

  async appendOutputRaw(jobId: string, text: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.prisma.job.update({
      where: { id: jobId },
      data: { output: job.output + text },
    });
  }

  async markDone(
    jobId: string,
    exitCode: number,
  ): Promise<DispatchPayload | null> {
    const job = await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: exitCode === 0 ? "done" : "error",
        exitCode,
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
      where: { clientId, status: "running" },
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

      if (r.status === "running") {
        if (job.status === "disconnected" || job.status === "running") {
          await this.prisma.job.update({
            where: { id: r.jobId },
            data: { status: "running" },
          });
        }
      } else {
        const newStatus = r.status === "done" ? "done" : "error";
        await this.prisma.job.update({
          where: { id: r.jobId },
          data: {
            status: newStatus,
            exitCode: r.exitCode ?? 1,
            finishedAt: new Date(),
          },
        });
        const d = await this.scheduler.onFinished(clientId);
        if (d) dispatches.push(d);
      }
    }

    return dispatches;
  }

  async cancel(jobId: string): Promise<{
    cancelled: boolean;
    needsDispatch: boolean;
    clientId?: string;
  }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error(`Job "${jobId}" not found`);

    if (job.status === "pending") {
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
    return jobs.map((j) => ({
      jobId: j.id,
      clientId: j.clientId,
      command: j.command,
      status: j.status as JobStatus,
      exitCode: j.exitCode,
      createdAt: j.createdAt.toISOString(),
      startedAt: j.startedAt?.toISOString() ?? null,
      finishedAt: j.finishedAt?.toISOString() ?? null,
    }));
  }
}
