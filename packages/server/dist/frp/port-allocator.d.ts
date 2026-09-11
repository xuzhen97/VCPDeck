/** @file 端口分配器 — DB 检查 + 可选 frps Dashboard 对账 */
import type { PrismaService } from "../prisma/prisma.service.js";
/** Dashboard 配置（由调用者传入，不再从环境变量读取） */
export interface DashboardConfig {
    scheme: "http" | "https";
    host: string;
    port: number;
    user: string;
    password: string;
}
export interface AllocateOptions {
    preferredPort?: number;
    portRangeStart?: number;
    portRangeEnd?: number;
    dashboard?: DashboardConfig | null;
    usedPorts?: Iterable<number>;
}
export declare class PortAllocator {
    private readonly prisma;
    private allocationQueue;
    constructor(prisma: PrismaService);
    /**
     * 分配一个可用端口
     * 1. 查 DB 已用端口
     * 2. 如配置了 Dashboard → 查 Dashboard 已用端口（可选，不可达时降级）
     * 3. 从范围中取第一个空闲端口
     */
    allocate(options?: AllocateOptions): Promise<number>;
    /** 释放端口（当前为 no-op，DB 删除即为释放） */
    release(_port: number): void;
    private loadUsedPorts;
    /** 串行化锁，防并发分配同一端口 */
    private withLock;
}
