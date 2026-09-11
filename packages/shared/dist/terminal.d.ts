export declare const TERMINAL_ERROR_CODES: readonly ["TERMINAL_CLIENT_OFFLINE", "TERMINAL_UNSUPPORTED", "TERMINAL_NATIVE_BACKEND_UNAVAILABLE", "TERMINAL_SESSION_NOT_FOUND", "TERMINAL_SESSION_LIMIT_REACHED", "TERMINAL_SHELL_NOT_AVAILABLE", "TERMINAL_SESSION_ENDED", "TERMINAL_READ_ONLY", "TERMINAL_CONTROL_PROTECTED", "TERMINAL_CONTROL_CONFLICT", "TERMINAL_PTY_SPAWN_FAILED", "TERMINAL_PTY_IO_FAILED", "TERMINAL_SNAPSHOT_FAILED", "TERMINAL_RESYNC_REQUIRED", "TERMINAL_CLIENT_RESTARTED", "TERMINAL_REQUEST_TIMEOUT", "TERMINAL_INPUT_TOO_LARGE", "TERMINAL_RATE_LIMITED", "TERMINAL_PROTOCOL_INVALID"];
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
/** 构造稳定终端错误对象。 */
export declare function terminalErrorCode(code: TerminalErrorCode, message: string): {
    code: TerminalErrorCode;
    message: string;
};
/** 可安全出站的终端错误消息（截断且不回显正文）。 */
export declare function safeTerminalErrorMessage(value: unknown): string;
export declare const TERMINAL_SESSION_STATUSES: readonly ["starting", "active", "detached", "exited", "interrupted", "expired", "closed", "error"];
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];
export declare const TERMINAL_AUDIT_EVENTS: readonly ["created", "create_failed", "attached", "detached", "takeover", "closed", "expired", "exited", "interrupted"];
export type TerminalAuditEventName = (typeof TERMINAL_AUDIT_EVENTS)[number];
export declare function isTerminalSessionStatus(v: unknown): v is TerminalSessionStatus;
export declare function isTerminalAuditEventName(v: unknown): v is TerminalAuditEventName;
export declare const TerminalLimits: {
    readonly maxSessionsPerClient: 5;
    readonly reconnectGraceMs: 30000;
    readonly detachedTtlMs: number;
    readonly maxInputBytes: number;
    readonly maxOutputChunkBytes: number;
    readonly maxSnapshotBytes: number;
    readonly syncBacklogBytes: number;
    readonly scrollbackLines: 2000;
    /** 慢消费者：live 状态下 ack 落后超过该块数即标记 resync */
    readonly slowConsumerGapBlocks: 512;
    readonly minCols: 20;
    readonly maxCols: 500;
    readonly minRows: 5;
    readonly maxRows: 300;
    readonly maxStateSessions: 5;
};
/** 按 UTF-8 字节长度计算字符串大小（终端输入/输出限制按字节计）。 */
export declare function utf8ByteLength(value: string): number;
/** 校验终端尺寸是否在协议允许范围内。 */
export declare function isValidTerminalSize(cols: number, rows: number): boolean;
export declare class TerminalProtocolError extends Error {
    readonly code: "TERMINAL_PROTOCOL_INVALID";
    constructor(message: string);
}
/** Client 终端能力摘要（注册时随 capabilityDetails 上报，不含路径）。 */
export interface TerminalCapabilityStatus {
    available: boolean;
    backend?: "conpty" | "pty";
    code?: TerminalErrorCode;
    message?: string;
}
export declare function parseTerminalCapabilityStatus(v: unknown): TerminalCapabilityStatus;
/** Shell 信息（REST 返回，只含安全 ID/label/kind，不含可执行文件路径）。 */
export interface TerminalShellInfo {
    id: string;
    label: string;
    kind: "pwsh" | "powershell" | "cmd" | "bash" | "zsh" | "sh" | "other";
    isDefault: boolean;
}
export declare const TERMINAL_SHELL_KINDS: readonly ["pwsh", "powershell", "cmd", "bash", "zsh", "sh", "other"];
export type TerminalShellKind = (typeof TERMINAL_SHELL_KINDS)[number];
export declare function parseTerminalShellInfo(v: unknown): TerminalShellInfo;
/** 终端会话信息（REST 返回；不含终端正文与内部字段）。 */
export interface TerminalSessionInfo {
    sessionId: string;
    clientId: string;
    shellId: string;
    shellLabel: string;
    status: TerminalSessionStatus;
    cols: number;
    rows: number;
    createdByIdentityId: string | null;
    createdByName: string | null;
    createdAt: string;
    lastAttachedAt: string | null;
    detachedAt: string | null;
    expiresAt: string | null;
    endedAt: string | null;
    endReason: string | null;
    errorCode: string | null;
}
export declare function parseTerminalSessionInfo(v: unknown): TerminalSessionInfo;
/** 终端审计条目（REST 返回；不含输入输出、token 或本地路径）。 */
export interface TerminalAuditInfo {
    id: string;
    sessionId: string;
    clientId: string;
    event: TerminalAuditEventName;
    identityId: string | null;
    actorName: string | null;
    source: string | null;
    result: "ok" | "error";
    reason: string | null;
    createdAt: string;
}
export declare function parseTerminalAuditInfo(v: unknown): TerminalAuditInfo;
/** 终端创建请求（REST body；禁止 executable/args/cwd/env）。 */
export interface TerminalSessionCreateRequest {
    shellId: string;
    cols: number;
    rows: number;
}
export declare function parseTerminalSessionCreateRequest(v: unknown): TerminalSessionCreateRequest;
export type TerminalClientActionName = "shells.list" | "session.create" | "session.attach" | "session.detach" | "session.input" | "session.resize" | "session.snapshot" | "session.close";
/** Server → Client 终端动作（判别联合）。 */
export type TerminalClientRequest = {
    requestId: string;
    action: "shells.list";
} | {
    requestId: string;
    action: "session.create";
    sessionId: string;
    shellId: string;
    cols: number;
    rows: number;
} | {
    requestId: string;
    action: "session.attach";
    sessionId: string;
} | {
    requestId: string;
    action: "session.detach";
    sessionId: string;
} | {
    requestId: string;
    action: "session.input";
    sessionId: string;
    data: string;
} | {
    requestId: string;
    action: "session.resize";
    sessionId: string;
    cols: number;
    rows: number;
} | {
    requestId: string;
    action: "session.snapshot";
    sessionId: string;
} | {
    requestId: string;
    action: "session.close";
    sessionId: string;
    reason: "closed" | "expired";
};
/** 解析 Server → Client 终端请求；非法请求抛 TerminalProtocolError。 */
export declare function parseTerminalClientRequest(v: unknown): TerminalClientRequest;
/** Client → Server 终端动作响应（判别联合；错误为稳定错误码）。 */
export type TerminalClientResponse = {
    requestId: string;
    ok: true;
    action: "shells.list";
    shells: TerminalShellInfo[];
} | {
    requestId: string;
    ok: true;
    action: "session.create";
    sessionId: string;
    status: "active" | "detached";
} | {
    requestId: string;
    ok: true;
    action: "session.attach" | "session.snapshot";
    sessionId: string;
    snapshot: string;
    snapshotSeq: number;
    cols: number;
    rows: number;
    historyTruncated: boolean;
} | {
    requestId: string;
    ok: true;
    action: "session.detach";
    sessionId: string;
} | {
    requestId: string;
    ok: true;
    action: "session.input";
    sessionId: string;
} | {
    requestId: string;
    ok: true;
    action: "session.resize";
    sessionId: string;
    cols: number;
    rows: number;
} | {
    requestId: string;
    ok: true;
    action: "session.close";
    sessionId: string;
    status: "closed";
} | {
    requestId: string;
    ok: false;
    action?: never;
    error: {
        code: TerminalErrorCode;
        message: string;
    };
};
/** 解析 Client → Server 终端响应；非法响应抛 TerminalProtocolError。 */
export declare function parseTerminalClientResponse(v: unknown): TerminalClientResponse;
/** Client → Server 终端输出块（seq 单调递增）。 */
export interface TerminalOutputChunk {
    sessionId: string;
    seq: number;
    data: string;
}
/** 解析终端输出块；非法块抛 TerminalProtocolError。 */
export declare function parseTerminalOutputChunk(v: unknown): TerminalOutputChunk;
/** Client → Server Shell 自行退出报告。 */
export interface TerminalExitReport {
    sessionId: string;
    exitCode: number;
}
/** 解析 Shell 退出报告；非法报告抛 TerminalProtocolError。 */
export declare function parseTerminalExitReport(v: unknown): TerminalExitReport;
/** Client → Server 终端状态对账条目。 */
export interface TerminalStateSession {
    sessionId: string;
    shellId: string;
    status: "active" | "detached";
    cols: number;
    rows: number;
    lastSeq: number;
    detachedAt?: string;
    expiresAt?: string;
}
/** Client → Server 终端状态对账报告（不含 cwd/env/executable/输出）。 */
export interface TerminalStateReport {
    clientId: string;
    generationId: string;
    sessions: TerminalStateSession[];
}
/** Server → Client 状态对账 ack。 */
export interface TerminalStateAck {
    acceptedSessionIds: string[];
    closeSessionIds: string[];
}
/** 解析 Client → Server 状态报告；非法报告抛 TerminalProtocolError。 */
export declare function parseTerminalStateReport(v: unknown): TerminalStateReport;
/** 解析 Server → Client 状态 ack；非法 ack 抛 TerminalProtocolError。 */
export declare function parseTerminalStateAck(v: unknown): TerminalStateAck;
/** 浏览器 attach 请求。 */
export interface TerminalBrowserAttach {
    sessionId: string;
    reconnectToken?: string;
}
export declare function parseTerminalBrowserAttach(v: unknown): TerminalBrowserAttach;
/** 浏览器 input 请求。 */
export interface TerminalBrowserInput {
    sessionId: string;
    attachmentId: string;
    data: string;
}
export declare function parseTerminalBrowserInput(v: unknown): TerminalBrowserInput;
/** 浏览器 resize 请求。 */
export interface TerminalBrowserResize {
    sessionId: string;
    attachmentId: string;
    cols: number;
    rows: number;
}
export declare function parseTerminalBrowserResize(v: unknown): TerminalBrowserResize;
/** 浏览器接管请求。 */
export interface TerminalBrowserTakeover {
    sessionId: string;
    attachmentId: string;
}
export declare function parseTerminalBrowserTakeover(v: unknown): TerminalBrowserTakeover;
/** 浏览器 detach 请求。 */
export interface TerminalBrowserDetach {
    sessionId: string;
    attachmentId: string;
}
export declare function parseTerminalBrowserDetach(v: unknown): TerminalBrowserDetach;
/** 浏览器输出 ack（慢消费者检测）。 */
export interface TerminalBrowserAckOutput {
    sessionId: string;
    attachmentId: string;
    seq: number;
}
export declare function parseTerminalBrowserAckOutput(v: unknown): TerminalBrowserAckOutput;
/** 浏览器 resync 请求。 */
export interface TerminalBrowserResync {
    sessionId: string;
    attachmentId: string;
}
export declare function parseTerminalBrowserResync(v: unknown): TerminalBrowserResync;
/** attach 成功响应。 */
export interface TerminalBrowserAttached {
    sessionId: string;
    attachmentId: string;
    reconnectToken: string;
    mode: "operator" | "viewer";
    controlProtectedUntil: string | null;
}
export declare function parseTerminalBrowserAttached(v: unknown): TerminalBrowserAttached;
/** 终端快照（attach/resync 恢复画面）。 */
export interface TerminalSnapshotMessage {
    sessionId: string;
    snapshot: string;
    snapshotSeq: number;
    cols: number;
    rows: number;
    historyTruncated: boolean;
}
export declare function parseTerminalSnapshotMessage(v: unknown): TerminalSnapshotMessage;
/** 控制权状态广播。 */
export interface TerminalControlState {
    sessionId: string;
    mode: "operator" | "viewer";
    operatorName: string | null;
    controlProtectedUntil: string | null;
    canTakeover: boolean;
}
export declare function parseTerminalControlState(v: unknown): TerminalControlState;
/** 会话状态推送。 */
export interface TerminalSessionStateMessage {
    sessionId: string;
    status: TerminalSessionStatus;
    reason?: string;
}
export declare function parseTerminalSessionStateMessage(v: unknown): TerminalSessionStateMessage;
/** 终端稳定错误消息。 */
export interface TerminalErrorMessage {
    sessionId: string;
    code: TerminalErrorCode;
    message: string;
}
export declare function parseTerminalError(v: unknown): TerminalErrorMessage;
/** 通用 ack 判别联合（Socket.IO ack / REST 错误体）。 */
export type TerminalAck<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: {
        code: TerminalErrorCode;
        message: string;
    };
};
