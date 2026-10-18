import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DispatchPayload } from "@vcpdeck/shared";
import { ServerDrain } from "./server-drain.js";
import { JobLogService } from "./job-log.service.js";

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const MAX_CONCURRENT_JOBS = 3;

@Injectable()
export class JobScheduler {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // 优雅停机闸门：JobModule 提供；测试可不传
    @Optional() @Inject(ServerDrain) private readonly drain?: ServerDrain,
    // Job 诊断事件链（ADR-0054）；测试可省略
    @Optional() @Inject(JobLogService) private readonly jobLog?: JobLogService,
  ) {}

  async tryDispatch(clientId: string): Promise<DispatchPayload | null> {
    if (this.drain?.isDraining()) return null;
    const runningCount = await this.prisma.job.count({
      where: {
        clientId,
        status: "running",
        type: { notIn: ["agent.run", "agent.session"] },
      },
    });
    if (runningCount >= MAX_CONCURRENT_JOBS) return null;

    const pending = await this.prisma.job.findFirst({
      where: {
        clientId,
        status: "pending",
        type: { notIn: ["agent.run", "agent.session"] },
      },
      orderBy: { createdAt: "asc" },
    });
    if (!pending) return null;

    const startedAt = new Date();
    await this.prisma.job.update({
      where: { id: pending.id },
      data: { status: "running", startedAt },
    });

    // 纯附加写入：不改签名、不改返回、不影响派发结果。
    await this.jobLog?.record({
      jobId: pending.id,
      event: "dispatched",
      source: "server",
      data: {
        queueWaitMs: Math.max(0, startedAt.getTime() - pending.createdAt.getTime()),
        runningCount,
      },
    });

    return {
      jobId: pending.id,
      clientId: pending.clientId,
      type: pending.type,
      payload: safeJsonParse(pending.payload, {}),
      timeout: pending.timeout ?? undefined,
    };
  }

  async onFinished(clientId: string): Promise<DispatchPayload | null> {
    return this.tryDispatch(clientId);
  }
}
