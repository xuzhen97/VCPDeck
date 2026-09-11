"use strict";
// ── 交互式终端协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。
// 所有跨信任边界的终端消息必须先经 parse* 函数校验，非法消息不得进入业务服务。
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_SHELL_KINDS = exports.TerminalProtocolError = exports.TerminalLimits = exports.TERMINAL_AUDIT_EVENTS = exports.TERMINAL_SESSION_STATUSES = exports.TERMINAL_ERROR_CODES = void 0;
exports.terminalErrorCode = terminalErrorCode;
exports.safeTerminalErrorMessage = safeTerminalErrorMessage;
exports.isTerminalSessionStatus = isTerminalSessionStatus;
exports.isTerminalAuditEventName = isTerminalAuditEventName;
exports.utf8ByteLength = utf8ByteLength;
exports.isValidTerminalSize = isValidTerminalSize;
exports.parseTerminalCapabilityStatus = parseTerminalCapabilityStatus;
exports.parseTerminalShellInfo = parseTerminalShellInfo;
exports.parseTerminalSessionInfo = parseTerminalSessionInfo;
exports.parseTerminalAuditInfo = parseTerminalAuditInfo;
exports.parseTerminalSessionCreateRequest = parseTerminalSessionCreateRequest;
exports.parseTerminalClientRequest = parseTerminalClientRequest;
exports.parseTerminalClientResponse = parseTerminalClientResponse;
exports.parseTerminalOutputChunk = parseTerminalOutputChunk;
exports.parseTerminalExitReport = parseTerminalExitReport;
exports.parseTerminalStateReport = parseTerminalStateReport;
exports.parseTerminalStateAck = parseTerminalStateAck;
exports.parseTerminalBrowserAttach = parseTerminalBrowserAttach;
exports.parseTerminalBrowserInput = parseTerminalBrowserInput;
exports.parseTerminalBrowserResize = parseTerminalBrowserResize;
exports.parseTerminalBrowserTakeover = parseTerminalBrowserTakeover;
exports.parseTerminalBrowserDetach = parseTerminalBrowserDetach;
exports.parseTerminalBrowserAckOutput = parseTerminalBrowserAckOutput;
exports.parseTerminalBrowserResync = parseTerminalBrowserResync;
exports.parseTerminalBrowserAttached = parseTerminalBrowserAttached;
exports.parseTerminalSnapshotMessage = parseTerminalSnapshotMessage;
exports.parseTerminalControlState = parseTerminalControlState;
exports.parseTerminalSessionStateMessage = parseTerminalSessionStateMessage;
exports.parseTerminalError = parseTerminalError;
// ── 稳定错误码 ──
exports.TERMINAL_ERROR_CODES = [
    "TERMINAL_CLIENT_OFFLINE",
    "TERMINAL_UNSUPPORTED",
    "TERMINAL_NATIVE_BACKEND_UNAVAILABLE",
    "TERMINAL_SESSION_NOT_FOUND",
    "TERMINAL_SESSION_LIMIT_REACHED",
    "TERMINAL_SHELL_NOT_AVAILABLE",
    "TERMINAL_SESSION_ENDED",
    "TERMINAL_READ_ONLY",
    "TERMINAL_CONTROL_PROTECTED",
    "TERMINAL_CONTROL_CONFLICT",
    "TERMINAL_PTY_SPAWN_FAILED",
    "TERMINAL_PTY_IO_FAILED",
    "TERMINAL_SNAPSHOT_FAILED",
    "TERMINAL_RESYNC_REQUIRED",
    "TERMINAL_CLIENT_RESTARTED",
    "TERMINAL_REQUEST_TIMEOUT",
    "TERMINAL_INPUT_TOO_LARGE",
    "TERMINAL_RATE_LIMITED",
    "TERMINAL_PROTOCOL_INVALID",
];
/** 构造稳定终端错误对象。 */
function terminalErrorCode(code, message) {
    return { code, message };
}
/** 可安全出站的终端错误消息（截断且不回显正文）。 */
function safeTerminalErrorMessage(value) {
    return typeof value === "string" && value.length > 0
        ? value.slice(0, 200)
        : "Terminal operation failed";
}
// ── 状态与审计 allowlist ──
exports.TERMINAL_SESSION_STATUSES = [
    "starting",
    "active",
    "detached",
    "exited",
    "interrupted",
    "expired",
    "closed",
    "error",
];
exports.TERMINAL_AUDIT_EVENTS = [
    "created",
    "create_failed",
    "attached",
    "detached",
    "takeover",
    "closed",
    "expired",
    "exited",
    "interrupted",
];
function isTerminalSessionStatus(v) {
    return (typeof v === "string" &&
        exports.TERMINAL_SESSION_STATUSES.includes(v));
}
function isTerminalAuditEventName(v) {
    return (typeof v === "string" &&
        exports.TERMINAL_AUDIT_EVENTS.includes(v));
}
// ── 边界常量（与设计文档 12.1 一致） ──
exports.TerminalLimits = {
    maxSessionsPerClient: 5,
    reconnectGraceMs: 30_000,
    detachedTtlMs: 30 * 60_000,
    maxInputBytes: 64 * 1024,
    maxOutputChunkBytes: 64 * 1024,
    maxSnapshotBytes: 8 * 1024 * 1024,
    syncBacklogBytes: 2 * 1024 * 1024,
    scrollbackLines: 2_000,
    /** 慢消费者：live 状态下 ack 落后超过该块数即标记 resync */
    slowConsumerGapBlocks: 512,
    minCols: 20,
    maxCols: 500,
    minRows: 5,
    maxRows: 300,
    maxStateSessions: 5,
};
/** 按 UTF-8 字节长度计算字符串大小（终端输入/输出限制按字节计）。 */
function utf8ByteLength(value) {
    // TextEncoder 浏览器/Node 通用；Buffer.byteLength 在浏览器不可用
    return new TextEncoder().encode(value).byteLength;
}
/** 校验终端尺寸是否在协议允许范围内。 */
function isValidTerminalSize(cols, rows) {
    return (Number.isInteger(cols) &&
        Number.isInteger(rows) &&
        cols >= exports.TerminalLimits.minCols &&
        cols <= exports.TerminalLimits.maxCols &&
        rows >= exports.TerminalLimits.minRows &&
        rows <= exports.TerminalLimits.maxRows);
}
// ── 协议异常 ──
class TerminalProtocolError extends Error {
    code = "TERMINAL_PROTOCOL_INVALID";
    constructor(message) {
        super(message);
        this.name = "TerminalProtocolError";
    }
}
exports.TerminalProtocolError = TerminalProtocolError;
// ── 基础校验 helper ──
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assertRecord(v, what) {
    if (!isRecord(v))
        throw new TerminalProtocolError(`${what} 必须是对象`);
}
function assertKeys(v, allowed, what) {
    for (const key of Object.keys(v)) {
        if (!allowed.has(key))
            throw new TerminalProtocolError(`${what} 含未知字段 ${key}`);
    }
}
function assertString(v, what, maxBytes) {
    if (typeof v !== "string" || v.length === 0)
        throw new TerminalProtocolError(`${what} 必须是非空字符串`);
    if (maxBytes !== undefined && utf8ByteLength(v) > maxBytes)
        throw new TerminalProtocolError(`${what} 超过 ${maxBytes} 字节上限`);
}
function assertOptionalString(v, what, maxBytes) {
    if (v !== undefined)
        assertString(v, what, maxBytes);
}
function assertSessionId(v) {
    assertString(v, "sessionId", 128);
}
function assertRequestId(v) {
    assertString(v, "requestId", 128);
}
function assertErrorCode(v, what) {
    assertString(v, what);
    if (!exports.TERMINAL_ERROR_CODES.includes(v))
        throw new TerminalProtocolError(`${what} 不在 allowlist`);
}
function assertTerminalSize(v, what) {
    const cols = v.cols;
    const rows = v.rows;
    if (typeof cols !== "number" ||
        typeof rows !== "number" ||
        !isValidTerminalSize(cols, rows)) {
        throw new TerminalProtocolError(`${what} 尺寸非法`);
    }
}
function assertDate(v, what) {
    assertString(v, what, 64);
    if (Number.isNaN(Date.parse(v)))
        throw new TerminalProtocolError(`${what} 不是合法日期`);
}
function assertOptionalDate(v, what) {
    if (v !== undefined)
        assertDate(v, what);
}
function parseTerminalCapabilityStatus(v) {
    assertRecord(v, "capabilityDetails.terminal");
    assertKeys(v, new Set(["available", "backend", "code", "message"]), "capabilityDetails.terminal");
    if (typeof v.available !== "boolean")
        throw new TerminalProtocolError("capabilityDetails.terminal.available 必须是布尔");
    if (v.backend !== undefined &&
        v.backend !== "conpty" &&
        v.backend !== "pty") {
        throw new TerminalProtocolError("capabilityDetails.terminal.backend 不受支持");
    }
    if (v.code !== undefined)
        assertErrorCode(v.code, "capabilityDetails.terminal.code");
    if (v.message !== undefined)
        assertString(v.message, "capabilityDetails.terminal.message", 200);
    return v;
}
exports.TERMINAL_SHELL_KINDS = [
    "pwsh",
    "powershell",
    "cmd",
    "bash",
    "zsh",
    "sh",
    "other",
];
function parseTerminalShellInfo(v) {
    assertRecord(v, "shell");
    assertKeys(v, new Set(["id", "label", "kind", "isDefault"]), "shell");
    assertString(v.id, "shell.id", 64);
    assertString(v.label, "shell.label", 64);
    if (typeof v.kind !== "string" ||
        !exports.TERMINAL_SHELL_KINDS.includes(v.kind)) {
        throw new TerminalProtocolError("shell.kind 不受支持");
    }
    if (typeof v.isDefault !== "boolean")
        throw new TerminalProtocolError("shell.isDefault 必须是布尔");
    return v;
}
function parseTerminalSessionInfo(v) {
    assertRecord(v, "session");
    assertKeys(v, new Set([
        "sessionId",
        "clientId",
        "shellId",
        "shellLabel",
        "status",
        "cols",
        "rows",
        "createdByIdentityId",
        "createdByName",
        "createdAt",
        "lastAttachedAt",
        "detachedAt",
        "expiresAt",
        "endedAt",
        "endReason",
        "errorCode",
    ]), "session");
    const r = v;
    assertSessionId(r.sessionId);
    assertString(r.clientId, "clientId", 128);
    assertString(r.shellId, "shellId", 64);
    assertString(r.shellLabel, "shellLabel", 64);
    if (!isTerminalSessionStatus(r.status))
        throw new TerminalProtocolError("session.status 不受支持");
    assertTerminalSize(r, "session");
    for (const key of ["createdByIdentityId", "createdByName"]) {
        if (r[key] !== null)
            assertOptionalString(r[key], key, 128);
    }
    assertDate(r.createdAt, "createdAt");
    for (const key of [
        "lastAttachedAt",
        "detachedAt",
        "expiresAt",
        "endedAt",
    ]) {
        if (r[key] !== null)
            assertOptionalDate(r[key], key);
    }
    for (const key of ["endReason", "errorCode"]) {
        if (r[key] !== null)
            assertOptionalString(r[key], key, 200);
    }
    return v;
}
function parseTerminalAuditInfo(v) {
    assertRecord(v, "audit");
    assertKeys(v, new Set([
        "id",
        "sessionId",
        "clientId",
        "event",
        "identityId",
        "actorName",
        "source",
        "result",
        "reason",
        "createdAt",
    ]), "audit");
    assertString(v.id, "audit.id", 128);
    assertSessionId(v.sessionId);
    assertString(v.clientId, "clientId", 128);
    if (!isTerminalAuditEventName(v.event))
        throw new TerminalProtocolError("audit.event 不受支持");
    for (const key of ["identityId", "actorName", "source"]) {
        if (v[key] !== null)
            assertOptionalString(v[key], key, 128);
    }
    if (v.result !== "ok" && v.result !== "error")
        throw new TerminalProtocolError("audit.result 不受支持");
    if (v.reason !== null)
        assertOptionalString(v.reason, "audit.reason", 200);
    assertDate(v.createdAt, "createdAt");
    return v;
}
function parseTerminalSessionCreateRequest(v) {
    assertRecord(v, "create");
    assertKeys(v, new Set(["shellId", "cols", "rows"]), "create");
    assertString(v.shellId, "shellId", 64);
    if (typeof v.cols !== "number" ||
        typeof v.rows !== "number" ||
        !isValidTerminalSize(v.cols, v.rows)) {
        throw new TerminalProtocolError("create 尺寸非法");
    }
    return v;
}
const CLIENT_REQUEST_KEYS = {
    "shells.list": new Set(["requestId", "action"]),
    "session.create": new Set([
        "requestId",
        "action",
        "sessionId",
        "shellId",
        "cols",
        "rows",
    ]),
    "session.attach": new Set(["requestId", "action", "sessionId"]),
    "session.detach": new Set(["requestId", "action", "sessionId"]),
    "session.input": new Set(["requestId", "action", "sessionId", "data"]),
    "session.resize": new Set([
        "requestId",
        "action",
        "sessionId",
        "cols",
        "rows",
    ]),
    "session.snapshot": new Set(["requestId", "action", "sessionId"]),
    "session.close": new Set(["requestId", "action", "sessionId", "reason"]),
};
/** 解析 Server → Client 终端请求；非法请求抛 TerminalProtocolError。 */
function parseTerminalClientRequest(v) {
    assertRecord(v, "request");
    assertRequestId(v.requestId);
    if (typeof v.action !== "string" || !(v.action in CLIENT_REQUEST_KEYS)) {
        throw new TerminalProtocolError(`未知 action ${String(v.action)}`);
    }
    const action = v.action;
    assertKeys(v, CLIENT_REQUEST_KEYS[action], `request.${action}`);
    switch (action) {
        case "shells.list":
            return v;
        case "session.create":
            assertSessionId(v.sessionId);
            assertString(v.shellId, "shellId", 64);
            assertTerminalSize(v, "create");
            break;
        case "session.attach":
        case "session.detach":
        case "session.snapshot":
            assertSessionId(v.sessionId);
            break;
        case "session.input": {
            assertSessionId(v.sessionId);
            assertString(v.data, "data", exports.TerminalLimits.maxInputBytes);
            break;
        }
        case "session.resize":
            assertSessionId(v.sessionId);
            assertTerminalSize(v, "resize");
            break;
        case "session.close": {
            assertSessionId(v.sessionId);
            if (v.reason !== "closed" && v.reason !== "expired")
                throw new TerminalProtocolError("close.reason 不受支持");
            break;
        }
    }
    return v;
}
/** 解析 Client → Server 终端响应；非法响应抛 TerminalProtocolError。 */
function parseTerminalClientResponse(v) {
    assertRecord(v, "response");
    assertRequestId(v.requestId);
    if (typeof v.ok !== "boolean")
        throw new TerminalProtocolError("response.ok 必须是布尔");
    if (v.ok === false) {
        assertKeys(v, new Set(["requestId", "ok", "error"]), "response");
        assertRecord(v.error, "response.error");
        assertKeys(v.error, new Set(["code", "message"]), "response.error");
        assertErrorCode(v.error.code, "response.error.code");
        assertString(v.error.message, "response.error.message", 200);
        return v;
    }
    if (typeof v.action !== "string")
        throw new TerminalProtocolError("response.action 必须是字符串");
    switch (v.action) {
        case "shells.list": {
            assertKeys(v, new Set(["requestId", "ok", "action", "shells"]), "response");
            if (!Array.isArray(v.shells) || v.shells.length > 10)
                throw new TerminalProtocolError("response.shells 必须是数组");
            for (const shell of v.shells)
                parseTerminalShellInfo(shell);
            return v;
        }
        case "session.create": {
            assertKeys(v, new Set(["requestId", "ok", "action", "sessionId", "status"]), "response");
            assertSessionId(v.sessionId);
            if (v.status !== "active" && v.status !== "detached")
                throw new TerminalProtocolError("create.status 不受支持");
            return v;
        }
        case "session.attach":
        case "session.snapshot": {
            assertKeys(v, new Set([
                "requestId",
                "ok",
                "action",
                "sessionId",
                "snapshot",
                "snapshotSeq",
                "cols",
                "rows",
                "historyTruncated",
            ]), "response");
            assertSessionId(v.sessionId);
            assertString(v.snapshot, "snapshot", exports.TerminalLimits.maxSnapshotBytes);
            if (typeof v.snapshotSeq !== "number" ||
                !Number.isInteger(v.snapshotSeq) ||
                v.snapshotSeq < 0) {
                throw new TerminalProtocolError("snapshotSeq 必须是正整数");
            }
            assertTerminalSize(v, "response");
            if (typeof v.historyTruncated !== "boolean")
                throw new TerminalProtocolError("historyTruncated 必须是布尔");
            return v;
        }
        case "session.detach":
        case "session.input": {
            assertKeys(v, new Set(["requestId", "ok", "action", "sessionId"]), "response");
            assertSessionId(v.sessionId);
            return v;
        }
        case "session.resize": {
            assertKeys(v, new Set(["requestId", "ok", "action", "sessionId", "cols", "rows"]), "response");
            assertSessionId(v.sessionId);
            assertTerminalSize(v, "response");
            return v;
        }
        case "session.close": {
            assertKeys(v, new Set(["requestId", "ok", "action", "sessionId", "status"]), "response");
            assertSessionId(v.sessionId);
            if (v.status !== "closed")
                throw new TerminalProtocolError("close.status 不受支持");
            return v;
        }
        default:
            throw new TerminalProtocolError(`未知 action ${String(v.action)}`);
    }
}
/** 解析终端输出块；非法块抛 TerminalProtocolError。 */
function parseTerminalOutputChunk(v) {
    assertRecord(v, "chunk");
    assertKeys(v, new Set(["sessionId", "seq", "data"]), "chunk");
    assertSessionId(v.sessionId);
    if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1) {
        throw new TerminalProtocolError("chunk.seq 必须是正整数");
    }
    assertString(v.data, "data", exports.TerminalLimits.maxOutputChunkBytes);
    return v;
}
/** 解析 Shell 退出报告；非法报告抛 TerminalProtocolError。 */
function parseTerminalExitReport(v) {
    assertRecord(v, "exit");
    assertKeys(v, new Set(["sessionId", "exitCode"]), "exit");
    assertSessionId(v.sessionId);
    if (typeof v.exitCode !== "number" || !Number.isInteger(v.exitCode)) {
        throw new TerminalProtocolError("exit.exitCode 必须是整数");
    }
    return v;
}
/** 解析 Client → Server 状态报告；非法报告抛 TerminalProtocolError。 */
function parseTerminalStateReport(v) {
    assertRecord(v, "state");
    assertKeys(v, new Set(["clientId", "generationId", "sessions"]), "state");
    assertString(v.clientId, "clientId", 128);
    assertString(v.generationId, "generationId", 128);
    if (!Array.isArray(v.sessions) ||
        v.sessions.length > exports.TerminalLimits.maxStateSessions) {
        throw new TerminalProtocolError("state.sessions 数量超过上限");
    }
    const seen = new Set();
    for (const raw of v.sessions) {
        assertRecord(raw, "state.sessions[]");
        assertKeys(raw, new Set([
            "sessionId",
            "shellId",
            "status",
            "cols",
            "rows",
            "lastSeq",
            "detachedAt",
            "expiresAt",
        ]), "state.sessions[]");
        assertSessionId(raw.sessionId);
        if (seen.has(raw.sessionId))
            throw new TerminalProtocolError("state.sessions 含重复 sessionId");
        seen.add(raw.sessionId);
        assertString(raw.shellId, "shellId", 64);
        if (raw.status !== "active" && raw.status !== "detached") {
            throw new TerminalProtocolError("state.sessions[].status 不受支持");
        }
        assertTerminalSize(raw, "state.sessions[]");
        if (typeof raw.lastSeq !== "number" ||
            !Number.isInteger(raw.lastSeq) ||
            raw.lastSeq < 0) {
            throw new TerminalProtocolError("state.sessions[].lastSeq 必须是正整数");
        }
        assertOptionalDate(raw.detachedAt, "state.sessions[].detachedAt");
        assertOptionalDate(raw.expiresAt, "state.sessions[].expiresAt");
    }
    return v;
}
/** 解析 Server → Client 状态 ack；非法 ack 抛 TerminalProtocolError。 */
function parseTerminalStateAck(v) {
    assertRecord(v, "ack");
    assertKeys(v, new Set(["acceptedSessionIds", "closeSessionIds"]), "ack");
    for (const key of ["acceptedSessionIds", "closeSessionIds"]) {
        if (!Array.isArray(v[key]))
            throw new TerminalProtocolError(`ack.${key} 必须是数组`);
        for (const id of v[key]) {
            if (typeof id !== "string" || id.length === 0 || id.length > 128) {
                throw new TerminalProtocolError(`ack.${key} 必须是非空字符串`);
            }
        }
    }
    return v;
}
function parseTerminalBrowserAttach(v) {
    assertRecord(v, "attach");
    assertKeys(v, new Set(["sessionId", "reconnectToken"]), "attach");
    assertSessionId(v.sessionId);
    if (v.reconnectToken !== undefined)
        assertString(v.reconnectToken, "reconnectToken", 128);
    return v;
}
function parseTerminalBrowserInput(v) {
    assertRecord(v, "input");
    assertKeys(v, new Set(["sessionId", "attachmentId", "data"]), "input");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    assertString(v.data, "data", exports.TerminalLimits.maxInputBytes);
    return v;
}
function parseTerminalBrowserResize(v) {
    assertRecord(v, "resize");
    assertKeys(v, new Set(["sessionId", "attachmentId", "cols", "rows"]), "resize");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    assertTerminalSize(v, "resize");
    return v;
}
function parseTerminalBrowserTakeover(v) {
    assertRecord(v, "takeover");
    assertKeys(v, new Set(["sessionId", "attachmentId"]), "takeover");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    return v;
}
function parseTerminalBrowserDetach(v) {
    assertRecord(v, "detach");
    assertKeys(v, new Set(["sessionId", "attachmentId"]), "detach");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    return v;
}
function parseTerminalBrowserAckOutput(v) {
    assertRecord(v, "ack-output");
    assertKeys(v, new Set(["sessionId", "attachmentId", "seq"]), "ack-output");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
        throw new TerminalProtocolError("ack-output.seq 必须是正整数");
    }
    return v;
}
function parseTerminalBrowserResync(v) {
    assertRecord(v, "resync");
    assertKeys(v, new Set(["sessionId", "attachmentId"]), "resync");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    return v;
}
function parseTerminalBrowserAttached(v) {
    assertRecord(v, "attached");
    assertKeys(v, new Set([
        "sessionId",
        "attachmentId",
        "reconnectToken",
        "mode",
        "controlProtectedUntil",
    ]), "attached");
    assertSessionId(v.sessionId);
    assertString(v.attachmentId, "attachmentId", 128);
    assertString(v.reconnectToken, "reconnectToken", 128);
    if (v.mode !== "operator" && v.mode !== "viewer")
        throw new TerminalProtocolError("attached.mode 不受支持");
    if (v.controlProtectedUntil !== null)
        assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
    return v;
}
function parseTerminalSnapshotMessage(v) {
    assertRecord(v, "snapshot");
    assertKeys(v, new Set([
        "sessionId",
        "snapshot",
        "snapshotSeq",
        "cols",
        "rows",
        "historyTruncated",
    ]), "snapshot");
    assertSessionId(v.sessionId);
    assertString(v.snapshot, "snapshot", exports.TerminalLimits.maxSnapshotBytes);
    if (typeof v.snapshotSeq !== "number" ||
        !Number.isInteger(v.snapshotSeq) ||
        v.snapshotSeq < 0) {
        throw new TerminalProtocolError("snapshot.snapshotSeq 必须是正整数");
    }
    assertTerminalSize(v, "snapshot");
    if (typeof v.historyTruncated !== "boolean")
        throw new TerminalProtocolError("snapshot.historyTruncated 必须是布尔");
    return v;
}
function parseTerminalControlState(v) {
    assertRecord(v, "control");
    assertKeys(v, new Set([
        "sessionId",
        "mode",
        "operatorName",
        "controlProtectedUntil",
        "canTakeover",
    ]), "control");
    assertSessionId(v.sessionId);
    if (v.mode !== "operator" && v.mode !== "viewer")
        throw new TerminalProtocolError("control.mode 不受支持");
    if (v.operatorName !== null)
        assertOptionalString(v.operatorName, "operatorName", 128);
    if (v.controlProtectedUntil !== null)
        assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
    if (typeof v.canTakeover !== "boolean")
        throw new TerminalProtocolError("control.canTakeover 必须是布尔");
    return v;
}
function parseTerminalSessionStateMessage(v) {
    assertRecord(v, "state-message");
    assertKeys(v, new Set(["sessionId", "status", "reason"]), "state-message");
    assertSessionId(v.sessionId);
    if (!isTerminalSessionStatus(v.status))
        throw new TerminalProtocolError("state-message.status 不受支持");
    if (v.reason !== undefined)
        assertString(v.reason, "reason", 200);
    return v;
}
function parseTerminalError(v) {
    assertRecord(v, "error");
    assertKeys(v, new Set(["sessionId", "code", "message"]), "error");
    assertString(v.sessionId, "sessionId", 128);
    assertErrorCode(v.code, "error.code");
    assertString(v.message, "message", 200);
    return v;
}
