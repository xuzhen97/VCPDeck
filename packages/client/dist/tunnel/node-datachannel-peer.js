"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeP2pBackend = probeP2pBackend;
exports.createNodeDataChannelPeer = createNodeDataChannelPeer;
const shared_1 = require("@vcpdeck/shared");
// 用变量名引用 native 模块：tsc 不尝试解析其 d.ts（skipLibCheck 下也稳妥），运行时按字面量加载。
const NATIVE_POLYFILL_SPEC = "node-datachannel/polyfill";
let cached = null;
let loadPromise = null;
/** 延迟加载 native polyfill；失败返回 null（可重试）。 */
function loadPolyfill() {
    if (cached)
        return Promise.resolve(cached);
    if (!loadPromise) {
        loadPromise = import(NATIVE_POLYFILL_SPEC)
            .then((mod) => {
            const m = mod;
            if (typeof m.RTCPeerConnection === "function") {
                cached = { RTCPeerConnection: m.RTCPeerConnection };
                return cached;
            }
            return null;
        })
            .catch(() => null);
    }
    return loadPromise;
}
function currentPolyfill() {
    return cached;
}
/**
 * 探测 P2P native 后端可用性（加载失败 → available:false + 稳定 code）。
 * @returns 供 register 上报的能力摘要；仅含脱敏字段。
 */
async function probeP2pBackend() {
    const ok = await loadPolyfill();
    if (ok) {
        return { available: true, protocolVersion: shared_1.P2P_TUNNEL_PROTOCOL_VERSION };
    }
    return {
        available: false,
        protocolVersion: shared_1.P2P_TUNNEL_PROTOCOL_VERSION,
        code: "P2P_NATIVE_BACKEND_UNAVAILABLE",
    };
}
/**
 * 创建 answerer PeerConnection（native 未加载返回 null）。
 * 只连接固定回环目标；ICE 配置来自 Server 下发的短期凭据。
 */
function createNodeDataChannelPeer(iceServers) {
    const polyfill = currentPolyfill();
    if (!polyfill)
        return null;
    // native 构造：iceServers 与 shared TunnelIceServer 结构一致（urls/username/credential）。
    const pc = new polyfill.RTCPeerConnection({ iceServers });
    const peer = {
        setRemoteDescription: (d) => pc.setRemoteDescription(d),
        setLocalDescription: (d) => pc.setLocalDescription(d),
        createAnswer: async () => {
            const a = (await pc.createAnswer());
            return { type: "answer", sdp: a?.sdp ?? "" };
        },
        addIceCandidate: async (c) => {
            await pc.addIceCandidate(c);
        },
        close: () => {
            try {
                pc.close();
            }
            catch {
                // 忽略
            }
        },
        ondatachannel: null,
        onicecandidate: null,
    };
    // native 事件 → adapter 回调：onicecandidate 转成 { candidate, sdpMid } 形状，过滤占位 candidate。
    const pcAny = pc;
    pcAny.ondatachannel = (ev) => {
        const handler = peer.ondatachannel;
        handler?.({ channel: ev.channel });
    };
    pcAny.onicecandidate = (ev) => {
        const raw = ev.candidate;
        const handler = peer.onicecandidate;
        if (handler && raw && typeof raw.candidate === "string" && raw.candidate.length > 0 && raw.candidate !== "candidate:") {
            handler({
                candidate: {
                    candidate: raw.candidate,
                    sdpMid: typeof raw.sdpMid === "string" ? raw.sdpMid : "",
                },
            });
        }
    };
    return peer;
}
