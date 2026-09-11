export declare const PI_ERROR_CODES: readonly ["PI_PROTOCOL_INVALID", "PI_CLIENT_UNSUPPORTED", "PI_NODE_UNSUPPORTED", "PI_BASH_NOT_FOUND", "PI_RUNTIME_UNAVAILABLE", "PI_AUTH_UNAVAILABLE", "PI_MODEL_NOT_FOUND", "PI_PROJECT_NOT_ALLOWED", "PI_SESSION_NOT_FOUND", "PI_PROJECT_BUSY", "PI_CONTROL_FORBIDDEN", "PI_CLIENT_DISCONNECTED", "PI_WORKER_EXITED", "PI_CLIENT_RESTARTED", "PI_IMAGE_INVALID", "PI_IMAGE_TOO_LARGE", "PI_REQUEST_TIMEOUT", "PI_STATE_PENDING"];
export type PiErrorCode = (typeof PI_ERROR_CODES)[number];
/** Session Job 协议版本；Server 与新 Client 必须精确匹配。 */
export declare const PI_SESSION_JOB_PROTOCOL_VERSION = 1;
export type PiSessionJobStatus = "idle" | "pending" | "running" | "waiting_input" | "done" | "disconnected" | "error" | "cancelled";
export interface PiSessionJobSnapshot {
    jobId: string;
    sessionId: string;
    status: PiSessionJobStatus;
    runId: string | null;
    ownerName: string | null;
    isOwner: boolean;
    errorCode?: PiErrorCode;
    errorMessage?: string;
}
export interface PiSessionCreated {
    sessionId: string;
    jobId: string;
}
export interface PiSessionOpenResult {
    job: PiSessionJobSnapshot;
    agentState: PiAgentState;
}
export interface PiStateAck {
    acceptedRunIds: string[];
    closedRunIds: string[];
    reportAgain: boolean;
}
/** 项目目录引用：由 Files roots 选定，Client 负责 canonicalize 后再使用 */
export interface PiCwdRef {
    rootDir: string;
    relativePath: string;
}
/**
 * 项目不透明 key：Client 用进程级随机 secret 对 canonical cwd 计算 HMAC-SHA-256。
 * 只用于 Server 内存锁与 state reconcile，不含/不返回 cwd，不写 Job/日志/数据库。
 */
export type PiProjectKey = string;
export declare const PI_PROJECT_KEY_LENGTH = 64;
/** Client Pi 能力状态：探测结果的安全摘要 */
export type PiCapabilityStatus = {
    available: true;
    sdkVersion: string;
    nodeVersion: string;
    shellKind: "configured" | "git-bash" | "path" | "system";
    /** 旧 Client 缺省；新 Client 固定上报当前版本。 */
    sessionJobProtocolVersion?: number;
} | {
    available: false;
    code: "PI_CLIENT_UNSUPPORTED" | "PI_NODE_UNSUPPORTED" | "PI_BASH_NOT_FOUND" | "PI_RUNTIME_UNAVAILABLE" | "PI_AUTH_UNAVAILABLE";
    message: string;
    nodeVersion?: string;
};
/** Pi 动作：Server → Client 请求的动作 */
export type PiAction = "capability.get" | "models.list" | "project.resolve" | "sessions.list" | "session.get" | "session.context" | "session.entryContent" | "session.new" | "session.rename" | "session.delete" | "session.fork" | "session.clone" | "session.navigate" | "agent.state" | "agent.prompt" | "agent.steer" | "agent.followUp" | "agent.abort" | "agent.compact" | "agent.abortCompact" | "agent.commands" | "agent.stats" | "model.set" | "thinking.set" | "extension.respond";
/** Server → Client 请求（cwdRef 只用于当次远程校验，不复制到 Job） */
export interface PiRequest {
    requestId: string;
    action: PiAction;
    cwdRef?: PiCwdRef;
    sessionId?: string;
    jobId?: string;
    runId?: string;
    payload?: Record<string, unknown>;
}
/** Client → Server 响应 */
export type PiResponse = {
    requestId: string;
    ok: true;
    data?: unknown;
} | {
    requestId: string;
    ok: false;
    error: {
        code: PiErrorCode;
        message: string;
    };
};
/** 图片数量/大小上限（与 Pi Web 一致，单位字节） */
export declare const MAX_PI_IMAGES_PER_PROMPT = 10;
export declare const MAX_PI_IMAGE_BYTES: number;
export declare const MAX_PI_IMAGES_TOTAL_BYTES: number;
export declare const PI_IMAGE_MIME_TYPES: readonly ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** prompt 附件描述符（transient，不进 Job/日志） */
export interface PiAttachmentDescriptor {
    fileId: string;
    sha256: string;
    size: number;
    mimeType: string;
    /** 短期下载 URL（transient，不进 Job/日志） */
    url: string;
}
/** prompt 被接受后的权威响应（SSE 断线 fallback 使用） */
export interface PiPromptAccepted {
    jobId: string;
    runId: string;
    sessionId: string;
}
/** 临时附件引用（short-lived，不进 Job/日志） */
export interface PiAttachmentRef {
    fileId: string;
    sha256: string;
    size: number;
    mimeType: string;
    url: string;
    expiresAt: number;
}
/** 投影后的 Agent 事件（Client → Server 包装） */
export interface PiEvent {
    clientId: string;
    sessionId: string;
    jobId: string;
    runId: string;
    event: PiClientEvent;
}
/** 允许进入实时通道的裁剪事件（正文限制在投影层执行） */
export type PiClientEvent = {
    type: "connected";
    sessionId: string;
} | {
    type: "history_changed";
    sessionId: string;
} | {
    type: "agent_start";
    sessionId: string;
} | {
    type: "agent_end";
    sessionId: string;
} | {
    type: "prompt_done";
    sessionId: string;
} | {
    type: "prompt_error";
    sessionId: string;
    code: PiErrorCode;
    message: string;
} | {
    type: "agent_settled";
    sessionId: string;
} | {
    type: "thinking_progress";
    sessionId: string;
    stage: string;
    text?: string;
    durationMs?: number;
} | {
    type: "extension_request";
    sessionId: string;
    ui: PiExtensionUiRequest;
} | {
    type: "extension_resolved";
    sessionId: string;
    requestId: string;
    reason: "answered" | "cancelled" | "timeout";
    hasPending: boolean;
} | {
    type: "message_update";
    sessionId: string;
    text?: string;
    role?: string;
} | {
    type: "run_created";
    sessionId: string;
    submissionId: string;
    runId: string;
} | {
    type: "usage_update";
    sessionId: string;
    usage: Record<string, unknown>;
} | {
    type: "status_update";
    sessionId: string;
    status: string;
};
/** 标准 Extension UI 请求（首版只支持对话式） */
export interface PiExtensionUiRequest {
    requestId: string;
    extensionId: string;
    kind: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
    title?: string;
    message?: string;
    options?: string[];
    timeoutMs?: number;
}
/** 活动/终态 run 摘要（PI_STATE，不含 cwd/path/prompt） */
export interface PiRunSummary {
    jobId: string;
    runId: string;
    sessionId: string;
    status: "running" | "waiting_input" | "idle" | "done" | "error";
    projectKey?: PiProjectKey;
}
/** Client 重连/注册时的运行状态报告 */
export interface PiStateReport {
    clientId: string;
    runs: PiRunSummary[];
}
export interface PiTextContent {
    type: "text";
    text: string;
}
export interface PiImagePlaceholder {
    type: "image";
    deferred: true;
    mimeType: string;
    entryId: string;
    blockIndex: number;
}
/** thinking 正文占位：正文永不离开远程 Session JSONL */
export interface PiThinkingPlaceholder {
    type: "thinking";
    deferred: true;
    /** 当前回合实时思考正文；历史 Session 不填充。 */
    text?: string;
    durationMs?: number;
}
export interface PiToolCallContent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
}
export type PiMessageContent = PiTextContent | PiImagePlaceholder | PiThinkingPlaceholder | PiToolCallContent;
export interface PiUserMessage {
    id: string;
    role: "user";
    content: (PiTextContent | PiImagePlaceholder)[];
}
export interface PiAssistantMessage {
    id: string;
    role: "assistant";
    content: PiMessageContent[];
}
export interface PiToolResultMessage {
    id: string;
    role: "tool_result";
    toolCallId: string;
    content: PiTextContent[];
}
export interface PiCustomMessage {
    id: string;
    role: "custom";
    kind: string;
}
export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiCustomMessage;
/** Session 列表条目（不含 JSONL 绝对路径） */
export interface PiSessionInfo {
    id: string;
    name: string;
    created: string;
    modified: string;
    messageCount: number;
    firstMessage: string | null;
    parentSessionId: string | null;
    running: boolean;
}
/** Session 详情（metadata + 投影后的分支树） */
export interface PiSessionDetail {
    info: PiSessionInfo;
    tree: PiSessionTreeNode[];
    activeLeafId: string | null;
}
export interface PiSessionTreeNode {
    id: string;
    name: string;
    messageCount: number;
    running: boolean;
    children: PiSessionTreeNode[];
}
/** 历史分页：entry cursor，默认最新窗口 */
export interface PiSessionContextPage {
    messages: PiMessage[];
    nextCursor: string | null;
}
/** Pi SDK 支持的思考深度（Frontend 的 auto 不属于协议值） */
export declare const PI_THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
/** 当前可选模型的安全摘要 */
export interface PiModelInfo {
    provider: string;
    modelId: string;
}
/** 判断值是否为 Pi SDK 支持的思考深度 */
export declare function isPiThinkingLevel(value: unknown): value is PiThinkingLevel;
/** Agent 状态快照（settlement check 使用） */
export interface PiAgentState {
    status: "idle" | "running" | "compacting" | "waiting_for_extension_input";
    streaming: boolean;
    prompting: boolean;
    compacting: boolean;
    thinkingLevel: PiThinkingLevel;
    queuedMessages: {
        steering: unknown[];
        followUp: unknown[];
    };
    model?: PiModelInfo;
    waitingForExtensionInput?: boolean;
    pendingExtension?: PiExtensionUiRequest;
}
/** 严格空闲判定：四标志空闲 + 无排队 Extension + 无等待输入 + steering/followUp 队列空。 */
export declare function isPiAgentIdle(state: PiAgentState): boolean;
/** 协议解析错误：Server/Client 在信任边界使用 payload 前调用 */
export declare class PiProtocolError extends Error {
    readonly code = "PI_PROTOCOL_INVALID";
    constructor(message: string);
}
/** 返回可安全出站的 Pi 错误消息，避免泄露任意对象内容。 */
export declare function safePiErrorMessage(value: unknown): string;
/** 校验 Server → Client 请求（Client Socket 收到后必须先调用） */
export declare function parsePiRequest(input: unknown): PiRequest;
/** 校验 Client → Server 响应（Server Gateway 收到后必须先调用） */
export declare function parsePiResponse(input: unknown): PiResponse;
/** 严格校验 Agent 状态快照。 */
export declare function parsePiAgentState(input: unknown): PiAgentState;
/** 校验 Client → Server 事件包装（Server Gateway 收到后必须先调用） */
export declare function parsePiEvent(input: unknown): PiEvent;
/** 校验 Client 运行状态报告（注册/重连时） */
export declare function parsePiStateReport(input: unknown): PiStateReport;
