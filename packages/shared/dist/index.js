"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFrpRuntimeStateReport = exports.parseFrpRuntimeStateAck = exports.parseFrpReconcileResult = exports.parseFrpReconcilePayload = exports.parseFrpCapabilityStatus = exports.FRP_RECONCILE_PROTOCOL_VERSION = exports.StorageShareErrorCode = exports.FrpJobType = exports.FrpProtocolError = exports.FRP_ERROR_CODES = exports.FRP_MAPPING_STATUSES = exports.StorageProviderKind = exports.AuthErrorCode = exports.FileErrorCode = exports.parsePrivilegedCapabilityStatus = exports.parseMachineRegister = exports.parseMachineInstallation = exports.PrivilegedCapabilityMode = exports.MachineInstallationMode = exports.JobStatus = exports.JobType = exports.Events = exports.safePiErrorMessage = exports.parsePiAgentState = exports.isPiThinkingLevel = exports.isPiAgentIdle = exports.PI_THINKING_LEVELS = exports.PI_SESSION_JOB_PROTOCOL_VERSION = exports.PI_ERROR_CODES = exports.isReleaseArchiveAvailable = exports.platformFromOs = exports.parseReleaseUploadPartRefresh = exports.parseReleaseUploadCreateInput = exports.parseReleaseUploadComplete = exports.ReleaseUploadErrorCode = exports.ReleaseStatus = exports.ReleaseClientState = exports.parseClientInstallerPlatform = exports.parseClientInstallerNameUpdate = exports.parseClientInstallerConfigUpdate = exports.ClientInstallerErrorCode = exports.VERSION = void 0;
exports.parseFrpOperationTimeout = parseFrpOperationTimeout;
exports.parseFrpMappingCreateRequest = parseFrpMappingCreateRequest;
var version_js_1 = require("./version.js");
Object.defineProperty(exports, "VERSION", { enumerable: true, get: function () { return version_js_1.VERSION; } });
// ── Client 一键安装协议 ──
var client_installer_js_1 = require("./client-installer.js");
Object.defineProperty(exports, "ClientInstallerErrorCode", { enumerable: true, get: function () { return client_installer_js_1.ClientInstallerErrorCode; } });
Object.defineProperty(exports, "parseClientInstallerConfigUpdate", { enumerable: true, get: function () { return client_installer_js_1.parseClientInstallerConfigUpdate; } });
Object.defineProperty(exports, "parseClientInstallerNameUpdate", { enumerable: true, get: function () { return client_installer_js_1.parseClientInstallerNameUpdate; } });
Object.defineProperty(exports, "parseClientInstallerPlatform", { enumerable: true, get: function () { return client_installer_js_1.parseClientInstallerPlatform; } });
// ── 自更新协议 ──
__exportStar(require("./update.js"), exports);
// ── 远程 Pi 协议 ──
__exportStar(require("./pi.js"), exports);
// ── 交互式终端协议 ──
__exportStar(require("./terminal.js"), exports);
var update_js_1 = require("./update.js");
Object.defineProperty(exports, "ReleaseClientState", { enumerable: true, get: function () { return update_js_1.ReleaseClientState; } });
Object.defineProperty(exports, "ReleaseStatus", { enumerable: true, get: function () { return update_js_1.ReleaseStatus; } });
Object.defineProperty(exports, "ReleaseUploadErrorCode", { enumerable: true, get: function () { return update_js_1.ReleaseUploadErrorCode; } });
Object.defineProperty(exports, "parseReleaseUploadComplete", { enumerable: true, get: function () { return update_js_1.parseReleaseUploadComplete; } });
Object.defineProperty(exports, "parseReleaseUploadCreateInput", { enumerable: true, get: function () { return update_js_1.parseReleaseUploadCreateInput; } });
Object.defineProperty(exports, "parseReleaseUploadPartRefresh", { enumerable: true, get: function () { return update_js_1.parseReleaseUploadPartRefresh; } });
Object.defineProperty(exports, "platformFromOs", { enumerable: true, get: function () { return update_js_1.platformFromOs; } });
Object.defineProperty(exports, "isReleaseArchiveAvailable", { enumerable: true, get: function () { return update_js_1.isReleaseArchiveAvailable; } });
var pi_js_1 = require("./pi.js");
Object.defineProperty(exports, "PI_ERROR_CODES", { enumerable: true, get: function () { return pi_js_1.PI_ERROR_CODES; } });
Object.defineProperty(exports, "PI_SESSION_JOB_PROTOCOL_VERSION", { enumerable: true, get: function () { return pi_js_1.PI_SESSION_JOB_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "PI_THINKING_LEVELS", { enumerable: true, get: function () { return pi_js_1.PI_THINKING_LEVELS; } });
Object.defineProperty(exports, "isPiAgentIdle", { enumerable: true, get: function () { return pi_js_1.isPiAgentIdle; } });
Object.defineProperty(exports, "isPiThinkingLevel", { enumerable: true, get: function () { return pi_js_1.isPiThinkingLevel; } });
Object.defineProperty(exports, "parsePiAgentState", { enumerable: true, get: function () { return pi_js_1.parsePiAgentState; } });
Object.defineProperty(exports, "safePiErrorMessage", { enumerable: true, get: function () { return pi_js_1.safePiErrorMessage; } });
// ── Event names ──
exports.Events = {
    REGISTER: "register",
    HEARTBEAT: "heartbeat",
    JOB_DISPATCH: "job:dispatch",
    JOB_STDOUT: "job:stdout",
    JOB_STDERR: "job:stderr",
    JOB_DONE: "job:done",
    JOB_PROGRESS: "job:progress",
    JOB_CANCEL: "job:cancel",
    JOB_CANCELLED: "job:cancelled",
    JOB_CANCEL_FAILED: "job:cancel-failed",
    JOB_UPDATE: "job:update",
    STATUS_REPORT: "status:report",
    PI_REQUEST: "pi:request",
    PI_RESPONSE: "pi:response",
    PI_EVENT: "pi:event",
    PI_STATE: "pi:state",
    TERMINAL_REQUEST: "terminal:request",
    TERMINAL_RESPONSE: "terminal:response",
    TERMINAL_OUTPUT: "terminal:output",
    TERMINAL_EXIT: "terminal:exit",
    TERMINAL_STATE: "terminal:state",
    TERMINAL_ATTACH: "terminal:attach",
    TERMINAL_DETACH: "terminal:detach",
    TERMINAL_INPUT: "terminal:input",
    TERMINAL_RESIZE: "terminal:resize",
    TERMINAL_TAKEOVER: "terminal:takeover",
    TERMINAL_ACK_OUTPUT: "terminal:ack-output",
    TERMINAL_RESYNC: "terminal:resync",
    TERMINAL_ATTACHED: "terminal:attached",
    TERMINAL_SNAPSHOT: "terminal:snapshot",
    TERMINAL_CONTROL: "terminal:control",
    TERMINAL_SESSION_STATE: "terminal:session-state",
    TERMINAL_RESYNC_REQUIRED: "terminal:resync-required",
    TERMINAL_ERROR: "terminal:error",
    UPDATE_REQUEST: "update:request",
    UPDATE_READY: "update:ready",
    UPDATE_FAILED: "update:failed",
    SERVER_SHUTDOWN: "server:shutdown",
    FRP_STATE: "frp:state",
    FRP_STATE_ACK: "frp:state-ack",
};
// ── Job type ──
var JobType;
(function (JobType) {
    JobType["EXEC"] = "exec";
    JobType["FILE_LIST"] = "file.list";
    JobType["FILE_STAT"] = "file.stat";
    JobType["FILE_READ_TEXT"] = "file.readText";
    JobType["FILE_WRITE_TEXT"] = "file.writeText";
    JobType["FILE_MKDIR"] = "file.mkdir";
    JobType["FILE_DELETE"] = "file.delete";
    JobType["FILE_MOVE"] = "file.move";
    JobType["FILE_EXPORT"] = "file.export";
    JobType["FILE_IMPORT"] = "file.import";
    JobType["AGENT_RUN"] = "agent.run";
    JobType["AGENT_SESSION"] = "agent.session";
    JobType["FRP_CREATE"] = "frp.create";
    JobType["FRP_DELETE"] = "frp.delete";
    JobType["FRP_LIST"] = "frp.list";
    JobType["FRP_RECONCILE"] = "frp.reconcile";
    JobType["FILE_ROOTS"] = "file.roots";
})(JobType || (exports.JobType = JobType = {}));
// ── Job status ──
var JobStatus;
(function (JobStatus) {
    JobStatus["IDLE"] = "idle";
    JobStatus["PENDING"] = "pending";
    JobStatus["RUNNING"] = "running";
    JobStatus["WAITING_INPUT"] = "waiting_input";
    JobStatus["DONE"] = "done";
    JobStatus["ERROR"] = "error";
    JobStatus["DISCONNECTED"] = "disconnected";
    JobStatus["CANCELLED"] = "cancelled";
})(JobStatus || (exports.JobStatus = JobStatus = {}));
// ── Register / Heartbeat ──
const machine_register_js_1 = require("./machine-register.js");
Object.defineProperty(exports, "MachineInstallationMode", { enumerable: true, get: function () { return machine_register_js_1.MachineInstallationMode; } });
Object.defineProperty(exports, "PrivilegedCapabilityMode", { enumerable: true, get: function () { return machine_register_js_1.PrivilegedCapabilityMode; } });
Object.defineProperty(exports, "parseMachineInstallation", { enumerable: true, get: function () { return machine_register_js_1.parseMachineInstallation; } });
Object.defineProperty(exports, "parseMachineRegister", { enumerable: true, get: function () { return machine_register_js_1.parseMachineRegister; } });
Object.defineProperty(exports, "parsePrivilegedCapabilityStatus", { enumerable: true, get: function () { return machine_register_js_1.parsePrivilegedCapabilityStatus; } });
// ── File 稳定错误码 ──
exports.FileErrorCode = {
    PATH_NOT_FOUND: "PATH_NOT_FOUND",
    PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
    PATH_CONFLICT: "PATH_CONFLICT",
    IO_ERROR: "IO_ERROR",
    SIZE_EXCEEDED: "SIZE_EXCEEDED",
    SHA256_MISMATCH: "SHA256_MISMATCH",
};
exports.AuthErrorCode = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_INVALID: "AUTH_INVALID",
    AUTH_EXPIRED: "AUTH_EXPIRED",
    AUTH_REVOKED: "AUTH_REVOKED",
    IDENTITY_DISABLED: "IDENTITY_DISABLED",
    FORBIDDEN: "FORBIDDEN",
};
// ── 存储后端类型 ──
exports.StorageProviderKind = {
    LOCAL: "local",
};
// ── FRP 端口映射 ──
/** FRP 映射控制面状态。 */
exports.FRP_MAPPING_STATUSES = [
    "provisioning",
    "active",
    "inactive",
    "deleting",
    "error",
    "reconciling",
];
/** FRP 写操作稳定错误码。 */
exports.FRP_ERROR_CODES = [
    "FRPS_DASHBOARD_REQUIRED",
    "FRPS_DASHBOARD_UNREACHABLE",
    "FRPS_DASHBOARD_AUTH_FAILED",
    "FRP_PROXY_NAME_CONFLICT",
    "FRP_PROXY_CONFIRM_TIMEOUT",
    "FRP_PROXY_REMOVE_TIMEOUT",
    "FRP_ROLLBACK_FAILED",
    "FRPC_NOT_FOUND",
    "FRPC_START_FAILED",
    "FRPC_STOP_FAILED",
    "FRP_RECONCILE_BUSY",
    "FRP_RECONCILE_FAILED",
    "FRP_RUNTIME_GENERATION_STALE",
    "FRP_RUNTIME_STATE_INVALID",
    "FRP_RECONCILE_TIMEOUT",
    "FRP_CLIENT_NOT_FOUND",
    "FRP_CLIENT_OFFLINE",
    "FRP_CLIENT_NO_FRP_CAPABILITY",
];
/** FRP 信任边界输入错误。 */
class FrpProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = "FrpProtocolError";
    }
}
exports.FrpProtocolError = FrpProtocolError;
exports.FrpJobType = {
    FRP_CREATE: "frp.create",
    FRP_DELETE: "frp.delete",
    FRP_LIST: "frp.list",
    FRP_RECONCILE: "frp.reconcile",
};
/** Storage 分享相关稳定错误码。 */
exports.StorageShareErrorCode = {
    FILE_NOT_SHAREABLE: "FILE_NOT_SHAREABLE",
    STORAGE_PROVIDER_MISMATCH: "STORAGE_PROVIDER_MISMATCH",
    STORAGE_SHARE_NOT_FOUND: "STORAGE_SHARE_NOT_FOUND",
    FILE_HAS_ACTIVE_SHARES: "FILE_HAS_ACTIVE_SHARES",
};
/** 解析 FRP Dashboard 确认时限，默认 30 秒。 */
function parseFrpOperationTimeout(value) {
    const parsed = value === undefined ? 30 : Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
        throw new FrpProtocolError("timeoutSeconds 必须是 1–300 的整数");
    }
    return parsed;
}
/** 严格解析创建映射 REST 请求。 */
function parseFrpMappingCreateRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FrpProtocolError("FRP 创建请求必须是对象");
    }
    const input = value;
    const allowed = new Set([
        "clientId",
        "name",
        "proxyType",
        "localIp",
        "localPort",
        "remotePort",
        "customDomain",
        "frpsInstanceId",
        "timeoutSeconds",
    ]);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key))
            throw new FrpProtocolError(`FRP 创建请求含未知字段 ${key}`);
    }
    const clientId = frpString(input.clientId, "clientId", 128);
    const proxyType = input.proxyType;
    if (proxyType !== "tcp" && proxyType !== "http" && proxyType !== "https") {
        throw new FrpProtocolError("proxyType 必须是 tcp、http 或 https");
    }
    const localPort = frpPort(input.localPort, "localPort");
    const name = optionalFrpString(input.name, "name", 64, /^[A-Za-z0-9._-]+$/);
    const localIp = optionalFrpString(input.localIp, "localIp", 255, /^[A-Za-z0-9.:%_-]+$/) ?? "127.0.0.1";
    const frpsInstanceId = optionalFrpString(input.frpsInstanceId, "frpsInstanceId", 128);
    const remotePort = input.remotePort === undefined
        ? undefined
        : frpPort(input.remotePort, "remotePort");
    const customDomain = optionalFrpString(input.customDomain, "customDomain", 253, /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/);
    if (proxyType === "tcp" && customDomain) {
        throw new FrpProtocolError("TCP 映射不允许 customDomain");
    }
    if (proxyType !== "tcp" && remotePort !== undefined) {
        throw new FrpProtocolError("HTTP/HTTPS 映射不允许 remotePort");
    }
    if (proxyType !== "tcp" && !customDomain) {
        throw new FrpProtocolError("HTTP/HTTPS 映射必须提供 customDomain");
    }
    return {
        clientId,
        ...(name ? { name } : {}),
        proxyType,
        localIp,
        localPort,
        ...(remotePort !== undefined ? { remotePort } : {}),
        ...(customDomain ? { customDomain } : {}),
        ...(frpsInstanceId ? { frpsInstanceId } : {}),
        timeoutSeconds: parseFrpOperationTimeout(input.timeoutSeconds),
    };
}
function frpString(value, field, maxLength, pattern) {
    if (typeof value !== "string" ||
        value.length < 1 ||
        value.length > maxLength ||
        value !== value.trim() ||
        (pattern && !pattern.test(value))) {
        throw new FrpProtocolError(`${field} 格式无效`);
    }
    return value;
}
function optionalFrpString(value, field, maxLength, pattern) {
    return value === undefined ? undefined : frpString(value, field, maxLength, pattern);
}
function frpPort(value, field) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new FrpProtocolError(`${field} 必须是 1–65535 的整数`);
    }
    return value;
}
// ── FRP Runtime Reconciliation Protocol v1 ──
var frp_runtime_js_1 = require("./frp-runtime.js");
Object.defineProperty(exports, "FRP_RECONCILE_PROTOCOL_VERSION", { enumerable: true, get: function () { return frp_runtime_js_1.FRP_RECONCILE_PROTOCOL_VERSION; } });
Object.defineProperty(exports, "parseFrpCapabilityStatus", { enumerable: true, get: function () { return frp_runtime_js_1.parseFrpCapabilityStatus; } });
Object.defineProperty(exports, "parseFrpReconcilePayload", { enumerable: true, get: function () { return frp_runtime_js_1.parseFrpReconcilePayload; } });
Object.defineProperty(exports, "parseFrpReconcileResult", { enumerable: true, get: function () { return frp_runtime_js_1.parseFrpReconcileResult; } });
Object.defineProperty(exports, "parseFrpRuntimeStateAck", { enumerable: true, get: function () { return frp_runtime_js_1.parseFrpRuntimeStateAck; } });
Object.defineProperty(exports, "parseFrpRuntimeStateReport", { enumerable: true, get: function () { return frp_runtime_js_1.parseFrpRuntimeStateReport; } });
