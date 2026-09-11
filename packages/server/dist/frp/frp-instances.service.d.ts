/** @file FRP 实例配置服务 — CRUD + 自动迁移 + 健康检查 */
import { PrismaService } from "../prisma/prisma.service.js";
import type { FrpsInstanceCreateRequest, FrpsInstanceUpdateRequest, FrpsInstanceInfo, PaginatedResult, ProbeResult } from "@vcpdeck/shared";
/** FRPS Dashboard 写操作确认失败。 */
export declare class FrpsDashboardError extends Error {
    readonly code: "FRPS_DASHBOARD_REQUIRED" | "FRPS_DASHBOARD_UNREACHABLE" | "FRPS_DASHBOARD_AUTH_FAILED";
    constructor(code: "FRPS_DASHBOARD_REQUIRED" | "FRPS_DASHBOARD_UNREACHABLE" | "FRPS_DASHBOARD_AUTH_FAILED", message: string);
}
export declare class FrpsInstancesService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    create(dto: FrpsInstanceCreateRequest): Promise<FrpsInstanceInfo>;
    getById(id: string): Promise<FrpsInstanceInfo | null>;
    list(page?: number, pageSize?: number): Promise<PaginatedResult<FrpsInstanceInfo>>;
    update(id: string, dto: FrpsInstanceUpdateRequest): Promise<FrpsInstanceInfo>;
    delete(id: string): Promise<boolean>;
    /** 获取默认实例 */
    getDefault(): Promise<FrpsInstanceInfo>;
    /** 设置默认实例 */
    setDefault(id: string): Promise<FrpsInstanceInfo>;
    /** 首次启动：如 DB 无任何实例，从环境变量自动迁移 */
    migrateFromEnvIfNeeded(): Promise<FrpsInstanceInfo | null>;
    /** 健康检查 */
    probe(id: string): Promise<ProbeResult>;
    /** TCP 连接检查 */
    private probeTcp;
    /** Dashboard 认证检查 */
    private probeDashboard;
    /** 严格拉取 FRPS 已注册 proxy；写操作不得把 Dashboard 失败当空列表。 */
    listDashboardProxies(instance: FrpsInstanceInfo): Promise<NonNullable<ProbeResult["proxies"]>>;
    /** 健康摘要沿用宽松语义；写操作使用 listDashboardProxies。 */
    private fetchProxyList;
    private toApi;
}
