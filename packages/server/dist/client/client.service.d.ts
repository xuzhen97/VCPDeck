import { PrismaService } from "../prisma/prisma.service.js";
import { type MachineRegister, type Heartbeat, type ClientInfo } from "@vcpdeck/shared";
/** 别名已被其他客户端占用（409） */
export declare const CLIENT_NAME_TAKEN = "CLIENT_NAME_TAKEN";
/** 客户端不存在（404） */
export declare const CLIENT_NOT_FOUND = "CLIENT_NOT_FOUND";
/** 别名为空（400） */
export declare const INVALID_CLIENT_NAME = "INVALID_CLIENT_NAME";
/** Client 心跳超时阈值：超过两个以上心跳周期未上报即视为离线。 */
export declare const CLIENT_HEARTBEAT_TIMEOUT_MS = 30000;
export declare class ClientService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    register(dto: MachineRegister, socketId: string): Promise<void>;
    /**
     * 生成全局唯一别名：优先 base，被占用则依次尝试 base_1、base_2 …
     * 并发注册同名机器的极小竞态由 name 唯一索引兜底（失败方下次重连自愈）。
     */
    nextAvailableName(base: string): Promise<string>;
    /** 修改别名：必须全局唯一；改名立即生效，机器下次重连不会覆盖 */
    rename(clientId: string, name: string): Promise<ClientInfo>;
    heartbeat(dto: Heartbeat): Promise<void>;
    /** 原子收敛心跳超时的 Client，返回实际成功收敛的 socket lease。 */
    expireStaleClients(now?: Date): Promise<Array<{
        clientId: string;
        socketId: string | null;
    }>>;
    /** Re-bind socketId on reconnect without overwriting machine info. */
    bindSocket(clientId: string, socketId: string): Promise<void>;
    getClientIdBySocketId(socketId: string): Promise<string | null>;
    markOfflineBySocketId(socketId: string): Promise<void>;
    listOnline(): Promise<ClientInfo[]>;
    /** 返回一键安装器所需的最小 Client 验收摘要。 */
    getInstallerStatus(clientId: string): Promise<{
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
    private toClientInfo;
    /**
     * 严格解析持久化的 capabilityDetails JSON 列。
     * 逐字段投影；损坏/未知字段省略，不宽松猜测（缺失 = 未报告，不推断为任何模式）。
     */
    private parseStoredDetails;
}
