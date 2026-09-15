import { type TunnelConfigInfo, type TunnelIceServer } from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
/** 隧道配置领域错误；code 稳定，statusCode 映射 HTTP。 */
export declare class TunnelConfigError extends Error {
    readonly code: string;
    readonly statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
/** 管理 P2P 隧道 ICE/coturn 配置并签发短期 TURN 凭据（secret 不落库、不外泄）。 */
export declare class TunnelConfigService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    /** 返回脱敏后的 ICE/coturn 配置摘要（不含 shared secret 内容）。 */
    get(): Promise<TunnelConfigInfo>;
    /** 保存非秘密配置字段；secret 不接受 REST 写入。 */
    update(raw: unknown): Promise<TunnelConfigInfo>;
    /**
     * 为本次 Session 签发短期 ICE 服务器：STUN（无凭据）+ 每个 TURN URL 一份 24h 凭据。
     * 缺少 TURN URL、realm 或 shared secret 时以 TUNNEL_TURN_NOT_CONFIGURED 失败。
     */
    issueIceServers(sessionId: string, now?: Date): Promise<TunnelIceServer[]>;
    private ensureRow;
    /** 读取 shared secret 文件；env 未设置、文件缺失或不可读时返回 null（视为未配置）。 */
    private readSecretFile;
    private secretConfigured;
    private requireSecret;
}
