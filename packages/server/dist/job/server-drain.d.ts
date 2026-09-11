import { PrismaService } from "../prisma/prisma.service.js";
export interface ServerDrainOptions {
    /** 轮询间隔（ms），默认 1000 */
    pollIntervalMs?: number;
    /** 收敛等待上限（ms），默认 10 分钟 */
    timeoutMs?: number;
}
export declare class ServerDrain {
    private readonly prisma;
    private draining;
    private readonly pollIntervalMs;
    private readonly timeoutMs;
    constructor(prisma: PrismaService, options?: ServerDrainOptions);
    /** 是否处于停机收敛中（JobScheduler 据此拒绝新派发） */
    isDraining(): boolean;
    /**
     * 置闸门并等待所有 running/waiting_input job 收敛为终态。
     * 超时抛错（不解除闸门；此时进程即将被 launcher 接管）。
     */
    drain(timeoutMs?: number): Promise<void>;
}
