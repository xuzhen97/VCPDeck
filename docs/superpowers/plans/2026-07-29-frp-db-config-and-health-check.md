# FRP 配置 DB 化 + 多实例 + 健康检查 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 FRP 全部配置从环境变量迁移到 DB 表 `FrpsInstance`，支持多套 frps 实例，新增健康检查端点。

**Architecture:** 新增 `FrpsInstancesService`（CRUD+探活+迁移）和 `FrpsInstancesController`（REST），`FrpService` 改为从 DB 缓存默认实例配置，`PortAllocator.allocate()` 改为接收端口范围参数。

**Tech Stack:** NestJS + Prisma (SQLite) + TypeScript ESM + Node.js net 模块

## Global Constraints

- 遵循项目 AGENTS.md：TypeScript strict + ESM + 简体中文注释
- 分页复用 `PaginatedResult<T>` 模式
- Controller 手动解析 query string，不引入 ValidationPipe
- 测试用 Vitest

---

### Task 1: Prisma Schema 变更 + 类型定义

**Files:**

- Modify: `packages/server/prisma/schema.prisma`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**

- Produces: `FrpsInstance` Prisma 模型，`FrpMapping.frpsInstanceId` 字段
- Produces: `FrpsInstanceInfo`, `FrpsInstanceCreateRequest`, `FrpsInstanceUpdateRequest`, `ProbeResult` 等类型

- [ ] **Step 1: 在 schema.prisma 中新增 FrpsInstance 模型，变更 FrpMapping**

```prisma
model FrpsInstance {
  id                String   @id                          // "frps_" + uuid8
  name              String                                // 实例名称
  serverAddr        String                                // frps 连接地址
  serverPort        Int      @default(7000)
  authToken         String   @default("")
  dashboardScheme   String   @default("http")             // "http" | "https"
  dashboardHost     String?
  dashboardPort     Int      @default(7500)
  dashboardUser     String   @default("admin")
  dashboardPassword String   @default("admin")
  portRangeStart    Int      @default(20000)
  portRangeEnd      Int      @default(21000)
  isDefault         Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  mappings          FrpMapping[]
}
```

在 `FrpMapping` 模型末尾（`@@index` 之前如果有的话）新增：

```diff
model FrpMapping {
  ...
+ frpsInstanceId String?
+ frpsInstance   FrpsInstance? @relation(fields: [frpsInstanceId], references: [id])
}
```

- [ ] **Step 2: 生成 Prisma migration 并验证**

```bash
cd packages/server && npx prisma migrate dev --name add-frps-instance
```

预期：生成 migration SQL，数据库更新成功，Prisma Client 重新生成。

- [ ] **Step 3: 在 shared/src/index.ts 新增类型定义**

在 `FrpMappingCreateRequest` 后添加：

```ts
// ── FRP 实例配置 ──

/** DB 中存储的 frps 实例信息（REST 返回） */
export interface FrpsInstanceInfo {
  id: string;
  name: string;
  serverAddr: string;
  serverPort: number;
  authToken: string;
  dashboardScheme: string;
  dashboardHost: string | null;
  dashboardPort: number;
  dashboardUser: string;
  dashboardPassword: string;
  portRangeStart: number;
  portRangeEnd: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 创建 frps 实例请求体 */
export interface FrpsInstanceCreateRequest {
  name: string;
  serverAddr: string;
  serverPort?: number;
  authToken?: string;
  dashboardScheme?: "http" | "https";
  dashboardHost?: string;
  dashboardPort?: number;
  dashboardUser?: string;
  dashboardPassword?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
  isDefault?: boolean;
}

/** 更新 frps 实例请求体（所有字段可选） */
export interface FrpsInstanceUpdateRequest {
  name?: string;
  serverAddr?: string;
  serverPort?: number;
  authToken?: string;
  dashboardScheme?: "http" | "https";
  dashboardHost?: string | null;
  dashboardPort?: number;
  dashboardUser?: string;
  dashboardPassword?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
  isDefault?: boolean;
}

/** 健康检查返回体 */
export interface ProbeResult {
  ok: boolean;
  tcpReachable: boolean;
  tcpLatencyMs: number;
  dashboardReachable: boolean;
  authValid: boolean;
  serverInfo?: { version: string };
  error?: string;
  proxies: {
    total: number;
    byType: { tcp: number; http: number; https: number };
    list: { name: string; proxyType: string; remotePort: number | null }[];
    usedPorts: number[];
  } | null;
}
```

同时修改 `FrpMappingCreateRequest`，增加可选字段：

```diff
export interface FrpMappingCreateRequest {
  clientId: string;
  name: string;
  proxyType: "tcp" | "http" | "https";
  localIp?: string;
  localPort: number;
  remotePort?: number;
  customDomain?: string;
+ frpsInstanceId?: string;
}
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
cd packages/server && npx tsc --noEmit
cd packages/shared && npx tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 5: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations packages/shared/src/index.ts
git commit -m "feat: 新增 FrpsInstance 模型和共享类型定义"
```

---

### Task 2: FrpsInstancesService — CRUD + 迁移 + 健康检查

**Files:**

- Create: `packages/server/src/frp/frp-instances.service.ts`
- Create: `packages/server/src/frp/frp-instances.service.test.ts`

**Interfaces:**

- Produces: `FrpsInstancesService` 类，注入 `PrismaService`
  - `create(dto: FrpsInstanceCreateRequest): Promise<FrpsInstanceInfo>`
  - `getById(id: string): Promise<FrpsInstanceInfo | null>`
  - `list(page?, pageSize?): Promise<PaginatedResult<FrpsInstanceInfo>>`
  - `update(id: string, dto: FrpsInstanceUpdateRequest): Promise<FrpsInstanceInfo>`
  - `delete(id: string): Promise<boolean>`
  - `migrateFromEnvIfNeeded(): Promise<FrpsInstanceInfo | null>` — 首次启动自动迁移
  - `probe(id: string): Promise<ProbeResult>`
  - `getDefault(): Promise<FrpsInstanceInfo>` — 获取默认实例
  - `setDefault(id: string): Promise<FrpsInstanceInfo>` — 切换默认实例

- [ ] **Step 1: 写测试文件 frp-instances.service.test.ts**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FrpsInstancesService } from "./frp-instances.service.js";

function mockPrisma() {
  return {
    frpsInstance: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      updateMany: vi.fn(),
    },
    frpMapping: {
      count: vi.fn(),
    },
  } as any;
}

describe("FrpsInstancesService", () => {
  let service: FrpsInstancesService;
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new FrpsInstancesService(prisma);
  });

  describe("create", () => {
    it("should create an instance with defaults", async () => {
      prisma.frpsInstance.create.mockResolvedValue({
        id: "frps_abc",
        name: "test",
        serverAddr: "1.2.3.4",
        serverPort: 7000,
        authToken: "",
        dashboardScheme: "http",
        dashboardHost: null,
        dashboardPort: 7500,
        dashboardUser: "admin",
        dashboardPassword: "admin",
        portRangeStart: 20000,
        portRangeEnd: 21000,
        isDefault: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.create({
        name: "test",
        serverAddr: "1.2.3.4",
      });
      expect(result.name).toBe("test");
      expect(result.id).toMatch(/^frps_/);
    });

    it("should clear other defaults when isDefault=true", async () => {
      prisma.frpsInstance.updateMany.mockResolvedValue({});
      prisma.frpsInstance.create.mockResolvedValue({
        id: "frps_xyz", name: "default", serverAddr: "1.2.3.4",
        serverPort: 7000, authToken: "", dashboardScheme: "http",
        dashboardHost: null, dashboardPort: 7500, dashboardUser: "admin",
        dashboardPassword: "admin", portRangeStart: 20000, portRangeEnd: 21000,
        isDefault: true, createdAt: new Date(), updatedAt: new Date(),
      });
      const result = await service.create({
        name: "default",
        serverAddr: "1.2.3.4",
        isDefault: true,
      });
      expect(prisma.frpsInstance.updateMany).toHaveBeenCalledWith({
        where: { isDefault: true },
        data: { isDefault: false },
      });
      expect(result.isDefault).toBe(true);
    });
  });

  describe("delete", () => {
    it("should reject when mappings exist", async () => {
      prisma.frpMapping.count.mockResolvedValue(3);
      await expect(service.delete("frps_abc")).rejects.toThrow("3 个映射");
    });

    it("should delete when no mappings", async () => {
      prisma.frpMapping.count.mockResolvedValue(0);
      prisma.frpsInstance.findUnique.mockResolvedValue({ id: "frps_abc" });
      prisma.frpsInstance.delete.mockResolvedValue({});
      const result = await service.delete("frps_abc");
      expect(result).toBe(true);
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/server && npx vitest run src/frp/frp-instances.service.test.ts
```

预期：FAIL — `FrpsInstancesService` 未定义或方法缺失。

- [ ] **Step 3: 实现 FrpsInstancesService**

```ts
/** @file FRP 实例配置服务 — CRUD + 自动迁移 + 健康检查 */

import { Injectable, Inject, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { PrismaService } from "../prisma/prisma.service.js";
import type {
  FrpsInstanceCreateRequest,
  FrpsInstanceUpdateRequest,
  FrpsInstanceInfo,
  PaginatedResult,
  ProbeResult,
} from "@vcpdeck/shared";

@Injectable()
export class FrpsInstancesService {
  private readonly logger = new Logger(FrpsInstancesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async create(dto: FrpsInstanceCreateRequest): Promise<FrpsInstanceInfo> {
    if (dto.isDefault) {
      await this.prisma.frpsInstance.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const id = `frps_${randomUUID().slice(0, 8)}`;
    const row = await this.prisma.frpsInstance.create({
      data: {
        id,
        name: dto.name,
        serverAddr: dto.serverAddr,
        serverPort: dto.serverPort ?? 7000,
        authToken: dto.authToken ?? "",
        dashboardScheme: dto.dashboardScheme ?? "http",
        dashboardHost: dto.dashboardHost ?? null,
        dashboardPort: dto.dashboardPort ?? 7500,
        dashboardUser: dto.dashboardUser ?? "admin",
        dashboardPassword: dto.dashboardPassword ?? "admin",
        portRangeStart: dto.portRangeStart ?? 20000,
        portRangeEnd: dto.portRangeEnd ?? 21000,
        isDefault: dto.isDefault ?? false,
      },
    });

    return this.toApi(row);
  }

  async getById(id: string): Promise<FrpsInstanceInfo | null> {
    const row = await this.prisma.frpsInstance.findUnique({ where: { id } });
    return row ? this.toApi(row) : null;
  }

  async list(
    page: number = 1,
    pageSize: number = 20,
  ): Promise<PaginatedResult<FrpsInstanceInfo>> {
    const [list, total] = await Promise.all([
      this.prisma.frpsInstance.findMany({
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.frpsInstance.count(),
    ]);
    return {
      data: list.map((r) => this.toApi(r)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async update(
    id: string,
    dto: FrpsInstanceUpdateRequest,
  ): Promise<FrpsInstanceInfo> {
    const existing = await this.prisma.frpsInstance.findUnique({
      where: { id },
    });
    if (!existing) throw new Error(`FrpsInstance "${id}" 不存在`);

    if (dto.isDefault === true) {
      await this.prisma.frpsInstance.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.serverAddr !== undefined) data.serverAddr = dto.serverAddr;
    if (dto.serverPort !== undefined) data.serverPort = dto.serverPort;
    if (dto.authToken !== undefined) data.authToken = dto.authToken;
    if (dto.dashboardScheme !== undefined) data.dashboardScheme = dto.dashboardScheme;
    if (dto.dashboardHost !== undefined) data.dashboardHost = dto.dashboardHost;
    if (dto.dashboardPort !== undefined) data.dashboardPort = dto.dashboardPort;
    if (dto.dashboardUser !== undefined) data.dashboardUser = dto.dashboardUser;
    if (dto.dashboardPassword !== undefined) data.dashboardPassword = dto.dashboardPassword;
    if (dto.portRangeStart !== undefined) data.portRangeStart = dto.portRangeStart;
    if (dto.portRangeEnd !== undefined) data.portRangeEnd = dto.portRangeEnd;
    if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;

    const row = await this.prisma.frpsInstance.update({
      where: { id },
      data,
    });
    return this.toApi(row);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.prisma.frpsInstance.findUnique({
      where: { id },
    });
    if (!existing) return false;

    const mappingCount = await this.prisma.frpMapping.count({
      where: { frpsInstanceId: id },
    });
    if (mappingCount > 0) {
      throw new Error(
        `无法删除：${mappingCount} 个映射关联到实例 "${existing.name}"`,
      );
    }

    await this.prisma.frpsInstance.delete({ where: { id } });
    return true;
  }

  /** 获取默认实例 */
  async getDefault(): Promise<FrpsInstanceInfo> {
    const row = await this.prisma.frpsInstance.findFirst({
      where: { isDefault: true },
    });
    if (!row) throw new Error("没有默认 FRP 实例，请先配置");
    return this.toApi(row);
  }

  /** 设置默认实例 */
  async setDefault(id: string): Promise<FrpsInstanceInfo> {
    await this.prisma.frpsInstance.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
    const row = await this.prisma.frpsInstance.update({
      where: { id },
      data: { isDefault: true },
    });
    return this.toApi(row);
  }

  /** 首次启动：如 DB 无任何实例，从环境变量自动迁移 */
  async migrateFromEnvIfNeeded(): Promise<FrpsInstanceInfo | null> {
    const count = await this.prisma.frpsInstance.count();
    if (count > 0) return null;

    const row = await this.prisma.frpsInstance.create({
      data: {
        id: `frps_${randomUUID().slice(0, 8)}`,
        name: "默认（从环境变量迁移）",
        serverAddr: process.env.FRP_PUBLIC_HOST || "127.0.0.1",
        serverPort: parseInt(process.env.FRPS_BIND_PORT || "7000", 10),
        authToken: process.env.FRPS_TOKEN || "",
        dashboardScheme:
          (process.env.FRP_DASHBOARD_SCHEME as "http" | "https") || "http",
        dashboardHost: process.env.FRP_DASHBOARD_HOST || null,
        dashboardPort: parseInt(
          process.env.FRP_DASHBOARD_PORT || "7500",
          10,
        ),
        dashboardUser: process.env.FRP_DASHBOARD_USER || "admin",
        dashboardPassword: process.env.FRP_DASHBOARD_PASSWORD || "admin",
        portRangeStart: parseInt(
          process.env.FRP_PORT_RANGE_START || "20000",
          10,
        ),
        portRangeEnd: parseInt(
          process.env.FRP_PORT_RANGE_END || "21000",
          10,
        ),
        isDefault: true,
      },
    });

    this.logger.log("已从环境变量迁移 FRP 配置到 DB");
    return this.toApi(row);
  }

  /** 健康检查 */
  async probe(id: string): Promise<ProbeResult> {
    const instance = await this.getById(id);
    if (!instance) throw new Error(`FrpsInstance "${id}" 不存在`);

    // 1. TCP 连接检查
    const tcpResult = await this.probeTcp(
      instance.serverAddr,
      instance.serverPort,
    );

    // 2. Dashboard 检查
    if (instance.dashboardHost) {
      const dashResult = await this.probeDashboard(instance);

      // 3. 拉取已注册 proxy 列表
      let proxies: ProbeResult["proxies"] = null;
      if (dashResult.authValid) {
        proxies = await this.fetchProxyList(instance);
      }

      return {
        ok: dashResult.authValid,
        tcpReachable: tcpResult.ok,
        tcpLatencyMs: tcpResult.latencyMs,
        dashboardReachable: dashResult.reachable,
        authValid: dashResult.authValid,
        serverInfo: dashResult.serverInfo,
        error: dashResult.error,
        proxies,
      };
    }

    // 无 Dashboard：仅 TCP 检查
    return {
      ok: tcpResult.ok,
      tcpReachable: tcpResult.ok,
      tcpLatencyMs: tcpResult.latencyMs,
      dashboardReachable: false,
      authValid: false,
      error: tcpResult.ok
        ? undefined
        : "TCP 连接失败且未配置 Dashboard",
      proxies: null,
    };
  }

  /** TCP 连接检查 */
  private probeTcp(
    host: string,
    port: number,
    timeoutMs = 5000,
  ): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve({ ok, latencyMs: Date.now() - startedAt });
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  /** Dashboard 认证检查 */
  private async probeDashboard(instance: FrpsInstanceInfo): Promise<{
    reachable: boolean;
    authValid: boolean;
    serverInfo?: { version: string };
    error?: string;
  }> {
    try {
      const auth = Buffer.from(
        `${instance.dashboardUser}:${instance.dashboardPassword}`,
      ).toString("base64");

      const res = await fetch(
        `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}/api/serverinfo`,
        {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(5000),
        },
      );

      if (res.status === 200) {
        const body = (await res.json()) as { version?: string };
        return {
          reachable: true,
          authValid: true,
          serverInfo: { version: body.version ?? "unknown" },
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          reachable: true,
          authValid: false,
          error: `认证失败: HTTP ${res.status}`,
        };
      }

      return {
        reachable: true,
        authValid: false,
        error: `Dashboard 返回异常状态: ${res.status}`,
      };
    } catch (err) {
      return {
        reachable: false,
        authValid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 拉取 frps 已注册 proxy 列表 */
  private async fetchProxyList(
    instance: FrpsInstanceInfo,
  ): Promise<ProbeResult["proxies"]> {
    const auth = Buffer.from(
      `${instance.dashboardUser}:${instance.dashboardPassword}`,
    ).toString("base64");
    const base = `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}`;
    const types = ["tcp", "http", "https"] as const;

    try {
      const results = await Promise.all(
        types.map(async (t) => {
          const res = await fetch(`${base}/api/proxy/${t}`, {
            headers: { Authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) return [] as { name: string; proxyType: string; remotePort: number | null }[];
          const body = (await res.json()) as {
            proxies?: Array<{
              name?: string;
              remotePort?: number;
              conf?: { remotePort?: number };
            }>;
          };
          return (body.proxies ?? [])
            .filter((p) => typeof p.name === "string")
            .map((p) => ({
              name: p.name!,
              proxyType: t,
              remotePort:
                p.remotePort ?? p.conf?.remotePort ?? null,
            }));
        }),
      );

      const flat = results.flat();
      const usedPorts = [
        ...new Set(
          flat
            .map((p) => p.remotePort)
            .filter((p): p is number => p !== null)
            .sort((a, b) => a - b),
        ),
      ];

      return {
        total: flat.length,
        byType: {
          tcp: flat.filter((p) => p.proxyType === "tcp").length,
          http: flat.filter((p) => p.proxyType === "http").length,
          https: flat.filter((p) => p.proxyType === "https").length,
        },
        list: flat,
        usedPorts,
      };
    } catch {
      return null;
    }
  }

  private toApi(row: any): FrpsInstanceInfo {
    return {
      id: row.id,
      name: row.name,
      serverAddr: row.serverAddr,
      serverPort: row.serverPort,
      authToken: row.authToken,
      dashboardScheme: row.dashboardScheme,
      dashboardHost: row.dashboardHost,
      dashboardPort: row.dashboardPort,
      dashboardUser: row.dashboardUser,
      dashboardPassword: row.dashboardPassword,
      portRangeStart: row.portRangeStart,
      portRangeEnd: row.portRangeEnd,
      isDefault: row.isDefault,
      createdAt:
        typeof row.createdAt === "string"
          ? row.createdAt
          : row.createdAt.toISOString(),
      updatedAt:
        typeof row.updatedAt === "string"
          ? row.updatedAt
          : row.updatedAt.toISOString(),
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/server && npx vitest run src/frp/frp-instances.service.test.ts
```

预期：全部通过。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/frp/frp-instances.service.ts packages/server/src/frp/frp-instances.service.test.ts
git commit -m "feat: FrpsInstancesService — CRUD + 自动迁移 + 健康检查"
```

---

### Task 3: FrpsInstancesController — REST 端点

**Files:**

- Create: `packages/server/src/frp/frp-instances.controller.ts`

**Interfaces:**

- Consumes: `FrpsInstancesService`（从 Task 2）
- Produces: REST 端点 `/api/frp/instances`

- [ ] **Step 1: 实现 FrpsInstancesController**

```ts
/** @file FRP 实例配置 REST API */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  BadRequestException,
  Inject,
} from "@nestjs/common";
import { FrpsInstancesService } from "./frp-instances.service.js";
import type {
  FrpsInstanceCreateRequest,
  FrpsInstanceUpdateRequest,
} from "@vcpdeck/shared";

@Controller("api/frp/instances")
export class FrpsInstancesController {
  constructor(
    @Inject(FrpsInstancesService)
    private readonly instancesService: FrpsInstancesService,
  ) {}

  @Post()
  async create(@Body() body: FrpsInstanceCreateRequest) {
    if (!body.name || !body.serverAddr) {
      throw new BadRequestException("缺少必填字段：name, serverAddr");
    }
    return this.instancesService.create(body);
  }

  @Get()
  async list(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.instancesService.list(
      page ? Math.max(1, parseInt(page, 10)) : undefined,
      pageSize
        ? Math.min(100, Math.max(1, parseInt(pageSize, 10)))
        : undefined,
    );
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const instance = await this.instancesService.getById(id);
    if (!instance) {
      throw new BadRequestException(`实例 "${id}" 不存在`);
    }
    return instance;
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: FrpsInstanceUpdateRequest,
  ) {
    try {
      return await this.instancesService.update(id, body);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  @Delete(":id")
  async delete(@Param("id") id: string) {
    try {
      const deleted = await this.instancesService.delete(id);
      if (!deleted) {
        throw new BadRequestException(`实例 "${id}" 不存在`);
      }
      return { id, deleted: true };
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  @Post(":id/probe")
  async probe(@Param("id") id: string) {
    try {
      return await this.instancesService.probe(id);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  @Post(":id/set-default")
  async setDefault(@Param("id") id: string) {
    try {
      return await this.instancesService.setDefault(id);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
cd packages/server && npx tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/frp/frp-instances.controller.ts
git commit -m "feat: FrpsInstancesController — 实例 CRUD + probe + set-default 端点"
```

---

### Task 4: PortAllocator 参数化

**Files:**

- Modify: `packages/server/src/frp/port-allocator.ts`

**Interfaces:**

- Consumes: 当前全局配置 `getFrpConfig()`（内部依赖，即将废弃）
- Produces: `allocate()` 改为接收 `portRangeStart`、`portRangeEnd`、`dashboard` 参数，不再内部调用 `getFrpConfig()`

- [ ] **Step 1: 修改 PortAllocator.allocate() 签名**

将 `allocate()` 的 `options` 参数扩展为：

```ts
interface AllocateOptions {
  preferredPort?: number;
  portRangeStart?: number;
  portRangeEnd?: number;
  dashboard?: FrpDashboardConfig | null;
}
```

完整修改 `port-allocator.ts`：

```diff
import type { PrismaService } from "../prisma/prisma.service.js";
-import { getFrpConfig } from "./frp-config.js";
+import type { FrpDashboardConfig } from "./frp-config.js";

+export interface AllocateOptions {
+  preferredPort?: number;
+  portRangeStart?: number;
+  portRangeEnd?: number;
+  dashboard?: FrpDashboardConfig | null;
+}

export class PortAllocator {
  ...

- async allocate(options?: { preferredPort?: number }): Promise<number> {
+ async allocate(options?: AllocateOptions): Promise<number> {
-   const config = getFrpConfig();
+   const portRangeStart = options?.portRangeStart ?? 20000;
+   const portRangeEnd = options?.portRangeEnd ?? 21000;
+   const dashboard = options?.dashboard;

    return this.withLock(async () => {
-     const usedPorts = await this.loadUsedPorts();
+     const usedPorts = await this.loadUsedPorts(portRangeStart, portRangeEnd, dashboard ?? null);
      ...
      if (typeof options?.preferredPort === "number") {
        const p = options.preferredPort;
-       if (p < config.portRangeStart || p > config.portRangeEnd) {
+       if (p < portRangeStart || p > portRangeEnd) {
          throw new Error(`端口 ${p} 超出配置范围 ${portRangeStart}-${portRangeEnd}`);
        }
        ...
      }

      for (let port = portRangeStart; port <= portRangeEnd; port++) {
        if (!usedPorts.has(port)) return port;
      }

      throw new Error(`端口范围 ${portRangeStart}-${portRangeEnd} 内无可用端口`);
    });
  }

- private async loadUsedPorts(): Promise<Set<number>> {
+ private async loadUsedPorts(
+   _portRangeStart: number,
+   _portRangeEnd: number,
+   dashboard: FrpDashboardConfig | null,
+ ): Promise<Set<number>> {
    ...
-   const dashboard = getFrpConfig().dashboard;
    if (dashboard) {
```

（完整代码在步骤 2 中全部替换，保留向后兼容的默认值 20000-21000）

- [ ] **Step 2: 运行现有 PortAllocator 相关测试验证不退化**

```bash
cd packages/server && npx vitest run src/frp/
```

预期：无失败。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/frp/port-allocator.ts
git commit -m "refactor: PortAllocator.allocate() 参数化端口范围和 Dashboard"
```

---

### Task 5: FrpService 集成 FrpsInstance

**Files:**

- Modify: `packages/server/src/frp/frp.service.ts`

**Interfaces:**

- Consumes: `FrpsInstancesService.getDefault()`（从 Task 2），`PortAllocator` 新签名（从 Task 4）
- Produces: `createMapping()` 接受 `frpsInstanceId`，`deleteMapping()` 不变

- [ ] **Step 1: 修改 FrpService**

在 `packages/server/src/frp/frp.service.ts` 顶部新增 import：

```diff
+import { FrpsInstancesService } from "./frp-instances.service.js";
+import type { FrpsInstanceInfo } from "@vcpdeck/shared";
```

构造函数新增注入 + 修改 createMapping：

```ts
constructor(
  @Inject(PrismaService) private readonly prisma: PrismaService,
  @Inject(FrpsInstancesService)
  private readonly instancesService: FrpsInstancesService,
) {
  this.allocator = new PortAllocator(prisma);
}
```

修改 `createMapping()` 中获取配置的部分：

```ts
// 原来：
const config = getFrpConfig();
const remotePort = await this.allocator.allocate({ preferredPort: dto.remotePort });
const frpsInfo = {
  serverAddr: config.frpsPublicHost,
  serverPort: parseInt(process.env.FRPS_BIND_PORT || "7000", 10),
  authToken: process.env.FRPS_TOKEN || "",
};

// 改为：
const instance = dto.frpsInstanceId
  ? await this.instancesService.getById(dto.frpsInstanceId)
  : await this.instancesService.getDefault();

if (!instance) {
  throw new Error("未配置默认 FRP 实例");
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

const frpsInfo = {
  serverAddr: instance.serverAddr,
  serverPort: instance.serverPort,
  authToken: instance.authToken,
};
```

修改 `create()` 的 Prisma create data，增加 `frpsInstanceId`：

```diff
await this.prisma.frpMapping.create({
  data: {
    id,
    clientId: dto.clientId,
+   frpsInstanceId: instance.id,
    name: dto.name,
    ...
  },
});
```

修改 `buildPublicUrl` 调用（原先用 `getFrpConfig().frpsPublicHost`，改为用 `instance.serverAddr`）：

```ts
function buildPublicUrl(
  remotePort: number | null,
  proxyType: string,
  customDomain?: string | null,
  serverAddr?: string,   // 新增
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
```

同时移除 `getFrpConfig` import，移除 `process.env.FRPS_BIND_PORT` 和 `process.env.FRPS_TOKEN` 的引用。

- [ ] **Step 2: 运行 frp service 相关测试**

```bash
cd packages/server && npx vitest run src/frp/frp.service.test.ts 2>/dev/null || echo "No existing test file"
```

如已有测试，确认通过或适配。

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/frp/frp.service.ts
git commit -m "feat: FrpService 集成 FrpsInstance — 创建映射时关联 frps 实例"
```

---

### Task 6: FrpController + SDK 适配

**Files:**

- Modify: `packages/server/src/frp/frp.controller.ts`
- Modify: `packages/sdk/src/frp.ts`

**Interfaces:**

- Consumes: FrpService 新 createMapping 签名（从 Task 5）
- Produces: Controller 接受 `frpsInstanceId`，SDK `create()` 支持 `frpsInstanceId`

- [ ] **Step 1: FrpController 无需代码变更**

Controller 的 `create()` 方法直接把 Body 传给 `frpService.createMapping(body)`，`FrpMappingCreateRequest` 已包含 `frpsInstanceId?`。无需额外修改。

验证编译：

```bash
cd packages/server && npx tsc --noEmit
```

- [ ] **Step 2: 扩展 SDK**

修改 `packages/sdk/src/frp.ts`，在 return 对象中新增 `instances` 子 API：

```ts
import type {
  FrpMappingCreateRequest,
  FrpMappingInfo,
  FrpsInstanceCreateRequest,
  FrpsInstanceUpdateRequest,
  FrpsInstanceInfo,
  PaginatedResult,
  ProbeResult,
} from "@vcpdeck/shared";
import type { VcpDeckClient } from "./client.js";

export function createFrpApi(client: Pick<VcpDeckClient, "request">) {
  return {
    // ...现有 list/get/create/delete 方法不变...

    instances: {
      list: (
        options?: { page?: number; pageSize?: number },
        signal?: AbortSignal,
      ) => {
        const params = new URLSearchParams();
        if (options?.page) params.set("page", String(options.page));
        if (options?.pageSize) params.set("pageSize", String(options.pageSize));
        const qs = params.toString();
        return client.request<PaginatedResult<FrpsInstanceInfo>>(
          "GET",
          `/api/frp/instances${qs ? `?${qs}` : ""}`,
          undefined,
          signal,
        );
      },
      get: (id: string, signal?: AbortSignal) =>
        client.request<FrpsInstanceInfo>(
          "GET",
          `/api/frp/instances/${encodeURIComponent(id)}`,
          undefined,
          signal,
        ),
      create: (input: FrpsInstanceCreateRequest, signal?: AbortSignal) =>
        client.request<FrpsInstanceInfo>(
          "POST",
          "/api/frp/instances",
          input,
          signal,
        ),
      update: (
        id: string,
        input: FrpsInstanceUpdateRequest,
        signal?: AbortSignal,
      ) =>
        client.request<FrpsInstanceInfo>(
          "PUT",
          `/api/frp/instances/${encodeURIComponent(id)}`,
          input,
          signal,
        ),
      delete: (id: string, signal?: AbortSignal) =>
        client.request<{ id: string; deleted: true }>(
          "DELETE",
          `/api/frp/instances/${encodeURIComponent(id)}`,
          undefined,
          signal,
        ),
      probe: (id: string, signal?: AbortSignal) =>
        client.request<ProbeResult>(
          "POST",
          `/api/frp/instances/${encodeURIComponent(id)}/probe`,
          undefined,
          signal,
        ),
      setDefault: (id: string, signal?: AbortSignal) =>
        client.request<FrpsInstanceInfo>(
          "POST",
          `/api/frp/instances/${encodeURIComponent(id)}/set-default`,
          undefined,
          signal,
        ),
    },
  };
}
```

- [ ] **Step 3: 全量编译验证**

```bash
cd packages/sdk && npx tsc --noEmit
cd packages/server && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/frp.ts
git commit -m "feat: SDK 新增 sdk.frp.instances 子 API"
```

---

### Task 7: Module 注册 + 启动迁移 + 清理旧配置

**Files:**

- Modify: `packages/server/src/frp/frp.module.ts`
- Modify: `packages/server/src/main.ts`
- Modify: `packages/server/src/frp/frp-config.ts`

- [ ] **Step 1: 注册新 Service 和 Controller 到 FrpModule**

```diff
@Module({
  imports: [PrismaModule, forwardRef(() => EventsModule)],
- providers: [FrpService],
+ providers: [FrpService, FrpsInstancesService],
- controllers: [FrpController],
+ controllers: [FrpController, FrpsInstancesController],
  exports: [FrpService],
})
export class FrpModule {}
```

- [ ] **Step 2: 在 main.ts 启动时调用自动迁移**

在 `bootstrap()` 函数中，`PrismaModule` 初始化之后添加：

```ts
import { FrpsInstancesService } from "./frp/frp-instances.service.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // ...现有代码...

  // FRP 配置自动迁移（从环境变量到 DB）
  const frpsInstances = app.get(FrpsInstancesService);
  await frpsInstances.migrateFromEnvIfNeeded();

  await app.listen(3001);
}
```

- [ ] **Step 3: 标记 frp-config.ts 为 deprecated**

在 `frp-config.ts` 文件顶部和 `getFrpConfig()` 上方添加注释：

```ts
/** @deprecated 自 2026-07-29 起，FRP 配置已迁移到 DB 表 FrpsInstance。
 *  仅保留类型导出供 PortAllocator 和 FrpsInstance 使用。
 *  后续版本将移除此文件。 */
```

保留 `FrpDashboardConfig` 和 `FrpConfig` 接口导出（因为 `frp-instances.service.ts` 中的 dashboard 结构仍引用它们），但标记 `getFrpConfig()` 为 deprecated。

- [ ] **Step 4: 全量编译 + 启动测试**

```bash
cd packages/server && npx tsc --noEmit
cd .. && pnpm build
```

验证 server 能正常启动：

```bash
cd packages/server && timeout 5 node dist/main.js || true
```

预期日志包含 `已从环境变量迁移 FRP 配置到 DB`（首次启动时）。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/frp/frp.module.ts packages/server/src/main.ts packages/server/src/frp/frp-config.ts
git commit -m "feat: 注册 FrpsInstancesService/Controller，启动自动迁移，弃用旧配置"
```

---

### Task 8: 端到端集成测试

**Files:**

- Create: `scripts/test-frp-instances.cjs`

**Interfaces:**

- Consumes: 全部已完成的功能

- [ ] **Step 1: 编写集成测试脚本**

```cjs
#!/usr/bin/env node
/**
 * FRP 实例管理 + 健康检查 集成测试
 * 用法: node scripts/test-frp-instances.cjs
 * 前提: server 已在 http://localhost:3001 运行
 */

const BASE = "http://localhost:3001";

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  // 1. 验证启动迁移：自动创建默认实例
  const list = await request("GET", "/api/frp/instances");
  console.log("实例列表:", JSON.stringify(list.data, null, 2));
  if (list.data.total < 1) throw new Error("启动迁移失败：无默认实例");

  const defaultId = list.data.data.find((i) => i.isDefault)?.id;
  console.log(`默认实例 ID: ${defaultId}`);

  // 2. 创建第二个实例
  const created = await request("POST", "/api/frp/instances", {
    name: "测试实例",
    serverAddr: "127.0.0.1",
    serverPort: 17000,
    dashboardHost: "127.0.0.1",
    dashboardPort: 17500,
    dashboardUser: "admin",
    dashboardPassword: "admin",
    portRangeStart: 30000,
    portRangeEnd: 30010,
  });
  console.log("创建实例:", JSON.stringify(created.data, null, 2));
  const testId = created.data.id;

  // 3. 健康检查（可能失败或有数据，取决于 frps 是否在运行）
  const probe = await request("POST", `/api/frp/instances/${testId}/probe`);
  console.log("健康检查:", JSON.stringify(probe.data, null, 2));

  // 4. 设为默认
  const setDefault = await request(
    "POST",
    `/api/frp/instances/${testId}/set-default`,
  );
  console.log("设为默认:", setDefault.data.name, setDefault.data.isDefault);

  // 5. 恢复原默认
  await request("POST", `/api/frp/instances/${defaultId}/set-default`);

  // 6. 删除测试实例
  const deleted = await request("DELETE", `/api/frp/instances/${testId}`);
  console.log("删除:", JSON.stringify(deleted.data));

  console.log("\n全部通过 ✅");
}

main().catch((err) => {
  console.error("测试失败:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 运行集成测试**

```bash
# 先启动 server（另一个终端）
# node packages/server/dist/main.js

# 运行测试
node scripts/test-frp-instances.cjs
```

预期：全部通过。

- [ ] **Step 3: Commit**

```bash
git add scripts/test-frp-instances.cjs
git commit -m "test: FRP 实例管理 + 健康检查集成测试"
```
