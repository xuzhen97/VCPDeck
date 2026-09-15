import type { ActorContext, TunnelConfigInfo, TunnelSessionCreated } from "@vcpdeck/shared";
import { TunnelConfigService } from "./tunnel-config.service.js";
import { TunnelSessionService } from "./tunnel-session.service.js";
/** P2P 隧道 REST 控制面：ICE 配置 + 临时 Session 创建/关闭。 */
export declare class TunnelController {
    private readonly config;
    private readonly sessions;
    constructor(config: TunnelConfigService, sessions: TunnelSessionService);
    getConfig(): Promise<TunnelConfigInfo>;
    updateConfig(raw: unknown): Promise<TunnelConfigInfo>;
    create(raw: unknown, actor: ActorContext): Promise<TunnelSessionCreated>;
    close(sessionId: string, actor: ActorContext): Promise<{
        closed: true;
    }>;
    private guarded;
    private toHttp;
}
