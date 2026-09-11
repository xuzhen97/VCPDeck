"use strict";
// ── 远程 Pi 协议类型与运行时校验 ──
// 本模块自包含，不 import 同包其他模块，供 Shared/Server/Client/SDK/Frontend 共用。
Object.defineProperty(exports, "__esModule", { value: true });
exports.PiProtocolError = exports.PI_THINKING_LEVELS = exports.PI_IMAGE_MIME_TYPES = exports.MAX_PI_IMAGES_TOTAL_BYTES = exports.MAX_PI_IMAGE_BYTES = exports.MAX_PI_IMAGES_PER_PROMPT = exports.PI_PROJECT_KEY_LENGTH = exports.PI_SESSION_JOB_PROTOCOL_VERSION = exports.PI_ERROR_CODES = void 0;
exports.isPiThinkingLevel = isPiThinkingLevel;
exports.isPiAgentIdle = isPiAgentIdle;
exports.safePiErrorMessage = safePiErrorMessage;
exports.parsePiRequest = parsePiRequest;
exports.parsePiResponse = parsePiResponse;
exports.parsePiAgentState = parsePiAgentState;
exports.parsePiEvent = parsePiEvent;
exports.parsePiStateReport = parsePiStateReport;
// ── 稳定错误码 ──
exports.PI_ERROR_CODES = [
    "PI_PROTOCOL_INVALID",
    "PI_CLIENT_UNSUPPORTED",
    "PI_NODE_UNSUPPORTED",
    "PI_BASH_NOT_FOUND",
    "PI_RUNTIME_UNAVAILABLE",
    "PI_AUTH_UNAVAILABLE",
    "PI_MODEL_NOT_FOUND",
    "PI_PROJECT_NOT_ALLOWED",
    "PI_SESSION_NOT_FOUND",
    "PI_PROJECT_BUSY",
    "PI_CONTROL_FORBIDDEN",
    "PI_CLIENT_DISCONNECTED",
    "PI_WORKER_EXITED",
    "PI_CLIENT_RESTARTED",
    "PI_IMAGE_INVALID",
    "PI_IMAGE_TOO_LARGE",
    "PI_REQUEST_TIMEOUT",
    "PI_STATE_PENDING",
];
/** Session Job 协议版本；Server 与新 Client 必须精确匹配。 */
exports.PI_SESSION_JOB_PROTOCOL_VERSION = 1;
exports.PI_PROJECT_KEY_LENGTH = 64;
/** 图片数量/大小上限（与 Pi Web 一致，单位字节） */
exports.MAX_PI_IMAGES_PER_PROMPT = 10;
exports.MAX_PI_IMAGE_BYTES = 10 * 1024 * 1024;
exports.MAX_PI_IMAGES_TOTAL_BYTES = 100 * 1024 * 1024;
exports.PI_IMAGE_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
];
/** Pi SDK 支持的思考深度（Frontend 的 auto 不属于协议值） */
exports.PI_THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
/** 判断值是否为 Pi SDK 支持的思考深度 */
function isPiThinkingLevel(value) {
    return (typeof value === "string" &&
        exports.PI_THINKING_LEVELS.includes(value));
}
/** 严格空闲判定：四标志空闲 + 无排队 Extension + 无等待输入 + steering/followUp 队列空。 */
function isPiAgentIdle(state) {
    return (state.status === "idle" &&
        state.streaming === false &&
        state.prompting === false &&
        state.compacting === false &&
        state.pendingExtension === undefined &&
        state.waitingForExtensionInput !== true &&
        state.queuedMessages.steering.length === 0 &&
        state.queuedMessages.followUp.length === 0);
}
// ── 运行时校验（trust boundary parsers） ──
/** 协议解析错误：Server/Client 在信任边界使用 payload 前调用 */
class PiProtocolError extends Error {
    code = "PI_PROTOCOL_INVALID";
    constructor(message) {
        super(message);
        this.name = "PiProtocolError";
    }
}
exports.PiProtocolError = PiProtocolError;
const ACTIONS = new Set([
    "capability.get",
    "models.list",
    "project.resolve",
    "sessions.list",
    "session.get",
    "session.context",
    "session.entryContent",
    "session.new",
    "session.rename",
    "session.delete",
    "session.fork",
    "session.clone",
    "session.navigate",
    "agent.state",
    "agent.prompt",
    "agent.steer",
    "agent.followUp",
    "agent.abort",
    "agent.compact",
    "agent.abortCompact",
    "agent.commands",
    "agent.stats",
    "model.set",
    "thinking.set",
    "extension.respond",
]);
const REQUEST_KEYS = new Set([
    "requestId",
    "action",
    "cwdRef",
    "sessionId",
    "jobId",
    "runId",
    "payload",
]);
const RUN_SCOPED_ACTIONS = new Set([
    "agent.prompt",
    "agent.steer",
    "agent.followUp",
    "agent.abort",
    "agent.compact",
    "agent.abortCompact",
    "extension.respond",
]);
const EVENT_TYPES = new Set([
    "connected",
    "history_changed",
    "agent_start",
    "agent_end",
    "prompt_done",
    "prompt_error",
    "agent_settled",
    "thinking_progress",
    "extension_request",
    "extension_resolved",
    "message_update",
    "run_created",
    "usage_update",
    "status_update",
]);
const RUN_STATUSES = new Set([
    "running",
    "waiting_input",
    "idle",
    "done",
    "error",
]);
const ERROR_CODES = new Set(exports.PI_ERROR_CODES);
const EXTENSION_UI_KINDS = new Set([
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
]);
const INTERACTIVE_EXTENSION_UI_KINDS = new Set([
    "select",
    "confirm",
    "input",
    "editor",
]);
const AGENT_STATUSES = new Set([
    "idle",
    "running",
    "compacting",
    "waiting_for_extension_input",
]);
const MAX_TEXT_CHARS = 16_384;
const MAX_ERROR_MESSAGE_CHARS = 4_096;
const MAX_OPTION_CHARS = 4_096;
const MAX_EXTENSION_OPTIONS = 100;
const MAX_QUEUE_ITEMS = 1_000;
const MAX_STATE_RUNS = 1_000;
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assertRecord(v, what) {
    if (!isRecord(v))
        throw new PiProtocolError(`${what} 必须是对象`);
}
function assertKeys(v, allowed, what) {
    for (const key of Object.keys(v)) {
        if (!allowed.has(key))
            throw new PiProtocolError(`${what} 含未知字段 ${key}`);
    }
}
function assertString(v, what, maxLength) {
    if (typeof v !== "string" || v.length === 0)
        throw new PiProtocolError(`${what} 必须是非空字符串`);
    if (maxLength !== undefined && v.length > maxLength)
        throw new PiProtocolError(`${what} 长度超过上限 ${maxLength}`);
}
function assertOptionalString(v, what, maxLength) {
    if (v !== undefined)
        assertString(v, what, maxLength);
}
function assertSessionJobPair(sessionId, jobId) {
    if (sessionId !== undefined && jobId !== undefined && sessionId !== jobId) {
        throw new PiProtocolError("jobId 必须等于 sessionId");
    }
}
function assertErrorCode(v, what) {
    assertString(v, what);
    if (!ERROR_CODES.has(v))
        throw new PiProtocolError(`${what} 不在 allowlist`);
}
/** 返回可安全出站的 Pi 错误消息，避免泄露任意对象内容。 */
function safePiErrorMessage(value) {
    return typeof value === "string" && value.length > 0
        ? value.slice(0, MAX_ERROR_MESSAGE_CHARS)
        : "Pi request failed";
}
function parseExtensionUi(value, what, interactiveOnly = false) {
    assertRecord(value, what);
    assertKeys(value, new Set([
        "requestId",
        "extensionId",
        "kind",
        "title",
        "message",
        "options",
        "timeoutMs",
    ]), what);
    assertString(value.requestId, `${what}.requestId`, MAX_TEXT_CHARS);
    assertString(value.extensionId, `${what}.extensionId`, MAX_TEXT_CHARS);
    assertString(value.kind, `${what}.kind`);
    const kinds = interactiveOnly
        ? INTERACTIVE_EXTENSION_UI_KINDS
        : EXTENSION_UI_KINDS;
    if (!kinds.has(value.kind))
        throw new PiProtocolError(`${what}.kind 不受支持`);
    assertOptionalString(value.title, `${what}.title`, MAX_TEXT_CHARS);
    assertOptionalString(value.message, `${what}.message`, MAX_TEXT_CHARS);
    if (value.options !== undefined) {
        if (!Array.isArray(value.options))
            throw new PiProtocolError(`${what}.options 必须是数组`);
        if (value.options.length > MAX_EXTENSION_OPTIONS)
            throw new PiProtocolError(`${what}.options 数量超过上限`);
        for (const option of value.options)
            assertString(option, `${what}.options 项`, MAX_OPTION_CHARS);
    }
    if (value.timeoutMs !== undefined &&
        (typeof value.timeoutMs !== "number" ||
            !Number.isFinite(value.timeoutMs) ||
            value.timeoutMs < 0)) {
        throw new PiProtocolError(`${what}.timeoutMs 必须是非负数字`);
    }
    return value;
}
function parseCwdRef(v) {
    assertRecord(v, "cwdRef");
    assertString(v.rootDir, "cwdRef.rootDir");
    assertString(v.relativePath, "cwdRef.relativePath");
    return { rootDir: v.rootDir, relativePath: v.relativePath };
}
function parseAttachments(v) {
    if (!Array.isArray(v))
        throw new PiProtocolError("payload.attachments 必须是数组");
    if (v.length > exports.MAX_PI_IMAGES_PER_PROMPT) {
        throw new PiProtocolError(`图片数量超过上限 ${exports.MAX_PI_IMAGES_PER_PROMPT}`);
    }
    let total = 0;
    const out = [];
    for (const item of v) {
        assertRecord(item, "attachment");
        assertString(item.fileId, "attachment.fileId");
        assertString(item.sha256, "attachment.sha256");
        if (typeof item.size !== "number" || !Number.isFinite(item.size)) {
            throw new PiProtocolError("attachment.size 必须是数字");
        }
        assertString(item.mimeType, "attachment.mimeType");
        if (item.size > exports.MAX_PI_IMAGE_BYTES) {
            throw new PiProtocolError(`单张图片超过上限 ${exports.MAX_PI_IMAGE_BYTES} 字节`);
        }
        total += item.size;
        if (total > exports.MAX_PI_IMAGES_TOTAL_BYTES) {
            throw new PiProtocolError(`图片总量超过上限 ${exports.MAX_PI_IMAGES_TOTAL_BYTES} 字节`);
        }
        out.push({
            fileId: item.fileId,
            sha256: item.sha256,
            size: item.size,
            mimeType: item.mimeType,
            url: typeof item.url === "string" ? item.url : "",
        });
    }
    return out;
}
/** 校验 Server → Client 请求（Client Socket 收到后必须先调用） */
function parsePiRequest(input) {
    assertRecord(input, "PiRequest");
    assertKeys(input, REQUEST_KEYS, "PiRequest");
    assertString(input.requestId, "requestId");
    assertString(input.action, "action");
    if (!ACTIONS.has(input.action))
        throw new PiProtocolError(`未知 action ${String(input.action)}`);
    assertSessionJobPair(input.sessionId, input.jobId);
    if (input.cwdRef !== undefined)
        input.cwdRef = parseCwdRef(input.cwdRef);
    if (input.sessionId !== undefined)
        assertString(input.sessionId, "sessionId");
    if (input.jobId !== undefined)
        assertString(input.jobId, "jobId");
    if (input.runId !== undefined)
        assertString(input.runId, "runId");
    if (RUN_SCOPED_ACTIONS.has(input.action)) {
        if (input.sessionId === undefined)
            throw new PiProtocolError(`${input.action} 缺 sessionId`);
        if (input.jobId === undefined)
            throw new PiProtocolError(`${input.action} 缺 jobId`);
        if (input.runId === undefined)
            throw new PiProtocolError(`${input.action} 缺 runId`);
    }
    if (input.action === "agent.prompt" && input.cwdRef === undefined)
        throw new PiProtocolError("agent.prompt 缺 cwdRef");
    if (input.payload !== undefined) {
        assertRecord(input.payload, "payload");
        if (input.payload.attachments !== undefined) {
            input.payload.attachments = parseAttachments(input.payload.attachments);
        }
    }
    return input;
}
/** 校验 Client → Server 响应（Server Gateway 收到后必须先调用） */
function parsePiResponse(input) {
    assertRecord(input, "PiResponse");
    assertKeys(input, new Set(["requestId", "ok", "data", "error"]), "PiResponse");
    assertString(input.requestId, "requestId");
    if (input.ok !== true && input.ok !== false)
        throw new PiProtocolError("ok 必须是布尔");
    if (input.ok === true) {
        return { requestId: input.requestId, ok: true, data: input.data };
    }
    assertRecord(input.error, "error");
    assertKeys(input.error, new Set(["code", "message"]), "error");
    assertErrorCode(input.error.code, "error.code");
    assertString(input.error.message, "error.message", MAX_ERROR_MESSAGE_CHARS);
    return {
        requestId: input.requestId,
        ok: false,
        error: {
            code: input.error.code,
            message: input.error.message,
        },
    };
}
const MAX_THINKING_TEXT_CHARS = 16_384;
/** 严格校验 Agent 状态快照。 */
function parsePiAgentState(input) {
    assertRecord(input, "PiAgentState");
    assertKeys(input, new Set([
        "status",
        "streaming",
        "prompting",
        "compacting",
        "thinkingLevel",
        "queuedMessages",
        "model",
        "waitingForExtensionInput",
        "pendingExtension",
    ]), "PiAgentState");
    assertString(input.status, "status");
    if (!AGENT_STATUSES.has(input.status))
        throw new PiProtocolError("status 不受支持");
    for (const key of ["streaming", "prompting", "compacting"]) {
        if (typeof input[key] !== "boolean")
            throw new PiProtocolError(`${key} 必须是布尔`);
    }
    if (!isPiThinkingLevel(input.thinkingLevel))
        throw new PiProtocolError("thinkingLevel 不受支持");
    assertRecord(input.queuedMessages, "queuedMessages");
    assertKeys(input.queuedMessages, new Set(["steering", "followUp"]), "queuedMessages");
    for (const key of ["steering", "followUp"]) {
        const queue = input.queuedMessages[key];
        if (!Array.isArray(queue))
            throw new PiProtocolError(`queuedMessages.${key} 必须是数组`);
        if (queue.length > MAX_QUEUE_ITEMS)
            throw new PiProtocolError(`queuedMessages.${key} 数量超过上限`);
    }
    if (input.model !== undefined) {
        assertRecord(input.model, "model");
        assertKeys(input.model, new Set(["provider", "modelId"]), "model");
        assertString(input.model.provider, "model.provider", MAX_TEXT_CHARS);
        assertString(input.model.modelId, "model.modelId", MAX_TEXT_CHARS);
    }
    if (input.waitingForExtensionInput !== undefined &&
        typeof input.waitingForExtensionInput !== "boolean") {
        throw new PiProtocolError("waitingForExtensionInput 必须是布尔");
    }
    if (input.pendingExtension !== undefined)
        input.pendingExtension = parseExtensionUi(input.pendingExtension, "pendingExtension", true);
    return input;
}
const EVENT_KEYS = new Set([
    "clientId",
    "sessionId",
    "jobId",
    "runId",
    "event",
]);
/** 校验 Client → Server 事件包装（Server Gateway 收到后必须先调用） */
function parsePiEvent(input) {
    assertRecord(input, "PiEvent");
    assertKeys(input, EVENT_KEYS, "PiEvent");
    assertString(input.clientId, "clientId");
    assertString(input.sessionId, "sessionId");
    assertString(input.jobId, "jobId");
    assertString(input.runId, "runId");
    assertSessionJobPair(input.sessionId, input.jobId);
    assertRecord(input.event, "event");
    assertString(input.event.type, "event.type");
    if (!EVENT_TYPES.has(input.event.type))
        throw new PiProtocolError(`未知 event 类型 ${String(input.event.type)}`);
    assertString(input.event.sessionId, "event.sessionId");
    if (input.event.sessionId !== input.sessionId)
        throw new PiProtocolError("event.sessionId 必须等于外层 sessionId");
    const common = ["type", "sessionId"];
    switch (input.event.type) {
        case "connected":
        case "history_changed":
        case "agent_start":
        case "agent_end":
        case "prompt_done":
        case "agent_settled":
            assertKeys(input.event, new Set(common), "event");
            break;
        case "prompt_error":
            assertKeys(input.event, new Set([...common, "code", "message"]), "event");
            assertErrorCode(input.event.code, "event.code");
            assertString(input.event.message, "event.message", MAX_ERROR_MESSAGE_CHARS);
            break;
        case "thinking_progress":
            assertKeys(input.event, new Set([...common, "stage", "text", "durationMs"]), "event");
            assertString(input.event.stage, "event.stage", MAX_TEXT_CHARS);
            if (input.event.text !== undefined) {
                assertString(input.event.text, "event.text");
                input.event.text = input.event.text.slice(0, MAX_THINKING_TEXT_CHARS);
            }
            if (input.event.durationMs !== undefined &&
                (typeof input.event.durationMs !== "number" ||
                    !Number.isFinite(input.event.durationMs) ||
                    input.event.durationMs < 0))
                throw new PiProtocolError("event.durationMs 必须是非负数字");
            break;
        case "extension_request":
            assertKeys(input.event, new Set([...common, "ui"]), "event");
            input.event.ui = parseExtensionUi(input.event.ui, "event.ui", true);
            break;
        case "extension_resolved":
            assertKeys(input.event, new Set([...common, "requestId", "reason", "hasPending"]), "event");
            assertString(input.event.requestId, "event.requestId", MAX_TEXT_CHARS);
            if (input.event.reason !== "answered" &&
                input.event.reason !== "cancelled" &&
                input.event.reason !== "timeout")
                throw new PiProtocolError("event.reason 不受支持");
            if (typeof input.event.hasPending !== "boolean")
                throw new PiProtocolError("event.hasPending 必须是布尔");
            break;
        case "message_update":
            assertKeys(input.event, new Set([...common, "text", "role"]), "event");
            assertOptionalString(input.event.text, "event.text", MAX_TEXT_CHARS);
            assertOptionalString(input.event.role, "event.role", MAX_TEXT_CHARS);
            break;
        case "run_created":
            assertKeys(input.event, new Set([...common, "submissionId", "runId"]), "event");
            assertString(input.event.submissionId, "event.submissionId", MAX_TEXT_CHARS);
            assertString(input.event.runId, "event.runId", MAX_TEXT_CHARS);
            break;
        case "usage_update":
            assertKeys(input.event, new Set([...common, "usage"]), "event");
            assertRecord(input.event.usage, "event.usage");
            break;
        case "status_update":
            assertKeys(input.event, new Set([...common, "status"]), "event");
            assertString(input.event.status, "event.status", MAX_TEXT_CHARS);
            break;
    }
    return input;
}
const STATE_KEYS = new Set(["clientId", "runs"]);
/** 校验 Client 运行状态报告（注册/重连时） */
function parsePiStateReport(input) {
    assertRecord(input, "PiStateReport");
    assertKeys(input, STATE_KEYS, "PiStateReport");
    assertString(input.clientId, "clientId");
    if (!Array.isArray(input.runs))
        throw new PiProtocolError("runs 必须是数组");
    if (input.runs.length > MAX_STATE_RUNS)
        throw new PiProtocolError("runs 数量超过上限 1000");
    const runs = [];
    for (const item of input.runs) {
        assertRecord(item, "run");
        assertKeys(item, new Set(["jobId", "runId", "sessionId", "status", "projectKey"]), "run");
        assertString(item.jobId, "run.jobId");
        assertString(item.runId, "run.runId");
        assertString(item.sessionId, "run.sessionId");
        assertSessionJobPair(item.sessionId, item.jobId);
        assertString(item.status, "run.status");
        if (!RUN_STATUSES.has(item.status)) {
            throw new PiProtocolError(`未知 run 状态 ${String(item.status)}`);
        }
        if (item.status === "running" || item.status === "waiting_input") {
            assertString(item.projectKey, "run.projectKey");
        }
        if (item.projectKey !== undefined) {
            assertString(item.projectKey, "run.projectKey");
            if (item.projectKey.length !== exports.PI_PROJECT_KEY_LENGTH) {
                throw new PiProtocolError("projectKey 长度必须为 64");
            }
        }
        runs.push({
            jobId: item.jobId,
            runId: item.runId,
            sessionId: item.sessionId,
            status: item.status,
            projectKey: item.projectKey,
        });
    }
    return { clientId: input.clientId, runs };
}
