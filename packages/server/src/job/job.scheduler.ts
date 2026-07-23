import { Injectable } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { DispatchPayload } from "@vcpdeck/shared";

const MAX_CONCURRENT_JOBS = 3;

@Injectable()
export class JobScheduler {
  constructor(private readonly prisma: PrismaService) {}

  async tryDispatch(clientId: string): Promise<DispatchPayload | null> {
    const runningCount = await this.prisma.job.count({
      where: { clientId, status: "running" },
    });
    if (runningCount >= MAX_CONCURRENT_JOBS) return null;

    const pending = await this.prisma.job.findFirst({
      where: { clientId, status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    if (!pending) return null;

    await this.prisma.job.update({
      where: { id: pending.id },
      data: { status: "running", startedAt: new Date() },
    });

    return {
      jobId: pending.id,
      clientId: pending.clientId,
      command: pending.command,
      timeout: pending.timeout ?? undefined,
    };
  }

  async onFinished(clientId: string): Promise<DispatchPayload | null> {
    return this.tryDispatch(clientId);
  }
}
