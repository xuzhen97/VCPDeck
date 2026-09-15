import { type TunnelIceServer, type TunnelSignal } from "@vcpdeck/shared";
/** 回环 TCP 目标；bridge 固定 host 为 127.0.0.1，只透传端口。 */
export interface TunnelTcpTarget {
    host: string;
    port: number;
}
import type { Socket } from "socket.io-client";
/** 最小 DataChannel 接口：与 Browser WebRTC 与 node-datachannel polyfill 对齐。 */
export interface TunnelDataChannel {
    send(data: Uint8Array): void;
    close(): void;
    readonly bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    onopen: (() => void) | null;
    onmessage: ((event: {
        data: ArrayBuffer | Uint8Array;
    }) => void) | null;
    onclose: (() => void) | null;
    onerror: ((event?: unknown) => void) | null;
    onbufferedamountlow: (() => void) | null;
}
/** 最小 answerer 端 PeerConnection 接口（Client 只应答，不发起 offer）。 */
export interface TunnelPeer {
    setRemoteDescription(desc: {
        type: "offer";
        sdp: string;
    }): Promise<void>;
    setLocalDescription(desc: {
        type: "answer";
        sdp: string;
    }): Promise<void>;
    createAnswer(): Promise<{
        type: "answer";
        sdp: string;
    }>;
    addIceCandidate(candidate: {
        candidate: string;
        sdpMid: string;
    }): Promise<void>;
    close(): void;
    ondatachannel: ((event: {
        channel: TunnelDataChannel;
    }) => void) | null;
    onicecandidate: ((event: {
        candidate: {
            candidate: string;
            sdpMid: string;
        } | null;
    }) => void) | null;
}
/** 最小回环 TCP socket 接口（node:net.Socket 天然满足；测试注入 fake）。 */
export interface TunnelTcpSocket {
    write(data: Uint8Array, cb?: () => void): boolean;
    pause(): void;
    resume(): void;
    end(): void;
    destroy(): void;
    on(event: "data", cb: (chunk: Uint8Array) => void): unknown;
    on(event: "drain", cb: () => void): unknown;
    on(event: "error", cb: (err: {
        code?: string;
    }) => void): unknown;
    on(event: "close", cb: () => void): unknown;
}
export interface TunnelBridgeDeps {
    clientId: string;
    /** 创建 answerer Peer；native 加载失败返回 null（不上报能力）。 */
    createPeer: (iceServers: TunnelIceServer[]) => TunnelPeer | null;
    /** 建立固定回环 TCP 连接；host 由 bridge 固定为 127.0.0.1。 */
    createTcp: (target: TunnelTcpTarget) => TunnelTcpSocket;
    /** 精确 emit 到 Server（socket lease）；生产绑定 socket.emit。 */
    emit: (event: string, payload: unknown) => void;
}
/** 可测试的 P2P 隧道桥：Session 生命周期 + 信令 + 回环 TCP 数据泵。 */
export interface TunnelBridge {
    receivePrepare(p: {
        sessionId: string;
        targetPort: number;
        iceServers: TunnelIceServer[];
    }): void;
    receiveSignal(signal: TunnelSignal): void;
    receiveClose(sessionId: string): void;
    dispose(): void;
    readonly protocolVersion: number;
}
/**
 * 把 P2P 隧道桥挂到 /client socket：绑定 PREPARE/SIGNAL/CLOSE/disconnect。
 * 入站信令按 Browser 方向解析（Client 是 answerer）。返回 bridge 供 dispose。
 */
export declare function attachTunnelBridge(socket: Socket, deps: Omit<TunnelBridgeDeps, "emit">): TunnelBridge;
