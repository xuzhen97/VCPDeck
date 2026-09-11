/** Client 一键安装支持的平台。 */
export type ClientInstallerPlatform = "win-x64" | "linux-x64";
/** Client 一键安装稳定错误码。 */
export declare const ClientInstallerErrorCode: {
    readonly DISABLED: "CLIENT_INSTALLER_DISABLED";
    readonly RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY";
    readonly ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING";
    readonly PLATFORM_UNSUPPORTED: "CLIENT_INSTALLER_PLATFORM_UNSUPPORTED";
    readonly ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING";
    readonly PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID";
    readonly CLIENT_NOT_FOUND: "CLIENT_INSTALLER_CLIENT_NOT_FOUND";
};
export type ClientInstallerErrorCode = (typeof ClientInstallerErrorCode)[keyof typeof ClientInstallerErrorCode];
/** 单个平台的一键安装就绪状态。 */
export interface ClientInstallerPlatformStatus {
    available: boolean;
    reasonCode?: ClientInstallerErrorCode;
}
/** 认证用户读取的一键安装配置。 */
export interface ClientInstallerConfigInfo {
    enabled: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
    updatedVia: string | null;
    serverVersion: string;
    releaseReady: boolean;
    platforms: Record<ClientInstallerPlatform, ClientInstallerPlatformStatus>;
}
/** 安装引导器所需的公开、非秘密信息。 */
export interface ClientInstallerPreflight {
    serverVersion: string;
    releaseVersion: string;
    platform: ClientInstallerPlatform;
    archiveSize: number;
    installerUrl: string;
    installerSha256: string;
    lowLevelInstallerUrl: string;
    lowLevelInstallerSha256: string;
    nodeConstraint: string;
    nodeMirrors: string[];
    npmRegistries: string[];
}
/** 启用安装入口后返回的秘密 bootstrap 信息。 */
export interface ClientInstallerBootstrap {
    serverVersion: string;
    releaseVersion: string;
    platform: ClientInstallerPlatform;
    archiveUrl: string;
    archiveSha256: string;
    archiveSize: number;
    psk: string;
    verificationTimeoutMs: number;
}
/** Server 对目标 Client 的安装验收摘要。 */
export interface ClientInstallerClientStatus {
    registered: boolean;
    online: boolean;
    clientVersion: string | null;
    name: string | null;
    hostname: string | null;
    capabilitiesReported: boolean;
    /** 安装模式（旧 Client 未报告时为 null） */
    installationMode: MachineInstallationMode | null;
    /** 非交互 sudo 是否可用（旧 Client 未报告时为 null） */
    nonInteractiveSudo: boolean | null;
    connectedAt: string | null;
    lastHeartbeatAt: string | null;
}
import type { MachineInstallationMode } from "./machine-register.js";
/** 严格解析安装平台。 */
export declare function parseClientInstallerPlatform(value: unknown): ClientInstallerPlatform;
/** 严格解析开关更新请求。 */
export declare function parseClientInstallerConfigUpdate(value: unknown): {
    enabled: boolean;
};
/** 严格解析 Client 显示名称更新。 */
export declare function parseClientInstallerNameUpdate(value: unknown): {
    name: string;
};
