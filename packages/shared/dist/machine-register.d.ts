import { type FrpCapabilityStatus } from "./frp-runtime.js";
import type { PiCapabilityStatus } from "./pi.js";
import type { TerminalCapabilityStatus } from "./terminal.js";
/** Client 安装模式（ADR-0023：Linux A2 专用账户 + systemd 系统服务；legacy-pm2 为待迁移旧安装）。 */
export declare const MachineInstallationMode: {
    readonly SYSTEMD_ROOT_EQUIVALENT: "systemd-root-equivalent";
    readonly LEGACY_PM2: "legacy-pm2";
};
export type MachineInstallationMode = (typeof MachineInstallationMode)[keyof typeof MachineInstallationMode];
/** 严格解析后的 Client 安装模式摘要。 */
export interface MachineInstallationStatus {
    mode: MachineInstallationMode;
}
/** 非交互特权执行模式：仅 sudo-all（Q2）与 unavailable 两种。 */
export declare const PrivilegedCapabilityMode: {
    readonly SUDO_ALL: "sudo-all";
    readonly UNAVAILABLE: "unavailable";
};
export type PrivilegedCapabilityMode = (typeof PrivilegedCapabilityMode)[keyof typeof PrivilegedCapabilityMode];
/**
 * 严格解析后的 Client 非交互特权能力摘要。
 * `available && mode === "sudo-all"` 表示该 Client 可被当作 root 等价节点对待。
 * `runAsUser` 只是 OS 账户名，不含密码或令牌。
 */
export interface PrivilegedCapabilityStatus {
    available: boolean;
    mode: PrivilegedCapabilityMode;
    nonInteractive: boolean;
    runAsUser: string;
}
/** 机器注册消息（Client → Server，/client Socket.IO）。 */
export interface MachineRegister {
    clientId: string;
    hostname: string;
    os: string;
    cpuModel: string;
    totalMemMB: number;
    clientVersion: string;
    capabilities: string[];
    /** 可选：Client 能力探测结果摘要（旧 Client 缺省） */
    capabilityDetails?: {
        pi?: PiCapabilityStatus;
        terminal?: TerminalCapabilityStatus;
        frp?: FrpCapabilityStatus;
        /** 可选：非交互特权能力摘要（ADR-0023 新 Client） */
        privileged?: PrivilegedCapabilityStatus;
    };
    /** 可选：安装模式摘要（旧 Client 缺省表示未报告） */
    installation?: MachineInstallationStatus;
}
/** 严格解析安装模式摘要；未知字段拒绝。 */
export declare function parseMachineInstallation(value: unknown): MachineInstallationStatus;
/** 严格解析特权能力摘要；未知字段拒绝，runAsUser 不含密码或令牌。 */
export declare function parsePrivilegedCapabilityStatus(value: unknown): PrivilegedCapabilityStatus;
/**
 * 严格解析机器注册消息。
 * 旧 Client 省略 privileged/installation 时按“未报告”处理（字段缺省而非猜测）。
 */
export declare function parseMachineRegister(value: unknown): MachineRegister;
