/** @file FRP 恢复编排服务 — Server/Client/Dashboard 三方比较与有限恢复（system:frp-reconcile） */
import { type OnModuleDestroy } from "@nestjs/common";
import { type DispatchPayload, type FrpRuntimeStateAck } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { FrpsInstancesService } from "./frp-instances.service.js";
/** 定时器句柄（真实 setTimeout 句柄；测试注入环境可为 undefined）。 */
type ScheduleHandle = ReturnType<typeof setTimeout> | undefined;
/** reconcile 调度依赖（测试注入；缺省用真实 setTimeout 与 console）。 */
interface ReconcileScheduleDeps {
    /** 重试延迟（ms）：[0, 5000, 30000]（首次立即，之后 5s/30s 两个槽位）。 */
    delays?: [number, number, number];
    /** 定时器注入（测试用）；缺省使用真实 setTimeout。 */
    schedule?: (delayMs: number, run: () => void) => ScheduleHandle;
    /** 日志注入（测试用）；缺省使用 console。 */
    log?: (msg: string) => void;
    /** 双重确认有界等待预算（ms）；覆盖 frpc 建连窗口，缺省 3000。 */
    confirmWaitMs?: number;
}
export declare class FrpReconciliationService implements OnModuleDestroy {
    private readonly prisma;
    private readonly instances;
    private readonly contexts;
    private readonly leases;
    private readonly delays;
    private readonly schedule;
    private readonly log;
    private readonly confirmWaitMs;
    private dispatcher;
    constructor(prisma: PrismaService, instances: FrpsInstancesService, deps?: ReconcileScheduleDeps);
    onModuleDestroy(): void;
    /** 绑定精确 socketId 派发通道（gateway afterInit 注入）。 */
    bindDispatcher(dispatcher: (socketId: string, dispatch: DispatchPayload) => void): void;
    /** 该 Client 是否处于恢复周期（create/delete 据此稳定返回 409）。 */
    isBusy(clientId: string): boolean;
    /** create/delete 前置守卫：恢复期间拒绝写操作（FRP_RECONCILE_BUSY / 409）。 */
    assertWritable(clientId: string): void;
    /** Server 启动恢复：把中断遗留的 reconciling 映射回到 inactive（不读 Client、不创建 Job）。 */
    recoverInterrupted(): Promise<void>;
    /** 处理 Client → Server 的 FRP 状态上报；返回严格确认 ack。 */
    handleState(clientId: string, socketId: string, raw: unknown): Promise<FrpRuntimeStateAck>;
    /** 处理 frp.reconcile Job 的本地结果（严格解析；旧代次/旧 Job 忽略）。 */
    handleLocalResult(jobId: string, raw: unknown): Promise<void>;
    /** 处理 frp.reconcile Job 的 Client 侧错误（安全错误码）。 */
    handleLocalFailure(jobId: string, code: unknown): Promise<void>;
    /** Client 断开：取消 timer，只回收匹配 socket 的租约（旧 socket 清理不能终止新周期）。 */
    disconnect(clientId: string, socketId: string): void;
    private handleClientOwnedRetry;
    /** Client 在线恢复周期的终局：running 按 Dashboard 确认 active，failed 回到 inactive。 */
    private settleClientOwnedCycle;
    /** 启动 Server 独占恢复周期：创建 system Job、标记 reconciling、精确派发、排定 5s/30s 槽位。返回是否成功启动。 */
    private beginServerCycle;
    /** 派发一次 reconcile 尝试（system Job + reconciling 标记 + 精确 socket 派发）。 */
    private dispatchAttempt;
    /** 重试槽位触发：在途 Job 未结算按超时失败处理；最后槽位仍有未确认目标则耗尽周期。 */
    /**
     * 有界等待双重确认：轮询 Dashboard 至全部目标 online 或预算耗尽（缺省 3s，500ms 间隔）。
     * 覆盖 frpc→frps 登录建连窗口（10ms~数秒）；Dashboard 不可达立即返回全未确认。
     */
    private waitForConfirmation;
    /** 槽位时机按 Dashboard 复检未确认目标：online 即置 active；Dashboard 不可达则静默交由槽位既有逻辑。 */
    private recheckDashboard;
    private onRetrySlot;
    /** 重试耗尽：未确认目标回到 inactive + FRP_RECONCILE_FAILED（安全信息）。 */
    private failUnconfirmed;
    private cancelSlots;
    private cancelCycle;
    private finishCycle;
    private settleJob;
    private hasReconcileCapability;
    private extractGeneration;
}
export {};
