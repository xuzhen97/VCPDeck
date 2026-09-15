"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachTunnelBridge = attachTunnelBridge;
const shared_1 = require("@vcpdeck/shared");
/** DataChannel 分片大小：TCP→DataChannel 大 chunk 切分为最多 16 KiB 二进制消息。 */
const CHUNK_BYTES = 16 * 1024;
/** DataChannel 高水位：bufferedAmount ≥ 1 MiB 时暂停 TCP 读取。 */
const HIGH_WATER_BYTES = 1024 * 1024;
/** DataChannel 低水位：onbufferedamountlow 恢复 TCP（browser 侧阈值设为 256 KiB）。 */
const LOW_WATER_BYTES = 256 * 1024;
/** DataChannel→TCP 回压上限：pending 超过 1 MiB 关闭 Session，禁止丢包。 */
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;
function toBuffer(data) {
    if (data instanceof ArrayBuffer)
        return Buffer.from(data);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
function createTunnelBridge(deps) {
    const sessions = new Map();
    function emitState(sessionId, state, code) {
        deps.emit(shared_1.Events.TUNNEL_STATE, code ? { sessionId, state, code } : { sessionId, state });
    }
    function emitSignal(sessionId, signal) {
        deps.emit(shared_1.Events.TUNNEL_SIGNAL, signal);
    }
    function wireChannel(s, channel) {
        if (s.closed) {
            try {
                channel.close();
            }
            catch {
                // 忽略
            }
            return;
        }
        s.channel = channel;
        channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
        let tcp;
        try {
            // 固定回环目标：只允许连本机 targetPort，禁止任意主机或局域网扫描。
            tcp = deps.createTcp({ host: "127.0.0.1", port: s.targetPort });
        }
        catch {
            fail(s.sessionId, "TUNNEL_TARGET_REFUSED");
            return;
        }
        s.tcp = tcp;
        channel.onopen = () => {
            if (!s.closed)
                emitState(s.sessionId, "connected");
        };
        channel.onclose = () => closeSession(s.sessionId);
        channel.onerror = () => fail(s.sessionId, "TUNNEL_DATA_ERROR");
        channel.onbufferedamountlow = () => {
            if (s.paused && s.tcp && !s.closed) {
                s.paused = false;
                s.tcp.resume();
            }
        };
        // DataChannel → TCP：write 返回 false 时累计回压，超限关闭（不丢包）。
        channel.onmessage = ({ data }) => {
            if (s.closed)
                return;
            const buf = toBuffer(data);
            const ok = tcp.write(buf);
            if (!ok)
                s.outbacklog += buf.byteLength;
            if (s.outbacklog > BACKPRESSURE_LIMIT_BYTES) {
                fail(s.sessionId, "TUNNEL_BACKPRESSURE_LIMIT");
            }
        };
        // TCP → DataChannel：大 chunk 切 16 KiB；bufferedAmount 高水位暂停，低水位恢复。
        tcp.on("data", (chunk) => {
            if (s.closed || s.paused)
                return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (channel.bufferedAmount >= HIGH_WATER_BYTES) {
                s.paused = true;
                tcp.pause();
                return;
            }
            for (let off = 0; off < buf.length; off += CHUNK_BYTES) {
                channel.send(buf.subarray(off, off + CHUNK_BYTES));
            }
        });
        tcp.on("drain", () => {
            s.outbacklog = 0;
        });
        tcp.on("error", (err) => {
            const code = err?.code === "ECONNREFUSED" ? "TUNNEL_TARGET_REFUSED" : "TUNNEL_TCP_ERROR";
            fail(s.sessionId, code);
        });
        tcp.on("close", () => closeSession(s.sessionId));
    }
    function closeSession(sessionId) {
        const s = sessions.get(sessionId);
        if (!s || s.closed)
            return;
        s.closed = true;
        try {
            s.peer.close();
        }
        catch {
            // 忽略
        }
        try {
            s.channel?.close();
        }
        catch {
            // 忽略
        }
        try {
            s.tcp?.end();
            s.tcp?.destroy();
        }
        catch {
            // 忽略
        }
        sessions.delete(sessionId);
    }
    function fail(sessionId, code) {
        emitState(sessionId, "failed", code);
        closeSession(sessionId);
    }
    const bridge = {
        protocolVersion: shared_1.P2P_TUNNEL_PROTOCOL_VERSION,
        receivePrepare(p) {
            const existing = sessions.get(p.sessionId);
            if (existing)
                closeSession(p.sessionId);
            const peer = deps.createPeer(p.iceServers);
            if (!peer) {
                // native 后端不可用：明确上报，不建立数据面。
                emitState(p.sessionId, "failed", "P2P_NATIVE_BACKEND_UNAVAILABLE");
                return;
            }
            const s = {
                sessionId: p.sessionId,
                targetPort: p.targetPort,
                peer,
                remoteSet: false,
                queuedCandidates: [],
                channel: null,
                tcp: null,
                paused: false,
                outbacklog: 0,
                closed: false,
            };
            sessions.set(p.sessionId, s);
            peer.onicecandidate = (e) => {
                if (!s.closed && e.candidate) {
                    emitSignal(p.sessionId, { sessionId: p.sessionId, candidate: e.candidate });
                }
            };
            peer.ondatachannel = (e) => wireChannel(s, e.channel);
        },
        receiveSignal(signal) {
            const s = sessions.get(signal.sessionId);
            if (!s || s.closed)
                return;
            if ("description" in signal) {
                // 客户端是 answerer：入站信令由 parseTunnelBrowserSignal(role=offer) 保证只能是 offer。
                const offer = signal.description;
                void s.peer
                    .setRemoteDescription(offer)
                    .then(async () => {
                    s.remoteSet = true;
                    const answer = await s.peer.createAnswer();
                    await s.peer.setLocalDescription(answer);
                    emitSignal(s.sessionId, { sessionId: s.sessionId, description: answer });
                    for (const c of s.queuedCandidates) {
                        try {
                            await s.peer.addIceCandidate(c);
                        }
                        catch {
                            // 单个 candidate 失败不中断
                        }
                    }
                    s.queuedCandidates = [];
                })
                    .catch(() => fail(s.sessionId, "TUNNEL_SIGNAL_FAILED"));
            }
            else {
                const c = signal.candidate;
                if (!s.remoteSet) {
                    s.queuedCandidates.push(c);
                    return;
                }
                void s.peer.addIceCandidate(c).catch(() => {
                    // 单个 candidate 失败不中断
                });
            }
        },
        receiveClose(sessionId) {
            closeSession(sessionId);
        },
        dispose() {
            for (const id of [...sessions.keys()])
                closeSession(id);
            sessions.clear();
        },
    };
    return bridge;
}
/**
 * 把 P2P 隧道桥挂到 /client socket：绑定 PREPARE/SIGNAL/CLOSE/disconnect。
 * 入站信令按 Browser 方向解析（Client 是 answerer）。返回 bridge 供 dispose。
 */
function attachTunnelBridge(socket, deps) {
    const emit = (event, payload) => {
        if (socket.connected)
            socket.emit(event, payload);
    };
    const bridge = createTunnelBridge({ ...deps, emit });
    socket.on(shared_1.Events.TUNNEL_PREPARE, (raw) => {
        try {
            const p = (0, shared_1.parseTunnelPrepare)(raw);
            if (p.clientId !== deps.clientId)
                return; // 身份绑定
            bridge.receivePrepare({ sessionId: p.sessionId, targetPort: p.targetPort, iceServers: p.iceServers });
        }
        catch {
            // 非法 payload 忽略
        }
    });
    socket.on(shared_1.Events.TUNNEL_SIGNAL, (raw) => {
        try {
            bridge.receiveSignal((0, shared_1.parseTunnelBrowserSignal)(raw));
        }
        catch {
            // 非法 payload 忽略
        }
    });
    socket.on(shared_1.Events.TUNNEL_CLOSE, (raw) => {
        try {
            bridge.receiveClose((0, shared_1.parseTunnelClose)(raw).sessionId);
        }
        catch {
            // 非法 payload 忽略
        }
    });
    socket.on("disconnect", () => bridge.dispose());
    return bridge;
}
