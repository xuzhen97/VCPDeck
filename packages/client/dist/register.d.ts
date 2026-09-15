import type { MachineRegister, P2pTunnelCapabilityStatus, PiCapabilityStatus, TerminalCapabilityStatus } from "@vcpdeck/shared";
import type { RuntimeSecurityInfo } from "./privileged-capability.js";
export declare const CLIENT_ID: string;
/**
 * 构造机器注册消息。
 * @param piStatus Pi 能力探测结果（可选）
 * @param terminalStatus 终端能力探测结果（可选）
 * @param runtimeSecurity 运行时安全摘要：非交互特权能力（capabilityDetails.privileged）
 *   与安装模式（顶层 installation）；缺省不上报，不新增可执行 capability 字符串。
 */
/**
 * M1 迁移验证专用模式（VCPDECK_MIGRATION_VERIFY_ONLY=1）：
 * 注册保留身份/版本/安装/特权摘要，但不发布任何 operational 能力，
 * 使 Server 能在不下发任何工作前验证身份与运行时安全。仅 Linux A2 迁移使用，
 * 全新安装与稳态永不进入该模式。
 */
export declare function isMigrationVerifyOnly(env?: NodeJS.ProcessEnv): boolean;
export declare function getRegisterInfo(piStatus?: PiCapabilityStatus, terminalStatus?: TerminalCapabilityStatus, runtimeSecurity?: RuntimeSecurityInfo, env?: NodeJS.ProcessEnv, p2pTunnelStatus?: P2pTunnelCapabilityStatus): MachineRegister;
