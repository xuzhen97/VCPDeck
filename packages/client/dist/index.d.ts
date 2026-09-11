import { type Socket } from "socket.io-client";
import type { MachineRegister, PiCapabilityStatus, StatusReport, TerminalCapabilityStatus } from "@vcpdeck/shared";
import { type PiSupervisor } from "./pi/supervisor.js";
import { type RuntimeSecurityInfo } from "./privileged-capability.js";
/**
 * M1 迁移验证专用模式（仅 Linux A2 迁移由安装器设置，全新安装/稳态永不进入）：
 * Client 仍执行 REGISTER 与心跳供 Server 验证身份/版本/安装/特权，
 * 但不挂载任何 operational 处理器（Job dispatch/cancel、Files、Terminal、Pi、FRP），
 * 使迁移失败回退前不产生任何业务副作用。
 */
export declare function isMigrationVerifyOnly(env?: NodeJS.ProcessEnv): boolean;
export interface PiBridgeDeps {
    clientId: string;
    supervisor: PiSupervisor;
    getPiStatus: () => Promise<PiCapabilityStatus>;
    getTerminalStatus: () => Promise<TerminalCapabilityStatus>;
    /** 运行时安全摘要：非交互特权探测 + 安装模式；每次连接探测一次，失败降级为未报告。 */
    getRuntimeSecurity: () => Promise<RuntimeSecurityInfo | undefined>;
    getRegister: (piStatus: PiCapabilityStatus | undefined, terminalStatus: TerminalCapabilityStatus | undefined, runtimeSecurity: RuntimeSecurityInfo | undefined) => MachineRegister;
    getStatusReport: () => StatusReport;
}
export interface PiBridge {
    /** connect handler 中调用：探测 → REGISTER(ack) → STATUS_REPORT + PI_STATE */
    onConnected: () => Promise<void>;
}
/**
 * 绑定 Pi Socket 桥：PI_REQUEST 响应、PI_EVENT 转发、注册后状态上报。
 * Server 完成 register 后通过 ack callback 或现有 "ack" event 通知。
 */
export declare function attachPiBridge(socket: Socket, deps: PiBridgeDeps, opts?: {
    verifyOnly?: boolean;
}): PiBridge;
export declare function connect(): Socket;
