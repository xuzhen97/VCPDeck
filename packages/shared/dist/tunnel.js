"use strict";
// ── P2P TCP Tunnel 协议（ADR-0026）：浏览器 ↔ Client 的 WebRTC DataChannel 回环 TCP 隧道 ──
Object.defineProperty(exports, "__esModule", { value: true });
exports.TunnelLimits = exports.P2P_TUNNEL_PROTOCOL_VERSION = void 0;
exports.parseTunnelIceServer = parseTunnelIceServer;
exports.parseTunnelSessionCreateRequest = parseTunnelSessionCreateRequest;
exports.parseTunnelSessionCreated = parseTunnelSessionCreated;
exports.parseTunnelConfigInfo = parseTunnelConfigInfo;
exports.parseTunnelConfigUpdate = parseTunnelConfigUpdate;
exports.parseTunnelBrowserAttach = parseTunnelBrowserAttach;
exports.parseTunnelPrepare = parseTunnelPrepare;
exports.parseTunnelBrowserSignal = parseTunnelBrowserSignal;
exports.parseTunnelClientSignal = parseTunnelClientSignal;
exports.parseTunnelClientState = parseTunnelClientState;
exports.parseTunnelClose = parseTunnelClose;
exports.parseP2pTunnelCapabilityStatus = parseP2pTunnelCapabilityStatus;
/** 当前 P2P 隧道协议版本；仅当 Client 与 Server 均声明 v1 时能力可用。 */
exports.P2P_TUNNEL_PROTOCOL_VERSION = 1;
/** 隧道相关的固定安全边界（字节 / 毫秒），跨运行时统一引用。 */
exports.TunnelLimits = {
    maxSdpBytes: 128 * 1024,
    maxCandidateBytes: 8 * 1024,
    maxCandidateMidBytes: 64,
    maxIceUrlBytes: 512,
    maxIceUrlsPerList: 8,
    maxUsernameBytes: 255,
    maxCredentialBytes: 255,
    maxRealmBytes: 255,
    maxSessionIdBytes: 128,
    maxClientIdBytes: 128,
    attachTimeoutMs: 60_000,
    sessionTtlMs: 24 * 60 * 60 * 1000,
    httpResponseBytes: 1024 * 1024,
    httpTimeoutMs: 15_000,
    httpPathBytes: 2048,
};
const STUN_SCHEMES = ["stun", "stuns"];
const TURN_SCHEMES = ["turn", "turns"];
// ── 内部解析辅助 ──
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, field, maxLength, minLength = 1) {
    if (typeof value !== "string" || value.length < minLength || value.length > maxLength) {
        throw new Error(`${field} 必须为长度 ${minLength}-${maxLength} 的字符串`);
    }
    return value;
}
function requirePort(value, field) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${field} 必须是 1–65535 的整数`);
    }
    return value;
}
function requireBoolean(value, field) {
    if (typeof value !== "boolean") {
        throw new Error(`${field} 必须是布尔值`);
    }
    return value;
}
function assertKeys(input, allowed, field) {
    for (const key of Object.keys(input)) {
        if (!allowed.includes(key)) {
            throw new Error(`${field} 含未知字段 ${key}`);
        }
    }
}
function hasControlChar(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}
/** 严格校验单条 STUN/TURN URL：scheme 白名单、无 userinfo、无控制字符、长度上限。 */
function requireIceUrl(value, field, allowedSchemes) {
    if (typeof value !== "string" ||
        value.length < 1 ||
        value.length > exports.TunnelLimits.maxIceUrlBytes) {
        throw new Error(`${field} 必须为长度 1-${exports.TunnelLimits.maxIceUrlBytes} 的字符串`);
    }
    if (hasControlChar(value)) {
        throw new Error(`${field} 含控制字符`);
    }
    const sep = value.indexOf(":");
    if (sep <= 0) {
        throw new Error(`${field} scheme 无效`);
    }
    const scheme = value.slice(0, sep);
    if (!allowedSchemes.includes(scheme)) {
        throw new Error(`${field} scheme 必须为 ${allowedSchemes.join("/")}`);
    }
    if (value.includes("@")) {
        throw new Error(`${field} 含用户信息`);
    }
    return value;
}
function parseIceUrlList(value, field, allowedSchemes, minLength = 0) {
    if (!Array.isArray(value) ||
        value.length < minLength ||
        value.length > exports.TunnelLimits.maxIceUrlsPerList) {
        throw new Error(`${field} 必须为长度 ${minLength}-${exports.TunnelLimits.maxIceUrlsPerList} 的数组`);
    }
    return value.map((item, i) => requireIceUrl(item, `${field}[${i}]`, allowedSchemes));
}
// ── 严格 parser ──
/** 严格解析 ICE 服务器。 */
function parseTunnelIceServer(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("iceServer 必须为对象");
    assertKeys(input, ["urls", "username", "credential"], "iceServer");
    const result = {
        urls: parseIceUrlList(input.urls, "urls", [...STUN_SCHEMES, ...TURN_SCHEMES], 1),
    };
    if (input.username !== undefined) {
        result.username = requireString(input.username, "username", exports.TunnelLimits.maxUsernameBytes);
    }
    if (input.credential !== undefined) {
        result.credential = requireString(input.credential, "credential", exports.TunnelLimits.maxCredentialBytes);
    }
    return result;
}
function parseIceServers(value, field) {
    if (!Array.isArray(value) || value.length > exports.TunnelLimits.maxIceUrlsPerList) {
        throw new Error(`${field} 必须为长度 0-${exports.TunnelLimits.maxIceUrlsPerList} 的数组`);
    }
    return value.map((item, i) => parseTunnelIceServer(item));
}
/** 严格解析创建请求：仅 clientId + targetPort。 */
function parseTunnelSessionCreateRequest(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("createRequest 必须为对象");
    assertKeys(input, ["clientId", "targetPort"], "createRequest");
    return {
        clientId: requireString(input.clientId, "clientId", exports.TunnelLimits.maxClientIdBytes),
        targetPort: requirePort(input.targetPort, "targetPort"),
    };
}
function requireIsoTimestamp(value, field) {
    const s = requireString(value, field, 64);
    if (Number.isNaN(Date.parse(s))) {
        throw new Error(`${field} 必须为合法 ISO 时间戳`);
    }
    return s;
}
/** 严格解析创建成功响应。 */
function parseTunnelSessionCreated(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("sessionCreated 必须为对象");
    assertKeys(input, ["sessionId", "clientId", "targetPort", "attachDeadline", "iceServers"], "sessionCreated");
    return {
        sessionId: requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes),
        clientId: requireString(input.clientId, "clientId", exports.TunnelLimits.maxClientIdBytes),
        targetPort: requirePort(input.targetPort, "targetPort"),
        attachDeadline: requireIsoTimestamp(input.attachDeadline, "attachDeadline"),
        iceServers: parseIceServers(input.iceServers, "iceServers"),
    };
}
/** 严格解析配置摘要（脱敏，无 secret 内容）。 */
function parseTunnelConfigInfo(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("configInfo 必须为对象");
    assertKeys(input, ["stunUrls", "turnUrls", "realm", "turnSecretConfigured", "updatedAt"], "configInfo");
    return {
        stunUrls: parseIceUrlList(input.stunUrls, "stunUrls", STUN_SCHEMES),
        turnUrls: parseIceUrlList(input.turnUrls, "turnUrls", TURN_SCHEMES),
        realm: requireString(input.realm, "realm", exports.TunnelLimits.maxRealmBytes, 0),
        turnSecretConfigured: requireBoolean(input.turnSecretConfigured, "turnSecretConfigured"),
        updatedAt: input.updatedAt === null
            ? null
            : requireIsoTimestamp(input.updatedAt, "updatedAt"),
    };
}
/** 严格解析配置更新请求（非秘密）。 */
function parseTunnelConfigUpdate(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("configUpdate 必须为对象");
    assertKeys(input, ["stunUrls", "turnUrls", "realm"], "configUpdate");
    return {
        stunUrls: parseIceUrlList(input.stunUrls, "stunUrls", STUN_SCHEMES),
        turnUrls: parseIceUrlList(input.turnUrls, "turnUrls", TURN_SCHEMES),
        realm: requireString(input.realm, "realm", exports.TunnelLimits.maxRealmBytes, 0),
    };
}
/** 严格解析 Browser 绑定消息。 */
function parseTunnelBrowserAttach(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("browserAttach 必须为对象");
    assertKeys(input, ["sessionId"], "browserAttach");
    return {
        sessionId: requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes),
    };
}
/** 严格解析 Server → Client 的 prepare 消息。 */
function parseTunnelPrepare(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("prepare 必须为对象");
    assertKeys(input, ["sessionId", "clientId", "targetPort", "iceServers"], "prepare");
    return {
        sessionId: requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes),
        clientId: requireString(input.clientId, "clientId", exports.TunnelLimits.maxClientIdBytes),
        targetPort: requirePort(input.targetPort, "targetPort"),
        iceServers: parseIceServers(input.iceServers, "iceServers"),
    };
}
function parseDescription(value, field, role) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error(`${field} 必须为对象`);
    assertKeys(input, ["type", "sdp"], field);
    const type = input.type;
    if (type !== "offer" && type !== "answer") {
        throw new Error(`${field}.type 必须为 offer 或 answer`);
    }
    if (type !== role) {
        throw new Error(`${field}.type 必须为 ${role}`);
    }
    return {
        type,
        sdp: requireString(input.sdp, `${field}.sdp`, exports.TunnelLimits.maxSdpBytes),
    };
}
function parseCandidate(value, field) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error(`${field} 必须为对象`);
    assertKeys(input, ["candidate", "sdpMid"], field);
    return {
        candidate: requireString(input.candidate, `${field}.candidate`, exports.TunnelLimits.maxCandidateBytes),
        sdpMid: requireString(input.sdpMid, `${field}.sdpMid`, exports.TunnelLimits.maxCandidateMidBytes),
    };
}
function parseSignal(value, role) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("signal 必须为对象");
    assertKeys(input, ["sessionId", "description", "candidate"], "signal");
    const sessionId = requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes);
    const hasDescription = input.description !== undefined;
    const hasCandidate = input.candidate !== undefined;
    if (hasDescription === hasCandidate) {
        throw new Error("signal 必须且只能含 description 或 candidate 之一");
    }
    if (hasDescription) {
        return { sessionId, description: parseDescription(input.description, "description", role) };
    }
    return { sessionId, candidate: parseCandidate(input.candidate, "candidate") };
}
/** 严格解析 Browser → Server 信令（只能发 offer 或 candidate）。 */
function parseTunnelBrowserSignal(value) {
    return parseSignal(value, "offer");
}
/** 严格解析 Client → Server 信令（只能发 answer 或 candidate）。 */
function parseTunnelClientSignal(value) {
    return parseSignal(value, "answer");
}
/** 严格解析 Client → Server 状态上报。 */
function parseTunnelClientState(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("clientState 必须为对象");
    assertKeys(input, ["sessionId", "state", "code"], "clientState");
    const state = input.state;
    if (state !== "connected" && state !== "failed" && state !== "closed") {
        throw new Error("state 必须为 connected、failed 或 closed");
    }
    const result = {
        sessionId: requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes),
        state,
    };
    if (input.code !== undefined) {
        result.code = requireString(input.code, "code", 128);
    }
    return result;
}
/** 严格解析关闭消息。 */
function parseTunnelClose(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("close 必须为对象");
    assertKeys(input, ["sessionId"], "close");
    return {
        sessionId: requireString(input.sessionId, "sessionId", exports.TunnelLimits.maxSessionIdBytes),
    };
}
/** 严格解析 Client 上报的 P2P 隧道能力摘要。 */
function parseP2pTunnelCapabilityStatus(value) {
    const input = isRecord(value) ? value : null;
    if (!input)
        throw new Error("p2pTunnel 必须为对象");
    assertKeys(input, ["available", "protocolVersion", "code"], "p2pTunnel");
    const available = requireBoolean(input.available, "available");
    if (input.protocolVersion !== exports.P2P_TUNNEL_PROTOCOL_VERSION) {
        throw new Error("protocolVersion 必须是 1");
    }
    const result = {
        available,
        protocolVersion: exports.P2P_TUNNEL_PROTOCOL_VERSION,
    };
    if (input.code !== undefined) {
        if (input.code !== "P2P_NATIVE_BACKEND_UNAVAILABLE") {
            throw new Error("code 必须是 P2P_NATIVE_BACKEND_UNAVAILABLE");
        }
        result.code = "P2P_NATIVE_BACKEND_UNAVAILABLE";
    }
    return result;
}
