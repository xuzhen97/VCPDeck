/** @file FRP Runtime Manager — 管理完整映射快照、frpc 生命周期与在线崩溃有限重启 */
import type { FrpCreatePayload, FrpDeletePayload, FrpListResult, FrpReconcilePayload, FrpReconcileResult, FrpRuntimeStateReport } from "@vcpdeck/shared";
export interface FrpRuntimeManagerDeps {
    resolveExecutable: () => string | null;
    workDir: string;
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
        on: (event: string, cb: (...args: unknown[]) => void) => void;
        once: (event: string, cb: (...args: unknown[]) => void) => void;
        kill: (signal: string) => boolean;
        stdout?: {
            on: (event: string, cb: (data: Buffer) => void) => void;
        };
        stderr?: {
            on: (event: string, cb: (data: Buffer) => void) => void;
        };
    };
    writeConfigAtomically: (content: string) => void;
    delays: [number, number, number];
    /** 状态上报归属的 Client ID（由单例适配器注入真实 ID；缺省为空串）。 */
    clientId?: string;
    onState: (report: FrpRuntimeStateReport) => void;
    log: (msg: string) => void;
}
export interface FrpRuntimeManager {
    isAvailable(): boolean;
    setConnectionGeneration(value: string): void;
    getStateReport(clientId: string): FrpRuntimeStateReport;
    subscribe(listener: (report: FrpRuntimeStateReport) => void): () => void;
    reconcile(payload: FrpReconcilePayload): Promise<FrpReconcileResult>;
    create(payload: FrpCreatePayload): Promise<{
        mappingId: string;
        status: "active";
    }>;
    delete(payload: FrpDeletePayload): Promise<{
        mappingId: string;
        deleted: true;
    }>;
    list(): FrpListResult;
    shutdown(): Promise<void>;
}
export declare function createFrpRuntimeManager(deps: FrpRuntimeManagerDeps): FrpRuntimeManager;
