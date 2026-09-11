import type { ActorContext, PiAgentState, PiErrorCode, PiSessionJobSnapshot, PiStateAck, PiStateReport } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
type DeletableStatus = "idle" | "done" | "error";
/** Pi Session Job 的原子状态机与短期连接代次租约。 */
export declare class PiRunService {
    private readonly prisma;
    private readonly locks;
    private readonly settlementTimers;
    private readonly generations;
    private readonly queues;
    constructor(prisma: PrismaService);
    private lockKey;
    private settlementKey;
    private serialized;
    private requireGeneration;
    private findSession;
    private setLock;
    private releaseLock;
    /** 仅供精确 run 测试与短期编排判断。 */
    hasLock(jobId: string, runId: string): boolean;
    ensureSession(actor: ActorContext, input: {
        clientId: string;
        sessionId: string;
    }): Promise<void>;
    snapshot(sessionId: string, identityId: string): Promise<PiSessionJobSnapshot>;
    startRun(actor: ActorContext, input: {
        clientId: string;
        sessionId: string;
        projectKey: string;
    }): Promise<{
        jobId: string;
        runId: string;
    }>;
    accept(jobId: string, runId: string): Promise<boolean>;
    waitForInput(jobId: string, runId: string): Promise<boolean>;
    resume(jobId: string, runId: string): Promise<boolean>;
    finishRun(jobId: string, runId: string): Promise<boolean>;
    completeSession(jobId: string, runId?: string): Promise<boolean>;
    failSession(jobId: string, runId: string, code: PiErrorCode): Promise<boolean>;
    reconcileOpen(jobId: string, runId: string, state: PiAgentState): Promise<boolean>;
    beginDelete(jobId: string, identityId: string): Promise<{
        deleteToken: string;
        previousStatus: DeletableStatus;
        existingReservation: boolean;
    }>;
    rollbackDelete(jobId: string, deleteToken: string): Promise<boolean>;
    commitDelete(jobId: string, deleteToken: string): Promise<boolean>;
    assertSessionOwner(jobId: string, identityId: string): Promise<void>;
    assertCurrentRunOwner(jobId: string, runId: string, identityId: string): Promise<void>;
    scheduleSettlement(jobId: string, runId: string, onSettle: () => Promise<void>): Promise<void>;
    cancelSettlement(jobId: string, runId: string): void;
    markReconcilePending(clientId: string, socketId: string): Promise<void>;
    withReconciledClient<T>(clientId: string, operation: (lease: {
        clientId: string;
        socketId: string;
    }) => Promise<T>): Promise<T>;
    withReconciledSocket<T>(clientId: string, socketId: string, operation: () => Promise<T>): Promise<T>;
    reconcileGeneration(clientId: string, socketId: string, report: PiStateReport): Promise<PiStateAck>;
    /** 将不确定 dispatch 的 matching run 精确标记为断线。 */
    markRunDisconnected(jobId: string, runId: string): Promise<boolean>;
    disconnectGeneration(clientId: string, socketId: string): Promise<boolean>;
    private reconcileReport;
    assertIdleMutation(clientId: string, projectKey: string): Promise<void>;
    listAllRuns(): Promise<Array<Record<string, unknown>>>;
    listActiveByClient(clientId: string): Promise<Array<{
        jobId: string;
        runId: string;
        sessionId: string;
        status: string;
    }>>;
    private listActiveSessionJobs;
    private runTransition;
}
export {};
