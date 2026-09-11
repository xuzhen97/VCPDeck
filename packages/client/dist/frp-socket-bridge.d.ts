/** @file FRP Socket 桥 — 注册确认后上报安全 runtime 快照，严格解析状态确认并忽略旧代次 */
import type { Socket } from "socket.io-client";
import type { FrpRuntimeManager } from "./frp-runtime-manager.js";
/** FRP socket 桥依赖。 */
export interface FrpSocketBridgeDeps {
    clientId: string;
    manager: FrpRuntimeManager;
    /** 连接代次工厂（测试注入；缺省生成 UUID）。 */
    createGeneration?: () => string;
}
export interface FrpSocketBridge {
    /** socket connect 时调用：生成新 connection generation 并交给 manager，但不立即恢复。 */
    onConnected: () => void;
    /** 解绑事件订阅（不清空 manager 受信内存配置）。 */
    dispose: () => void;
}
/**
 * 绑定 FRP Socket 桥：
 * - onConnected 生成新 UUID connection generation；
 * - REGISTER ack（REGISTER 回调或兼容 "ack" 事件）后发送第一次 Events.FRP_STATE；
 * - manager 后续状态变化仅在 socket 已连接且本代次已注册时上报；
 * - ack 回调严格解析 FrpRuntimeStateAck，旧 connection generation 的 ack 忽略。
 */
export declare function attachFrpSocketBridge(socket: Socket, deps: FrpSocketBridgeDeps): FrpSocketBridge;
