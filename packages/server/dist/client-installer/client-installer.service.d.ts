import { type ActorContext, type ReleasePlatform } from "@vcpdeck/shared";
import { ClientService } from "../client/client.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ReleaseService } from "../release/release.service.js";
type ClientInstallerPlatform = ReleasePlatform;
export interface ClientInstallerConfigInfo {
    enabled: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
    updatedVia: string | null;
    serverVersion: string;
    releaseReady: boolean;
    platforms: Record<ReleasePlatform, {
        available: boolean;
        reasonCode?: string;
    }>;
}
export interface ClientInstallerPreflight {
    serverVersion: string;
    releaseVersion: string;
    platform: ReleasePlatform;
    archiveSize: number;
    installerUrl: string;
    installerSha256: string;
    lowLevelInstallerUrl: string;
    lowLevelInstallerSha256: string;
    nodeConstraint: string;
    nodeMirrors: string[];
    npmRegistries: string[];
}
export interface ClientInstallerBootstrap {
    serverVersion: string;
    releaseVersion: string;
    platform: ReleasePlatform;
    archiveUrl: string;
    archiveSha256: string;
    archiveSize: number;
    psk: string;
    verificationTimeoutMs: number;
}
declare const INSTALLER_ASSETS: readonly ["install-client-bootstrap.sh", "install-client-bootstrap.ps1", "install-client.cjs", "install-client-linux.cjs", "install.cjs", "uninstall-client-bootstrap.sh", "uninstall-client-bootstrap.ps1", "uninstall-client.cjs", "uninstall-client-linux.cjs"];
/** Client 安装领域错误。 */
export declare class ClientInstallerError extends Error {
    readonly code: string;
    readonly statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
/** 管理一键安装开关、目标 Release、安装资产与 Client 验收。 */
export declare class ClientInstallerService {
    private readonly prisma;
    private readonly releases;
    private readonly clients;
    constructor(prisma: PrismaService, releases: ReleaseService, clients: ClientService);
    getConfig(): Promise<ClientInstallerConfigInfo>;
    updateConfig(enabled: boolean, actor: ActorContext): Promise<ClientInstallerConfigInfo>;
    preflight(platform: ClientInstallerPlatform): Promise<ClientInstallerPreflight>;
    bootstrap(platform: ClientInstallerPlatform): Promise<ClientInstallerBootstrap>;
    readAsset(name: (typeof INSTALLER_ASSETS)[number]): Buffer;
    getClientStatus(clientId: string): Promise<{
        registered: boolean;
        online: boolean;
        clientVersion: null;
        name: null;
        hostname: null;
        capabilitiesReported: boolean;
        installationMode: null;
        nonInteractiveSudo: null;
        connectedAt: null;
        lastHeartbeatAt: null;
    } | {
        registered: boolean;
        online: boolean;
        clientVersion: string;
        name: string;
        hostname: string;
        capabilitiesReported: boolean;
        installationMode: import("@vcpdeck/shared").MachineInstallationMode | null;
        nonInteractiveSudo: boolean | null;
        connectedAt: string | null;
        lastHeartbeatAt: string | null;
    }>;
    renameClient(clientId: string, name: string): Promise<import("@vcpdeck/shared").ClientInfo>;
    assertPsk(value: string | undefined): void;
    private requireReadyRelease;
    private requireEnabled;
    private ensureConfig;
    private platformStatus;
}
/** 定位随 Server 发布或仓库开发环境提供的安装资产目录。 */
export declare function installerAssetsDir(): string;
export {};
