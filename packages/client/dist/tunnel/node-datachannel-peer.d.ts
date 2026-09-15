import { type P2pTunnelCapabilityStatus, type TunnelIceServer } from "@vcpdeck/shared";
import type { TunnelPeer } from "./tunnel-bridge.js";
/**
 * 探测 P2P native 后端可用性（加载失败 → available:false + 稳定 code）。
 * @returns 供 register 上报的能力摘要；仅含脱敏字段。
 */
export declare function probeP2pBackend(): Promise<P2pTunnelCapabilityStatus>;
/**
 * 创建 answerer PeerConnection（native 未加载返回 null）。
 * 只连接固定回环目标；ICE 配置来自 Server 下发的短期凭据。
 */
export declare function createNodeDataChannelPeer(iceServers: TunnelIceServer[]): TunnelPeer | null;
