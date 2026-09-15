/** 当前 P2P 隧道协议版本；仅当 Client 与 Server 均声明 v1 时能力可用。 */
export declare const P2P_TUNNEL_PROTOCOL_VERSION: 1;
/** 隧道相关的固定安全边界（字节 / 毫秒），跨运行时统一引用。 */
export declare const TunnelLimits: {
    readonly maxSdpBytes: number;
    readonly maxCandidateBytes: number;
    readonly maxCandidateMidBytes: 64;
    readonly maxIceUrlBytes: 512;
    readonly maxIceUrlsPerList: 8;
    readonly maxUsernameBytes: 255;
    readonly maxCredentialBytes: 255;
    readonly maxRealmBytes: 255;
    readonly maxSessionIdBytes: 128;
    readonly maxClientIdBytes: 128;
    readonly attachTimeoutMs: 60000;
    readonly sessionTtlMs: number;
    readonly httpResponseBytes: number;
    readonly httpTimeoutMs: 15000;
    readonly httpPathBytes: 2048;
};
/** 单个 ICE 服务器；username/credential 仅在 TURN 时存在（短期凭据）。 */
export interface TunnelIceServer {
    urls: string[];
    username?: string;
    credential?: string;
}
/** 创建临时隧道 Session 的公共请求；host 不进入协议，Client 固定连 127.0.0.1。 */
export interface TunnelSessionCreateRequest {
    clientId: string;
    targetPort: number;
}
/** 创建成功后 Server 返回给 Browser 的 Session 摘要（短期凭据，禁止缓存）。 */
export interface TunnelSessionCreated {
    sessionId: string;
    clientId: string;
    targetPort: number;
    /** Browser 必须在此 ISO 时间前 attach，否则 Session 失效。 */
    attachDeadline: string;
    iceServers: TunnelIceServer[];
}
/** 脱敏后的 ICE/coturn 配置摘要（不含 shared secret 内容）。 */
export interface TunnelConfigInfo {
    stunUrls: string[];
    turnUrls: string[];
    realm: string;
    turnSecretConfigured: boolean;
    updatedAt: string | null;
}
/** 配置更新请求；只接受非秘密字段，secret 由 VCPDECK_TURN_SECRET_FILE 提供。 */
export interface TunnelConfigUpdate {
    stunUrls: string[];
    turnUrls: string[];
    realm: string;
}
/** Browser → Server（/app）：请求把当前 Browser socket 绑定到 Session。 */
export interface TunnelBrowserAttach {
    sessionId: string;
}
/** Server → Client（/client）：为 Session 准备 PeerConnection 与目标端口。 */
export interface TunnelPrepare {
    sessionId: string;
    clientId: string;
    targetPort: number;
    iceServers: TunnelIceServer[];
}
/** SDP 描述；方向（offer/answer）由发送方角色决定。 */
export interface TunnelSdpDescription {
    type: "offer" | "answer";
    sdp: string;
}
/** 单个 trickle ICE candidate。 */
export interface TunnelIceCandidate {
    candidate: string;
    sdpMid: string;
}
/** 信令消息：description 与 candidate 二选一，均携带 sessionId。 */
export type TunnelSignal = {
    sessionId: string;
    description: TunnelSdpDescription;
} | {
    sessionId: string;
    candidate: TunnelIceCandidate;
};
/** Client → Server（/client）：上报 Session 数据面状态。 */
export interface TunnelClientState {
    sessionId: string;
    state: "connected" | "failed" | "closed";
    code?: string;
}
/** 任一侧 → Server（/app 或 /client）：请求关闭 Session（幂等）。 */
export interface TunnelClose {
    sessionId: string;
}
/** Client 上报的 P2P 隧道能力摘要。 */
export interface P2pTunnelCapabilityStatus {
    available: boolean;
    protocolVersion: typeof P2P_TUNNEL_PROTOCOL_VERSION;
    code?: "P2P_NATIVE_BACKEND_UNAVAILABLE";
}
/** 严格解析 ICE 服务器。 */
export declare function parseTunnelIceServer(value: unknown): TunnelIceServer;
/** 严格解析创建请求：仅 clientId + targetPort。 */
export declare function parseTunnelSessionCreateRequest(value: unknown): TunnelSessionCreateRequest;
/** 严格解析创建成功响应。 */
export declare function parseTunnelSessionCreated(value: unknown): TunnelSessionCreated;
/** 严格解析配置摘要（脱敏，无 secret 内容）。 */
export declare function parseTunnelConfigInfo(value: unknown): TunnelConfigInfo;
/** 严格解析配置更新请求（非秘密）。 */
export declare function parseTunnelConfigUpdate(value: unknown): TunnelConfigUpdate;
/** 严格解析 Browser 绑定消息。 */
export declare function parseTunnelBrowserAttach(value: unknown): TunnelBrowserAttach;
/** 严格解析 Server → Client 的 prepare 消息。 */
export declare function parseTunnelPrepare(value: unknown): TunnelPrepare;
/** 严格解析 Browser → Server 信令（只能发 offer 或 candidate）。 */
export declare function parseTunnelBrowserSignal(value: unknown): TunnelSignal;
/** 严格解析 Client → Server 信令（只能发 answer 或 candidate）。 */
export declare function parseTunnelClientSignal(value: unknown): TunnelSignal;
/** 严格解析 Client → Server 状态上报。 */
export declare function parseTunnelClientState(value: unknown): TunnelClientState;
/** 严格解析关闭消息。 */
export declare function parseTunnelClose(value: unknown): TunnelClose;
/** 严格解析 Client 上报的 P2P 隧道能力摘要。 */
export declare function parseP2pTunnelCapabilityStatus(value: unknown): P2pTunnelCapabilityStatus;
