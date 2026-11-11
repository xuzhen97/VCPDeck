import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { DispatchPayload } from "@vcpdeck/shared";
import { ServerDrain } from "./server-drain.js";
import { JobLogService } from "./job-log.service.js";
import { TailnetKeyService } from "../tailnet/tailnet-key.service.js";

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
    // Tailnet 凭据结算（ADR-0062）；测试可省略
    @Optional() @Inject(TailnetKeyService) private readonly tailnetKeys?: TailnetKeyService,
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

    // Tailnet 任务在派发前再次校验在线性与能力：排队期间机器可能已离线/降级。
    if (pending.type === "tailnet.manage") {
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
        select: { online: true, capabilities: true },
      });
      const caps = client
        ? safeJsonParse<string[]>(client.capabilities, [])
        : [];
      if (!client || !client.online || !caps.includes("tailnet.manage")) {
        await this.finalizeUndeliverableTailnet(pending.id);
        return this.tryDispatch(clientId);
      }
    }

    const startedAt = new Date();
    // 条件领取：只有把 pending 真正改成 running 的调度器可以派发，避免重复下发。
    const claimed = await this.prisma.job.updateMany({
      where: { id: pending.id, status: "pending" },
      data: { status: "running", startedAt },
    });
    if (claimed.count === 0) return null;

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

  /** 队列中的 Tailnet 任务已无法交付：安全终结并释放凭据/占位，绝不静默卡住。 */
  private async finalizeUndeliverableTailnet(jobId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.job.updateMany({
        where: { id: jobId, status: "pending" },
        data: {
          status: "error",
          errorCode: "TAILNET_OPERATION_MISMATCH",
          errorMessage: "机器离线或未声明 Tailnet 能力",
          finishedAt: new Date(),
        },
      });
      await this.tailnetKeys?.settle(tx as never, jobId, "unused");
      await tx.tailnetClientOperation.deleteMany({ where: { jobId } });
    });
    await this.jobLog?.record({
      jobId,
      event: "orphaned",
      source: "server",
      level: "warn",
      code: "TAILNET_OPERATION_MISMATCH",
      message: "机器离线或未声明 Tailnet 能力",
    });
  }
}
