import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
	MachineRegister,
	Heartbeat,
	ClientInfo,
	DiskInfo,
	PiCapabilityStatus,
} from "@vcpdeck/shared";

/** 别名已被其他客户端占用（409） */
export const CLIENT_NAME_TAKEN = "CLIENT_NAME_TAKEN";
/** 客户端不存在（404） */
export const CLIENT_NOT_FOUND = "CLIENT_NOT_FOUND";
/** 别名为空（400） */
export const INVALID_CLIENT_NAME = "INVALID_CLIENT_NAME";

/** 服务层错误：稳定 code + statusCode，由 Controller 映射为 HttpException */
function clientError(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

/** Prisma 行 → ClientInfo（name 为 null 时回退 hostname，兼容迁移前的旧记录） */
interface ClientRow {
  id: string;
  name: string | null;
  hostname: string;
  os: string;
  cpuModel: string;
  totalMemMB: number;
  clientVersion: string;
  capabilities: string;
  capabilityDetails: string;
  disks: string;
  online: boolean;
  cpuPercent: number | null;
  memPercent: number | null;
  lastHeartbeatAt: Date | null;
  connectedAt?: Date | null;
}

@Injectable()
export class ClientService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async register(dto: MachineRegister, socketId: string) {
    const capabilityDetails = JSON.stringify(dto.capabilityDetails ?? {});
    const common = {
      hostname: dto.hostname,
      os: dto.os,
      cpuModel: dto.cpuModel,
      totalMemMB: dto.totalMemMB,
      clientVersion: dto.clientVersion,
      capabilities: JSON.stringify(dto.capabilities),
      capabilityDetails,
      online: true,
      socketId,
      connectedAt: new Date(),
    };

    // 别名策略：新机器首次注册生成唯一别名（默认 hostname，重名自动加后缀）；
    // 已有记录保持别名不动（迁移前的旧记录 name 为 null 时在此补齐）
    const existing = await this.prisma.client.findUnique({
      where: { id: dto.clientId },
      select: { name: true },
    });
    const name = existing?.name ?? (await this.nextAvailableName(dto.hostname));

    await this.prisma.client.upsert({
      where: { id: dto.clientId },
      create: { ...common, id: dto.clientId, name },
      update: existing?.name ? common : { ...common, name },
    });
  }

  /**
   * 生成全局唯一别名：优先 base，被占用则依次尝试 base_1、base_2 …
   * 并发注册同名机器的极小竞态由 name 唯一索引兜底（失败方下次重连自愈）。
   */
  async nextAvailableName(base: string): Promise<string> {
    const clean = base.trim() || "client";
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? clean : `${clean}_${i}`;
      const hit = await this.prisma.client.findFirst({
        where: { name: candidate },
        select: { id: true },
      });
      if (!hit) return candidate;
    }
    throw clientError("CLIENT_NAME_UNAVAILABLE", `No available name for "${base}"`, 409);
  }

  /** 修改别名：必须全局唯一；改名立即生效，机器下次重连不会覆盖 */
  async rename(clientId: string, name: string): Promise<ClientInfo> {
    const clean = name.trim();
    if (!clean) {
      throw clientError(INVALID_CLIENT_NAME, "Client name must be a non-empty string", 400);
    }
    const taken = await this.prisma.client.findFirst({
      where: { name: clean, id: { not: clientId } },
      select: { id: true },
    });
    if (taken) {
      throw clientError(CLIENT_NAME_TAKEN, `Client name "${clean}" is already taken`, 409);
    }
    let updated: ClientRow;
    try {
      updated = await this.prisma.client.update({
        where: { id: clientId },
        data: { name: clean },
      });
    } catch (error) {
      // P2025: 目标记录不存在
      if ((error as { code?: string } | null)?.code === "P2025") {
        throw clientError(CLIENT_NOT_FOUND, `Client "${clientId}" not found`, 404);
      }
      throw error;
    }
    return this.toClientInfo(updated);
  }

  async heartbeat(dto: Heartbeat) {
    await this.prisma.client.update({
      where: { id: dto.clientId },
      data: {
        lastHeartbeatAt: new Date(),
        cpuPercent: dto.cpuPercent,
        memPercent: dto.memPercent,
        disks: JSON.stringify(dto.disks),
        runningJobs: JSON.stringify(dto.runningJobs),
      },
    });
  }

  /** Re-bind socketId on reconnect without overwriting machine info. */
  async bindSocket(clientId: string, socketId: string) {
    await this.prisma.client.update({
      where: { id: clientId },
      data: { online: true, socketId, connectedAt: new Date() },
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
    return clients.map((c) => this.toClientInfo(c));
  }

  /** 返回一键安装器所需的最小 Client 验收摘要。 */
  async getInstallerStatus(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return {
        registered: false,
        online: false,
        clientVersion: null,
        name: null,
        hostname: null,
        capabilitiesReported: false,
        connectedAt: null,
        lastHeartbeatAt: null,
      };
    }
    let capabilities: unknown = [];
    try {
      capabilities = JSON.parse(client.capabilities);
    } catch {
      // 损坏数据按未完成能力上报处理。
    }
    return {
      registered: true,
      online: client.online,
      clientVersion: client.clientVersion,
      name: client.name ?? client.hostname,
      hostname: client.hostname,
      capabilitiesReported: Array.isArray(capabilities) && capabilities.length > 0,
      connectedAt: client.connectedAt?.toISOString() ?? null,
      lastHeartbeatAt: client.lastHeartbeatAt?.toISOString() ?? null,
    };
  }

  private toClientInfo(c: ClientRow): ClientInfo {
    let capabilities: string[] = [];
    try {
      capabilities = JSON.parse(c.capabilities) as string[];
    } catch {
      // ponytail: stored as JSON, fallback to empty on corruption
    }
    let disks: DiskInfo[] = [];
    try {
      disks = JSON.parse(c.disks) as DiskInfo[];
    } catch {
      // ponytail: stored as JSON, fallback to empty on corruption
    }
    let capabilityDetails: { pi?: PiCapabilityStatus } = {};
    try {
      capabilityDetails = JSON.parse(c.capabilityDetails) as {
        pi?: PiCapabilityStatus;
      };
    } catch {
      // ponytail: stored as JSON, fallback to empty on corruption
    }
    return {
      clientId: c.id,
      name: c.name ?? c.hostname,
      hostname: c.hostname,
      os: c.os,
      cpuModel: c.cpuModel,
      totalMemMB: c.totalMemMB,
      clientVersion: c.clientVersion,
      capabilities,
      capabilityDetails,
      online: c.online,
      cpuPercent: c.cpuPercent ?? null,
      memPercent: c.memPercent ?? null,
      disks,
      lastHeartbeatAt: c.lastHeartbeatAt?.toISOString() ?? null,
    };
  }
}
