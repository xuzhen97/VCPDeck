import type { MachineInstallationStatus, PrivilegedCapabilityStatus } from "@vcpdeck/shared";
/** 特权能力探测的可注入环境（默认取真实进程环境；测试可整体替换，不触达系统）。 */
export interface PrivilegedProbeEnv {
    readonly platform: NodeJS.Platform;
    readonly currentUser: () => string;
    readonly runNonInteractiveSudo: () => Promise<number>;
}
/** 安装模式探测的可注入环境。 */
export interface InstallationProbeEnv {
    readonly platform: NodeJS.Platform;
    readonly installationMode?: string;
}
/** 注册时上报的运行时安全摘要（特权能力 + 安装模式）。 */
export interface RuntimeSecurityInfo {
    privileged?: PrivilegedCapabilityStatus;
    installation?: MachineInstallationStatus;
}
/**
 * 探测当前运行账户是否具备免密非交互 sudo（仅 Linux；非 Linux 返回 undefined 表示未报告）。
 * 成功（`sudo -n true` 退出码 0）→ sudo-all 可用；失败/超时/异常 → unavailable，失败关闭。
 */
export declare function probePrivilegedCapability(env?: PrivilegedProbeEnv): Promise<PrivilegedCapabilityStatus | undefined>;
/**
 * 探测 Client 安装模式（仅 Linux；Windows 返回 undefined 表示未报告，保持原 PM2 语义）。
 * A2 安装通过 `VCPDECK_INSTALLATION_MODE=systemd-root-equivalent` 声明；其余 Linux 视为待迁移 legacy-pm2。
 */
export declare function detectInstallationInfo(env?: InstallationProbeEnv): MachineInstallationStatus | undefined;
