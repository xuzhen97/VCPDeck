import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type { MachineRegister, Heartbeat, ClientInfo } from "@vcpdeck/shared";

@Injectable()
export class ClientService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async register(dto: MachineRegister, socketId: string) {
    await this.prisma.client.upsert({
      where: { id: dto.clientId },
      create: {
        id: dto.clientId,
        hostname: dto.hostname,
        os: dto.os,
        cpuModel: dto.cpuModel,
        totalMemMB: dto.totalMemMB,
        totalDiskMB: dto.totalDiskMB,
        clientVersion: dto.clientVersion,
        capabilities: JSON.stringify(dto.capabilities),
        online: true,
        socketId,
        connectedAt: new Date(),
      },
      update: {
        hostname: dto.hostname,
        os: dto.os,
        cpuModel: dto.cpuModel,
        totalMemMB: dto.totalMemMB,
        totalDiskMB: dto.totalDiskMB,
        clientVersion: dto.clientVersion,
        capabilities: JSON.stringify(dto.capabilities),
        online: true,
        socketId,
        connectedAt: new Date(),
      },
    });
  }

  async heartbeat(dto: Heartbeat) {
    await this.prisma.client.update({
      where: { id: dto.clientId },
      data: { lastHeartbeatAt: new Date() },
    });
  }

  async getClientIdBySocketId(socketId: string): Promise<string | null> {
    const c = await this.prisma.client.findFirst({ where: { socketId } });
    return c?.id ?? null;
  }

  async markOfflineBySocketId(socketId: string) {
    await this.prisma.client.updateMany({
      where: { socketId },
      data: { online: false, socketId: null },
    });
  }

  async listOnline(): Promise<ClientInfo[]> {
    const clients = await this.prisma.client.findMany({
      where: { online: true },
      orderBy: { connectedAt: "desc" },
    });
    return clients.map((c) => {
      let capabilities: string[] = [];
      try {
        capabilities = JSON.parse(c.capabilities) as string[];
      } catch {
        // ponytail: stored as JSON, fallback to empty on corruption
      }
      return {
        clientId: c.id,
        hostname: c.hostname,
        os: c.os,
        capabilities,
        online: c.online,
        lastHeartbeatAt: c.lastHeartbeatAt?.toISOString() ?? null,
      };
    });
  }
}
