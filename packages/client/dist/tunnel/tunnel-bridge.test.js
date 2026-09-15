"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_buffer_1 = require("node:buffer");
const shared_1 = require("@vcpdeck/shared");
const tunnel_bridge_js_1 = require("./tunnel-bridge.js");
function makeSocket() {
    return {
        connected: true,
        emit: vitest_1.vi.fn(),
        on: vitest_1.vi.fn(),
        disconnect: vitest_1.vi.fn(),
        data: {},
    };
}
// 测试 fake：真实对象（推断类型，闭包而非 `this` 承载 vi.fn 实现），只在传入 bridge 时按接口 cast。
function makePeer() {
    const peer = {
        setRemoteDescription: vitest_1.vi.fn(async () => { }),
        setLocalDescription: vitest_1.vi.fn(async () => { }),
        createAnswer: vitest_1.vi.fn(async () => ({ type: "answer", sdp: "v=0-answer" })),
        addIceCandidate: vitest_1.vi.fn(async () => { }),
        close: vitest_1.vi.fn(),
        ondatachannel: null,
        onicecandidate: null,
        emitDataChannel(channel) {
            this.ondatachannel?.({ channel });
        },
        emitIceCandidate(candidate) {
            this.onicecandidate?.({ candidate });
        },
    };
    return peer;
}
function makeChannel() {
    const channel = {
        sentBinary: [],
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        onbufferedamountlow: null,
        send(data) {
            this.sentBinary.push(data);
        },
        close: vitest_1.vi.fn(),
        emitOpen() {
            this.onopen?.();
        },
        emitMessage(data) {
            this.onmessage?.({ data });
        },
        emitClose() {
            this.onclose?.();
        },
        emitError() {
            this.onerror?.();
        },
        emitBufferedAmountLow() {
            this.onbufferedamountlow?.();
        },
    };
    return channel;
}
function makeTcp() {
    const listeners = {
        data: [],
        drain: [],
        error: [],
        close: [],
    };
    const writes = [];
    const tcp = {
        writes,
        pause: vitest_1.vi.fn(),
        resume: vitest_1.vi.fn(),
        end: vitest_1.vi.fn(),
        destroy: vitest_1.vi.fn(),
        write: vitest_1.vi.fn((d) => {
            writes.push(d);
            return true;
        }),
        on(ev, cb) {
            listeners[ev].push(cb);
        },
        emitData(d) {
            listeners.data.forEach((l) => l(d));
        },
        emitDrain() {
            listeners.drain.forEach((l) => l());
        },
        emitError(err) {
            listeners.error.forEach((l) => l(err));
        },
        emitClose() {
            listeners.close.forEach((l) => l());
        },
    };
    return tcp;
}
function setup() {
    const socket = makeSocket();
    const peer = makePeer();
    const channel = makeChannel();
    const tcp = makeTcp();
    const createPeer = vitest_1.vi.fn((_ice) => peer);
    const connectTcp = vitest_1.vi.fn((_t) => tcp);
    const bridge = (0, tunnel_bridge_js_1.attachTunnelBridge)(socket, {
        clientId: "c1",
        createPeer,
        createTcp: connectTcp,
    });
    return { socket, peer, channel, tcp, createPeer, connectTcp, bridge };
}
(0, vitest_1.describe)("TunnelBridge 回环 TCP 数据泵", () => {
    (0, vitest_1.it)("始终连接 127.0.0.1 并保持双向二进制顺序", () => {
        const { peer, channel, tcp, connectTcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        channel.emitOpen();
        (0, vitest_1.expect)(connectTcp).toHaveBeenCalledWith({ host: "127.0.0.1", port: 3000 });
        tcp.emitData(node_buffer_1.Buffer.from([1, 2]));
        tcp.emitData(node_buffer_1.Buffer.from([3, 4]));
        (0, vitest_1.expect)(channel.sentBinary).toEqual([node_buffer_1.Buffer.from([1, 2]), node_buffer_1.Buffer.from([3, 4])]);
        channel.emitMessage(node_buffer_1.Buffer.from([5, 6]));
        (0, vitest_1.expect)(tcp.writes).toEqual([node_buffer_1.Buffer.from([5, 6])]);
    });
    (0, vitest_1.it)("TCP→DataChannel 大 chunk 切分为 16 KiB 二进制消息", () => {
        const { peer, channel, tcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        tcp.emitData(node_buffer_1.Buffer.alloc(40 * 1024));
        // 40KiB → 3 片：16KiB + 16KiB + 8KiB
        (0, vitest_1.expect)(channel.sentBinary.length).toBe(3);
        (0, vitest_1.expect)(channel.sentBinary[0].length).toBe(16 * 1024);
        (0, vitest_1.expect)(channel.sentBinary[1].length).toBe(16 * 1024);
        (0, vitest_1.expect)(channel.sentBinary[2].length).toBe(8 * 1024);
    });
    (0, vitest_1.it)("DataChannel 高水位暂停 TCP，低水位恢复", () => {
        const { peer, channel, tcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        channel.bufferedAmount = 1024 * 1024;
        tcp.emitData(node_buffer_1.Buffer.alloc(16 * 1024));
        (0, vitest_1.expect)(tcp.pause).toHaveBeenCalled();
        (0, vitest_1.expect)(channel.sentBinary).toHaveLength(0);
        channel.emitBufferedAmountLow();
        (0, vitest_1.expect)(tcp.resume).toHaveBeenCalled();
    });
    (0, vitest_1.it)("TCP 写入回压超过 1 MiB 关闭 Session 并上报（不丢包）", () => {
        const { socket, peer, channel, tcp, bridge } = setup();
        tcp.write.mockReturnValue(false);
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        channel.emitMessage(node_buffer_1.Buffer.alloc(1024 * 1024 + 1));
        (0, vitest_1.expect)(socket.emit).toHaveBeenCalledWith(shared_1.Events.TUNNEL_STATE, vitest_1.expect.objectContaining({ state: "failed", code: "TUNNEL_BACKPRESSURE_LIMIT" }));
        (0, vitest_1.expect)(peer.close).toHaveBeenCalled();
    });
    (0, vitest_1.it)("candidate 在 remote description 前排队，offer 到达后补发", async () => {
        const { peer, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        bridge.receiveSignal({ sessionId: "tn_1", candidate: { candidate: "candidate:1", sdpMid: "0" } });
        (0, vitest_1.expect)(peer.addIceCandidate).not.toHaveBeenCalled();
        bridge.receiveSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0-offer" } });
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(peer.addIceCandidate).toHaveBeenCalled());
        (0, vitest_1.expect)(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: "candidate:1", sdpMid: "0" });
    });
    (0, vitest_1.it)("offer 到达后回传 answer 信令", async () => {
        const { socket, peer, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        bridge.receiveSignal({ sessionId: "tn_1", description: { type: "offer", sdp: "v=0-offer" } });
        await vitest_1.vi.waitFor(() => (0, vitest_1.expect)(socket.emit).toHaveBeenCalledWith(shared_1.Events.TUNNEL_SIGNAL, vitest_1.expect.objectContaining({ description: vitest_1.expect.objectContaining({ type: "answer" }) })));
        (0, vitest_1.expect)(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "v=0-offer" });
    });
    (0, vitest_1.it)("TCP ECONNREFUSED 映射 TUNNEL_TARGET_REFUSED", () => {
        const { socket, peer, channel, tcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        tcp.emitError({ code: "ECONNREFUSED" });
        (0, vitest_1.expect)(socket.emit).toHaveBeenCalledWith(shared_1.Events.TUNNEL_STATE, vitest_1.expect.objectContaining({ state: "failed", code: "TUNNEL_TARGET_REFUSED" }));
        (0, vitest_1.expect)(peer.close).toHaveBeenCalled();
    });
    (0, vitest_1.it)("native 后端不可用时上报 P2P_NATIVE_BACKEND_UNAVAILABLE 且不建数据面", () => {
        const socket = makeSocket();
        const connectTcp = vitest_1.vi.fn((_t) => null);
        const bridge = (0, tunnel_bridge_js_1.attachTunnelBridge)(socket, {
            clientId: "c1",
            createPeer: vitest_1.vi.fn((_ice) => null),
            createTcp: connectTcp,
        });
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        (0, vitest_1.expect)(socket.emit).toHaveBeenCalledWith(shared_1.Events.TUNNEL_STATE, vitest_1.expect.objectContaining({ state: "failed", code: "P2P_NATIVE_BACKEND_UNAVAILABLE" }));
        (0, vitest_1.expect)(connectTcp).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("close 幂等：重复 close 只清理一次", () => {
        const { peer, channel, tcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        bridge.receiveClose("tn_1");
        (0, vitest_1.expect)(peer.close).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(tcp.end).toHaveBeenCalled();
        bridge.receiveClose("tn_1");
        (0, vitest_1.expect)(peer.close).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("dispose 关闭所有 Session（peer/tcp/channel）", () => {
        const { peer, channel, tcp, bridge } = setup();
        bridge.receivePrepare({ sessionId: "tn_1", targetPort: 3000, iceServers: [] });
        peer.emitDataChannel(channel);
        bridge.dispose();
        (0, vitest_1.expect)(peer.close).toHaveBeenCalled();
        (0, vitest_1.expect)(channel.close).toHaveBeenCalled();
        (0, vitest_1.expect)(tcp.end).toHaveBeenCalled();
    });
});
