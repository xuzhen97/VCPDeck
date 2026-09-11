/** @file frpc 守护进程 — 单例适配器：把 FrpRuntimeManager 结果映射为 JOB_DONE，管理真实 frpc spawn 与原子 TOML 替换 */
import { type FrpCreatePayload, type FrpDeletePayload, type FrpRuntimeStateReport } from "@vcpdeck/shared";
import { type FrpRuntimeManager } from "./frp-runtime-manager.js";
type SocketLike = {
    emit: (event: string, data: unknown) => void;
};
export declare function isFrpAvailable(): boolean;
/** 获取 FRP 运行时单例（socket 桥接线用）。 */
export declare function getFrpRuntimeManager(): FrpRuntimeManager;
/** 当前 FRP 运行时安全状态快照（不含 Token/TOML/stderr）。 */
export declare function getFrpRuntimeState(clientId: string): FrpRuntimeStateReport;
/** 设置当前 socket 连接代次（每次 REGISTER 生成新 UUID 后调用）。 */
export declare function setFrpConnectionGeneration(value: string): void;
/** 订阅 FRP 运行时状态变化；返回退订函数。 */
export declare function subscribeFrpRuntimeState(listener: (report: FrpRuntimeStateReport) => void): () => void;
/** 计划内停机：取消有限重启 timer 并停止 frpc（更新/退出前调用，防误判 crash）。 */
export declare function shutdownFrpRuntime(): Promise<void>;
/** 收到 frp.create Job */
export declare function handleFrpCreate(payload: FrpCreatePayload & {
    _jobId: string;
}, socket: SocketLike): Promise<void>;
/** 收到 frp.delete Job */
export declare function handleFrpDelete(payload: FrpDeletePayload & {
    _jobId: string;
}, socket: SocketLike): Promise<void>;
/** 收到 frp.reconcile Job（严格解析 payload；Client 不在 Job 内重试） */
export declare function handleFrpReconcile(payload: {
    _jobId: string;
} & Record<string, unknown>, socket: SocketLike): Promise<void>;
/** 收到 frp.list Job */
export declare function handleFrpList(payload: {
    _jobId: string;
}, socket: SocketLike): void;
export {};
