/** @file FRP 映射服务 — CRUD + 端口分配 + Job 下发 */

import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { PortAllocator } from "./port-allocator.js";
import { FrpsInstancesService } from "./frp-instances.service.js";
import { randomUUID } from "node:crypto";
import type {
  FrpMappingCreateRequest,
  FrpMappingInfo,
  FrpCreatePayload,
  FrpDeletePayload,
  PaginatedResult,
} from "@vcpdeck/shared";

function buildPublicUrl(
  remotePort: number | null,
  proxyType: string,
  customDomain?: string | null,
  serverAddr?: string,
): string | null {
  if (remotePort === null) return null;
  const host = serverAddr || "127.0.0.1";
  switch (proxyType) {
    case "http":
      return customDomain
        ? `http://${customDomain}`
        : `http://${host}:${remotePort}`;
    case "https":
      return `https://${customDomain ?? host}`;
    case "tcp":
    default:
      return `${host}:${remotePort}`;
  }
}

@Injectable()
export class FrpService {
  private allocator: PortAllocator;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FrpsInstancesService)
    private readonly instancesService: FrpsInstancesService,
  ) {
    this.allocator = new PortAllocator(prisma);
  }

  async createMapping(dto: FrpMappingCreateRequest): Promise<{
    mapping: FrpMappingInfo;
    dispatch: {
      clientId: string;
      jobId: string;
      type: string;
      payload: Record<string, unknown>;
    };
  }> {
    const client = await this.prisma.client.findUnique({
      where: { id: dto.clientId },
    });
    if (!client) throw new Error(`Client "${dto.clientId}" 不存在`);
    if (!client.online) throw new Error(`Client "${dto.clientId}" 不在线`);

    let caps: string[] = [];
    try {
      caps = JSON.parse(client.capabilities) as string[];
    } catch {
      caps = [];
    }
    if (!caps.includes("frp")) {
      throw new Error(`Client "${dto.clientId}" 未启用 FRP 能力`);
    }

    const instance = dto.frpsInstanceId
      ? await this.instancesService.getById(dto.frpsInstanceId)
      : await this.instancesService.getDefault();

    if (!instance) {
      throw new Error("未找到目标 FRP 实例");
    }

    const remotePort = await this.allocator.allocate({
      preferredPort: dto.remotePort,
      portRangeStart: instance.portRangeStart,
      portRangeEnd: instance.portRangeEnd,
      dashboard: instance.dashboardHost
        ? {
            scheme: instance.dashboardScheme as "http" | "https",
            host: instance.dashboardHost,
            port: instance.dashboardPort,
            user: instance.dashboardUser,
            password: instance.dashboardPassword,
          }
        : null,
    });

    const id = `fm_${randomUUID().slice(0, 8)}`;
    const publicUrl = buildPublicUrl(
      remotePort,
      dto.proxyType,
      dto.customDomain,
      instance.serverAddr,
    );
    const nowStr = new Date().toISOString();

    await this.prisma.frpMapping.create({
      data: {
        id,
        clientId: dto.clientId,
        name: dto.name,
        frpsInstanceId: instance.id,
        proxyType: dto.proxyType,
        localIp: dto.localIp ?? "127.0.0.1",
        localPort: dto.localPort,
        remotePort,
        customDomain: dto.customDomain ?? null,
        status: "inactive",
        publicUrl,
      },
    });

    const frpsInfo = {
      serverAddr: instance.serverAddr,
      serverPort: instance.serverPort,
      authToken: instance.authToken,
    };

    const payload: FrpCreatePayload = {
      mappingId: id,
      name: dto.name,
      proxyType: dto.proxyType,
      localIp: dto.localIp ?? "127.0.0.1",
      localPort: dto.localPort,
      remotePort,
      customDomain: dto.customDomain,
      frpsInfo,
    };

    const jobId = randomUUID();
    await this.prisma.job.create({
      data: {
        id: jobId,
        clientId: dto.clientId,
        type: "frp.create",
        status: "pending",
        payload: JSON.stringify(payload),
      },
    });

    return {
      mapping: this.toApi({
        id,
        clientId: dto.clientId,
        name: dto.name,
        proxyType: dto.proxyType,
        localIp: dto.localIp ?? "127.0.0.1",
        localPort: dto.localPort,
        remotePort,
        customDomain: dto.customDomain ?? null,
        status: "inactive",
        publicUrl,
        createdAt: nowStr,
        updatedAt: nowStr,
      }),
      dispatch: {
        clientId: dto.clientId,
        jobId,
        type: "frp.create",
        payload: payload as unknown as Record<string, unknown>,
      },
    };
  }

  async deleteMapping(id: string): Promise<{
    mapping: FrpMappingInfo;
    dispatch: {
      clientId: string;
      jobId: string;
      type: string;
      payload: Record<string, unknown>;
    };
  } | null> {
    const m = await this.prisma.frpMapping.findUnique({ where: { id } });
    if (!m) return null;

    const dispatchPayload: FrpDeletePayload = {
      mappingId: id,
      name: m.name,
    };

    const jobId = randomUUID();
    await this.prisma.job.create({
      data: {
        id: jobId,
        clientId: m.clientId,
        type: "frp.delete",
        status: "pending",
        payload: JSON.stringify(dispatchPayload),
      },
    });

    const mappingInfo = this.toApi(m);
    await this.prisma.frpMapping.delete({ where: { id } });
    if (m.remotePort !== null) this.allocator.release(m.remotePort);

    return {
      mapping: mappingInfo,
      dispatch: {
        clientId: m.clientId,
        jobId,
        type: "frp.delete",
        payload: dispatchPayload as unknown as Record<string, unknown>,
      },
    };
  }

  async getMapping(id: string): Promise<FrpMappingInfo | null> {
    const m = await this.prisma.frpMapping.findUnique({ where: { id } });
    return m ? this.toApi(m) : null;
  }

  async listMappings(
    clientId?: string,
    page: number = 1,
    pageSize: number = 20,
  ): Promise<PaginatedResult<FrpMappingInfo>> {
    const where = clientId ? { clientId } : {};
    const [list, total] = await Promise.all([
      this.prisma.frpMapping.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.frpMapping.count({ where }),
    ]);
    return {
      data: list.map((m) => this.toApi(m)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async updateStatus(
    mappingId: string,
    status: string,
  ): Promise<void> {
    await this.prisma.frpMapping.update({
      where: { id: mappingId },
      data: { status },
    });
  }

  async markInactiveByClientId(clientId: string): Promise<void> {
    await this.prisma.frpMapping.updateMany({
      where: { clientId, status: "active" },
      data: { status: "inactive" },
    });
  }

  private toApi(m: {
    id: string;
    clientId: string;
    name: string;
    proxyType: string;
    localIp: string;
    localPort: number;
    remotePort: number | null;
    customDomain: string | null;
    status: string;
    publicUrl: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  }): FrpMappingInfo {
    return {
      id: m.id,
      clientId: m.clientId,
      name: m.name,
      proxyType: m.proxyType,
      localIp: m.localIp,
      localPort: m.localPort,
      remotePort: m.remotePort,
      customDomain: m.customDomain,
      status: m.status,
      publicUrl: m.publicUrl,
      createdAt:
        typeof m.createdAt === "string"
          ? m.createdAt
          : m.createdAt.toISOString(),
      updatedAt:
        typeof m.updatedAt === "string"
          ? m.updatedAt
          : m.updatedAt.toISOString(),
    };
  }
}
