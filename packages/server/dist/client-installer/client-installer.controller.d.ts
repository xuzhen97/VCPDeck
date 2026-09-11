import type { ActorContext } from "@vcpdeck/shared";
import type { Response } from "express";
import { type ClientInstallerBootstrap, type ClientInstallerConfigInfo, type ClientInstallerPreflight, ClientInstallerService } from "./client-installer.service.js";
/** Client 一键安装配置、脚本、bootstrap 与上线验收 API。 */
export declare class ClientInstallerController {
    private readonly service;
    constructor(service: ClientInstallerService);
    getConfig(): Promise<ClientInstallerConfigInfo>;
    updateConfig(raw: unknown, actor: ActorContext): Promise<ClientInstallerConfigInfo>;
    getScript(rawPlatform: string, response: Response): void;
    getAsset(name: string, response: Response): void;
    preflight(rawPlatform?: string): Promise<ClientInstallerPreflight>;
    bootstrap(raw: unknown): Promise<ClientInstallerBootstrap>;
    getClientStatus(clientId: string, _forbiddenQueryPsk: string | undefined, response: Response): Promise<{
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
    renameClient(clientId: string, raw: unknown, response: Response): Promise<import("@vcpdeck/shared").ClientInfo>;
    private toHttp;
}
