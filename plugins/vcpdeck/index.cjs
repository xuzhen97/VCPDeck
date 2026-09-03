#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../shared/dist/version.js
var require_version = __commonJS({
  "../shared/dist/version.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.VERSION = void 0;
    exports2.VERSION = "0.6.18";
  }
});

// ../shared/dist/client-installer.js
var require_client_installer = __commonJS({
  "../shared/dist/client-installer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ClientInstallerErrorCode = void 0;
    exports2.parseClientInstallerPlatform = parseClientInstallerPlatform;
    exports2.parseClientInstallerConfigUpdate = parseClientInstallerConfigUpdate;
    exports2.parseClientInstallerNameUpdate = parseClientInstallerNameUpdate;
    exports2.ClientInstallerErrorCode = {
      DISABLED: "CLIENT_INSTALLER_DISABLED",
      RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY",
      ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING",
      PLATFORM_UNSUPPORTED: "CLIENT_INSTALLER_PLATFORM_UNSUPPORTED",
      ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING",
      PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID",
      CLIENT_NOT_FOUND: "CLIENT_INSTALLER_CLIENT_NOT_FOUND"
    };
    function parseClientInstallerPlatform(value) {
      if (value === "win-x64" || value === "linux-x64")
        return value;
      throw new Error("platform \u5FC5\u987B\u4E3A win-x64 \u6216 linux-x64");
    }
    function parseClientInstallerConfigUpdate(value) {
      if (!isRecord2(value) || Object.keys(value).length !== 1 || typeof value.enabled !== "boolean") {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B boolean enabled");
      }
      return { enabled: value.enabled };
    }
    function parseClientInstallerNameUpdate(value) {
      if (!isRecord2(value) || Object.keys(value).length !== 1 || typeof value.name !== "string") {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B string name");
      }
      const name = value.name.trim();
      if (!name || name.length > 100)
        throw new Error("name \u957F\u5EA6\u5FC5\u987B\u4E3A 1-100");
      return { name };
    }
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
  }
});

// ../shared/dist/update.js
var require_update = __commonJS({
  "../shared/dist/update.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ReleaseUploadErrorCode = exports2.ReleaseClientState = exports2.ReleaseStatus = void 0;
    exports2.parseReleaseUploadCreateInput = parseReleaseUploadCreateInput;
    exports2.parseReleaseUploadPartRefresh = parseReleaseUploadPartRefresh;
    exports2.parseReleaseUploadComplete = parseReleaseUploadComplete;
    exports2.isReleaseArchiveAvailable = isReleaseArchiveAvailable;
    exports2.platformFromOs = platformFromOs;
    var ReleaseStatus;
    (function(ReleaseStatus2) {
      ReleaseStatus2["UPLOADED"] = "uploaded";
      ReleaseStatus2["UPDATING_SERVER"] = "updating_server";
      ReleaseStatus2["UPDATING_CLIENTS"] = "updating_clients";
      ReleaseStatus2["DONE"] = "done";
      ReleaseStatus2["FAILED"] = "failed";
    })(ReleaseStatus || (exports2.ReleaseStatus = ReleaseStatus = {}));
    var ReleaseClientState;
    (function(ReleaseClientState2) {
      ReleaseClientState2["PENDING"] = "pending";
      ReleaseClientState2["UPDATING"] = "updating";
      ReleaseClientState2["DONE"] = "done";
      ReleaseClientState2["FAILED"] = "failed";
    })(ReleaseClientState || (exports2.ReleaseClientState = ReleaseClientState = {}));
    exports2.ReleaseUploadErrorCode = {
      DIRECT_UPLOAD_REQUIRED: "RELEASE_DIRECT_UPLOAD_REQUIRED",
      SESSION_NOT_FOUND: "RELEASE_UPLOAD_SESSION_NOT_FOUND",
      SESSION_EXPIRED: "RELEASE_UPLOAD_SESSION_EXPIRED",
      SESSION_CONFLICT: "RELEASE_UPLOAD_SESSION_CONFLICT",
      SIZE_MISMATCH: "RELEASE_UPLOAD_SIZE_MISMATCH",
      PROVIDER_FAILED: "RELEASE_UPLOAD_PROVIDER_FAILED"
    };
    function parseReleaseUploadCreateInput(value) {
      if (!isRecord2(value) || !hasOnlyKeys(value, ["version", "platform", "sha256", "size"])) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B version/platform/sha256/size");
      }
      if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)) {
        throw new Error("version \u683C\u5F0F\u5E94\u4E3A x.y.z");
      }
      if (value.platform !== "win-x64" && value.platform !== "linux-x64") {
        throw new Error("platform \u5E94\u4E3A win-x64 \u6216 linux-x64");
      }
      if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
        throw new Error("sha256 \u5E94\u4E3A 64 \u4F4D\u5C0F\u5199\u5341\u516D\u8FDB\u5236");
      }
      if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 2147483647) {
        throw new Error("size \u5E94\u4E3A 1\u20132147483647 \u7684\u6574\u6570");
      }
      return {
        version: value.version,
        platform: value.platform,
        sha256: value.sha256,
        size: value.size
      };
    }
    function parseReleaseUploadPartRefresh(value) {
      if (!isRecord2(value) || !hasOnlyKeys(value, ["partNumbers"]) || !Array.isArray(value.partNumbers)) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B partNumbers \u6570\u7EC4");
      }
      const partNumbers = value.partNumbers;
      if (partNumbers.length < 1 || partNumbers.length > 100 || partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > 1e4) || new Set(partNumbers).size !== partNumbers.length) {
        throw new Error("partNumbers \u5FC5\u987B\u5305\u542B 1\u2013100 \u4E2A\u4E0D\u91CD\u590D\u7684 1\u201310000 \u6574\u6570");
      }
      return { partNumbers };
    }
    function parseReleaseUploadComplete(value) {
      if (!isRecord2(value) || !hasOnlyKeys(value, ["uploadedBytes"]) || typeof value.uploadedBytes !== "number" || !Number.isSafeInteger(value.uploadedBytes) || value.uploadedBytes < 1 || value.uploadedBytes > 2147483647) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B\u6709\u6548\u6574\u6570 uploadedBytes");
      }
      return { uploadedBytes: value.uploadedBytes };
    }
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function hasOnlyKeys(value, keys) {
      const actual = Object.keys(value);
      return actual.length === keys.length && actual.every((key) => keys.includes(key));
    }
    function isReleaseArchiveAvailable(archive) {
      return Boolean(archive && (archive.availability === void 0 || archive.availability === "available"));
    }
    function platformFromOs(os) {
      if (!os)
        return null;
      const lower = os.toLowerCase();
      if (lower.startsWith("win32") || lower === "win")
        return "win-x64";
      if (lower.startsWith("linux"))
        return "linux-x64";
      return null;
    }
  }
});

// ../shared/dist/pi.js
var require_pi = __commonJS({
  "../shared/dist/pi.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PiProtocolError = exports2.PI_THINKING_LEVELS = exports2.PI_IMAGE_MIME_TYPES = exports2.MAX_PI_IMAGES_TOTAL_BYTES = exports2.MAX_PI_IMAGE_BYTES = exports2.MAX_PI_IMAGES_PER_PROMPT = exports2.PI_PROJECT_KEY_LENGTH = exports2.PI_SESSION_JOB_PROTOCOL_VERSION = exports2.PI_ERROR_CODES = void 0;
    exports2.isPiThinkingLevel = isPiThinkingLevel;
    exports2.isPiAgentIdle = isPiAgentIdle;
    exports2.safePiErrorMessage = safePiErrorMessage;
    exports2.parsePiRequest = parsePiRequest;
    exports2.parsePiResponse = parsePiResponse;
    exports2.parsePiAgentState = parsePiAgentState2;
    exports2.parsePiEvent = parsePiEvent;
    exports2.parsePiStateReport = parsePiStateReport;
    exports2.PI_ERROR_CODES = [
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
      "PI_STATE_PENDING"
    ];
    exports2.PI_SESSION_JOB_PROTOCOL_VERSION = 1;
    exports2.PI_PROJECT_KEY_LENGTH = 64;
    exports2.MAX_PI_IMAGES_PER_PROMPT = 10;
    exports2.MAX_PI_IMAGE_BYTES = 10 * 1024 * 1024;
    exports2.MAX_PI_IMAGES_TOTAL_BYTES = 100 * 1024 * 1024;
    exports2.PI_IMAGE_MIME_TYPES = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp"
    ];
    exports2.PI_THINKING_LEVELS = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ];
    function isPiThinkingLevel(value) {
      return typeof value === "string" && exports2.PI_THINKING_LEVELS.includes(value);
    }
    function isPiAgentIdle(state) {
      return state.status === "idle" && state.streaming === false && state.prompting === false && state.compacting === false && state.pendingExtension === void 0 && state.waitingForExtensionInput !== true && state.queuedMessages.steering.length === 0 && state.queuedMessages.followUp.length === 0;
    }
    var PiProtocolError = class extends Error {
      code = "PI_PROTOCOL_INVALID";
      constructor(message) {
        super(message);
        this.name = "PiProtocolError";
      }
    };
    exports2.PiProtocolError = PiProtocolError;
    var ACTIONS = /* @__PURE__ */ new Set([
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
      "extension.respond"
    ]);
    var REQUEST_KEYS = /* @__PURE__ */ new Set([
      "requestId",
      "action",
      "cwdRef",
      "sessionId",
      "jobId",
      "runId",
      "payload"
    ]);
    var RUN_SCOPED_ACTIONS = /* @__PURE__ */ new Set([
      "agent.prompt",
      "agent.steer",
      "agent.followUp",
      "agent.abort",
      "agent.compact",
      "agent.abortCompact",
      "extension.respond"
    ]);
    var EVENT_TYPES = /* @__PURE__ */ new Set([
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
      "status_update"
    ]);
    var RUN_STATUSES = /* @__PURE__ */ new Set([
      "running",
      "waiting_input",
      "idle",
      "done",
      "error"
    ]);
    var ERROR_CODES = new Set(exports2.PI_ERROR_CODES);
    var EXTENSION_UI_KINDS = /* @__PURE__ */ new Set([
      "select",
      "confirm",
      "input",
      "editor",
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text"
    ]);
    var INTERACTIVE_EXTENSION_UI_KINDS = /* @__PURE__ */ new Set([
      "select",
      "confirm",
      "input",
      "editor"
    ]);
    var AGENT_STATUSES = /* @__PURE__ */ new Set([
      "idle",
      "running",
      "compacting",
      "waiting_for_extension_input"
    ]);
    var MAX_TEXT_CHARS = 16384;
    var MAX_ERROR_MESSAGE_CHARS = 4096;
    var MAX_OPTION_CHARS = 4096;
    var MAX_EXTENSION_OPTIONS = 100;
    var MAX_QUEUE_ITEMS = 1e3;
    var MAX_STATE_RUNS = 1e3;
    function isRecord2(v) {
      return typeof v === "object" && v !== null && !Array.isArray(v);
    }
    function assertRecord(v, what) {
      if (!isRecord2(v))
        throw new PiProtocolError(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
    }
    function assertKeys(v, allowed, what) {
      for (const key of Object.keys(v)) {
        if (!allowed.has(key))
          throw new PiProtocolError(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
    }
    function assertString(v, what, maxLength) {
      if (typeof v !== "string" || v.length === 0)
        throw new PiProtocolError(`${what} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      if (maxLength !== void 0 && v.length > maxLength)
        throw new PiProtocolError(`${what} \u957F\u5EA6\u8D85\u8FC7\u4E0A\u9650 ${maxLength}`);
    }
    function assertOptionalString(v, what, maxLength) {
      if (v !== void 0)
        assertString(v, what, maxLength);
    }
    function assertSessionJobPair(sessionId, jobId) {
      if (sessionId !== void 0 && jobId !== void 0 && sessionId !== jobId) {
        throw new PiProtocolError("jobId \u5FC5\u987B\u7B49\u4E8E sessionId");
      }
    }
    function assertErrorCode(v, what) {
      assertString(v, what);
      if (!ERROR_CODES.has(v))
        throw new PiProtocolError(`${what} \u4E0D\u5728 allowlist`);
    }
    function safePiErrorMessage(value) {
      return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_ERROR_MESSAGE_CHARS) : "Pi request failed";
    }
    function parseExtensionUi(value, what, interactiveOnly = false) {
      assertRecord(value, what);
      assertKeys(value, /* @__PURE__ */ new Set([
        "requestId",
        "extensionId",
        "kind",
        "title",
        "message",
        "options",
        "timeoutMs"
      ]), what);
      assertString(value.requestId, `${what}.requestId`, MAX_TEXT_CHARS);
      assertString(value.extensionId, `${what}.extensionId`, MAX_TEXT_CHARS);
      assertString(value.kind, `${what}.kind`);
      const kinds = interactiveOnly ? INTERACTIVE_EXTENSION_UI_KINDS : EXTENSION_UI_KINDS;
      if (!kinds.has(value.kind))
        throw new PiProtocolError(`${what}.kind \u4E0D\u53D7\u652F\u6301`);
      assertOptionalString(value.title, `${what}.title`, MAX_TEXT_CHARS);
      assertOptionalString(value.message, `${what}.message`, MAX_TEXT_CHARS);
      if (value.options !== void 0) {
        if (!Array.isArray(value.options))
          throw new PiProtocolError(`${what}.options \u5FC5\u987B\u662F\u6570\u7EC4`);
        if (value.options.length > MAX_EXTENSION_OPTIONS)
          throw new PiProtocolError(`${what}.options \u6570\u91CF\u8D85\u8FC7\u4E0A\u9650`);
        for (const option of value.options)
          assertString(option, `${what}.options \u9879`, MAX_OPTION_CHARS);
      }
      if (value.timeoutMs !== void 0 && (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs < 0)) {
        throw new PiProtocolError(`${what}.timeoutMs \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57`);
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
        throw new PiProtocolError("payload.attachments \u5FC5\u987B\u662F\u6570\u7EC4");
      if (v.length > exports2.MAX_PI_IMAGES_PER_PROMPT) {
        throw new PiProtocolError(`\u56FE\u7247\u6570\u91CF\u8D85\u8FC7\u4E0A\u9650 ${exports2.MAX_PI_IMAGES_PER_PROMPT}`);
      }
      let total = 0;
      const out = [];
      for (const item of v) {
        assertRecord(item, "attachment");
        assertString(item.fileId, "attachment.fileId");
        assertString(item.sha256, "attachment.sha256");
        if (typeof item.size !== "number" || !Number.isFinite(item.size)) {
          throw new PiProtocolError("attachment.size \u5FC5\u987B\u662F\u6570\u5B57");
        }
        assertString(item.mimeType, "attachment.mimeType");
        if (item.size > exports2.MAX_PI_IMAGE_BYTES) {
          throw new PiProtocolError(`\u5355\u5F20\u56FE\u7247\u8D85\u8FC7\u4E0A\u9650 ${exports2.MAX_PI_IMAGE_BYTES} \u5B57\u8282`);
        }
        total += item.size;
        if (total > exports2.MAX_PI_IMAGES_TOTAL_BYTES) {
          throw new PiProtocolError(`\u56FE\u7247\u603B\u91CF\u8D85\u8FC7\u4E0A\u9650 ${exports2.MAX_PI_IMAGES_TOTAL_BYTES} \u5B57\u8282`);
        }
        out.push({
          fileId: item.fileId,
          sha256: item.sha256,
          size: item.size,
          mimeType: item.mimeType,
          url: typeof item.url === "string" ? item.url : ""
        });
      }
      return out;
    }
    function parsePiRequest(input) {
      assertRecord(input, "PiRequest");
      assertKeys(input, REQUEST_KEYS, "PiRequest");
      assertString(input.requestId, "requestId");
      assertString(input.action, "action");
      if (!ACTIONS.has(input.action))
        throw new PiProtocolError(`\u672A\u77E5 action ${String(input.action)}`);
      assertSessionJobPair(input.sessionId, input.jobId);
      if (input.cwdRef !== void 0)
        input.cwdRef = parseCwdRef(input.cwdRef);
      if (input.sessionId !== void 0)
        assertString(input.sessionId, "sessionId");
      if (input.jobId !== void 0)
        assertString(input.jobId, "jobId");
      if (input.runId !== void 0)
        assertString(input.runId, "runId");
      if (RUN_SCOPED_ACTIONS.has(input.action)) {
        if (input.sessionId === void 0)
          throw new PiProtocolError(`${input.action} \u7F3A sessionId`);
        if (input.jobId === void 0)
          throw new PiProtocolError(`${input.action} \u7F3A jobId`);
        if (input.runId === void 0)
          throw new PiProtocolError(`${input.action} \u7F3A runId`);
      }
      if (input.action === "agent.prompt" && input.cwdRef === void 0)
        throw new PiProtocolError("agent.prompt \u7F3A cwdRef");
      if (input.payload !== void 0) {
        assertRecord(input.payload, "payload");
        if (input.payload.attachments !== void 0) {
          input.payload.attachments = parseAttachments(input.payload.attachments);
        }
      }
      return input;
    }
    function parsePiResponse(input) {
      assertRecord(input, "PiResponse");
      assertKeys(input, /* @__PURE__ */ new Set(["requestId", "ok", "data", "error"]), "PiResponse");
      assertString(input.requestId, "requestId");
      if (input.ok !== true && input.ok !== false)
        throw new PiProtocolError("ok \u5FC5\u987B\u662F\u5E03\u5C14");
      if (input.ok === true) {
        return { requestId: input.requestId, ok: true, data: input.data };
      }
      assertRecord(input.error, "error");
      assertKeys(input.error, /* @__PURE__ */ new Set(["code", "message"]), "error");
      assertErrorCode(input.error.code, "error.code");
      assertString(input.error.message, "error.message", MAX_ERROR_MESSAGE_CHARS);
      return {
        requestId: input.requestId,
        ok: false,
        error: {
          code: input.error.code,
          message: input.error.message
        }
      };
    }
    var MAX_THINKING_TEXT_CHARS = 16384;
    function parsePiAgentState2(input) {
      assertRecord(input, "PiAgentState");
      assertKeys(input, /* @__PURE__ */ new Set([
        "status",
        "streaming",
        "prompting",
        "compacting",
        "thinkingLevel",
        "queuedMessages",
        "model",
        "waitingForExtensionInput",
        "pendingExtension"
      ]), "PiAgentState");
      assertString(input.status, "status");
      if (!AGENT_STATUSES.has(input.status))
        throw new PiProtocolError("status \u4E0D\u53D7\u652F\u6301");
      for (const key of ["streaming", "prompting", "compacting"]) {
        if (typeof input[key] !== "boolean")
          throw new PiProtocolError(`${key} \u5FC5\u987B\u662F\u5E03\u5C14`);
      }
      if (!isPiThinkingLevel(input.thinkingLevel))
        throw new PiProtocolError("thinkingLevel \u4E0D\u53D7\u652F\u6301");
      assertRecord(input.queuedMessages, "queuedMessages");
      assertKeys(input.queuedMessages, /* @__PURE__ */ new Set(["steering", "followUp"]), "queuedMessages");
      for (const key of ["steering", "followUp"]) {
        const queue = input.queuedMessages[key];
        if (!Array.isArray(queue))
          throw new PiProtocolError(`queuedMessages.${key} \u5FC5\u987B\u662F\u6570\u7EC4`);
        if (queue.length > MAX_QUEUE_ITEMS)
          throw new PiProtocolError(`queuedMessages.${key} \u6570\u91CF\u8D85\u8FC7\u4E0A\u9650`);
      }
      if (input.model !== void 0) {
        assertRecord(input.model, "model");
        assertKeys(input.model, /* @__PURE__ */ new Set(["provider", "modelId"]), "model");
        assertString(input.model.provider, "model.provider", MAX_TEXT_CHARS);
        assertString(input.model.modelId, "model.modelId", MAX_TEXT_CHARS);
      }
      if (input.waitingForExtensionInput !== void 0 && typeof input.waitingForExtensionInput !== "boolean") {
        throw new PiProtocolError("waitingForExtensionInput \u5FC5\u987B\u662F\u5E03\u5C14");
      }
      if (input.pendingExtension !== void 0)
        input.pendingExtension = parseExtensionUi(input.pendingExtension, "pendingExtension", true);
      return input;
    }
    var EVENT_KEYS = /* @__PURE__ */ new Set([
      "clientId",
      "sessionId",
      "jobId",
      "runId",
      "event"
    ]);
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
        throw new PiProtocolError(`\u672A\u77E5 event \u7C7B\u578B ${String(input.event.type)}`);
      assertString(input.event.sessionId, "event.sessionId");
      if (input.event.sessionId !== input.sessionId)
        throw new PiProtocolError("event.sessionId \u5FC5\u987B\u7B49\u4E8E\u5916\u5C42 sessionId");
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
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "code", "message"]), "event");
          assertErrorCode(input.event.code, "event.code");
          assertString(input.event.message, "event.message", MAX_ERROR_MESSAGE_CHARS);
          break;
        case "thinking_progress":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "stage", "text", "durationMs"]), "event");
          assertString(input.event.stage, "event.stage", MAX_TEXT_CHARS);
          if (input.event.text !== void 0) {
            assertString(input.event.text, "event.text");
            input.event.text = input.event.text.slice(0, MAX_THINKING_TEXT_CHARS);
          }
          if (input.event.durationMs !== void 0 && (typeof input.event.durationMs !== "number" || !Number.isFinite(input.event.durationMs) || input.event.durationMs < 0))
            throw new PiProtocolError("event.durationMs \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57");
          break;
        case "extension_request":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "ui"]), "event");
          input.event.ui = parseExtensionUi(input.event.ui, "event.ui", true);
          break;
        case "extension_resolved":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "requestId", "reason", "hasPending"]), "event");
          assertString(input.event.requestId, "event.requestId", MAX_TEXT_CHARS);
          if (input.event.reason !== "answered" && input.event.reason !== "cancelled" && input.event.reason !== "timeout")
            throw new PiProtocolError("event.reason \u4E0D\u53D7\u652F\u6301");
          if (typeof input.event.hasPending !== "boolean")
            throw new PiProtocolError("event.hasPending \u5FC5\u987B\u662F\u5E03\u5C14");
          break;
        case "message_update":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "text", "role"]), "event");
          assertOptionalString(input.event.text, "event.text", MAX_TEXT_CHARS);
          assertOptionalString(input.event.role, "event.role", MAX_TEXT_CHARS);
          break;
        case "run_created":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "submissionId", "runId"]), "event");
          assertString(input.event.submissionId, "event.submissionId", MAX_TEXT_CHARS);
          assertString(input.event.runId, "event.runId", MAX_TEXT_CHARS);
          break;
        case "usage_update":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "usage"]), "event");
          assertRecord(input.event.usage, "event.usage");
          break;
        case "status_update":
          assertKeys(input.event, /* @__PURE__ */ new Set([...common, "status"]), "event");
          assertString(input.event.status, "event.status", MAX_TEXT_CHARS);
          break;
      }
      return input;
    }
    var STATE_KEYS = /* @__PURE__ */ new Set(["clientId", "runs"]);
    function parsePiStateReport(input) {
      assertRecord(input, "PiStateReport");
      assertKeys(input, STATE_KEYS, "PiStateReport");
      assertString(input.clientId, "clientId");
      if (!Array.isArray(input.runs))
        throw new PiProtocolError("runs \u5FC5\u987B\u662F\u6570\u7EC4");
      if (input.runs.length > MAX_STATE_RUNS)
        throw new PiProtocolError("runs \u6570\u91CF\u8D85\u8FC7\u4E0A\u9650 1000");
      const runs = [];
      for (const item of input.runs) {
        assertRecord(item, "run");
        assertKeys(item, /* @__PURE__ */ new Set(["jobId", "runId", "sessionId", "status", "projectKey"]), "run");
        assertString(item.jobId, "run.jobId");
        assertString(item.runId, "run.runId");
        assertString(item.sessionId, "run.sessionId");
        assertSessionJobPair(item.sessionId, item.jobId);
        assertString(item.status, "run.status");
        if (!RUN_STATUSES.has(item.status)) {
          throw new PiProtocolError(`\u672A\u77E5 run \u72B6\u6001 ${String(item.status)}`);
        }
        if (item.status === "running" || item.status === "waiting_input") {
          assertString(item.projectKey, "run.projectKey");
        }
        if (item.projectKey !== void 0) {
          assertString(item.projectKey, "run.projectKey");
          if (item.projectKey.length !== exports2.PI_PROJECT_KEY_LENGTH) {
            throw new PiProtocolError("projectKey \u957F\u5EA6\u5FC5\u987B\u4E3A 64");
          }
        }
        runs.push({
          jobId: item.jobId,
          runId: item.runId,
          sessionId: item.sessionId,
          status: item.status,
          projectKey: item.projectKey
        });
      }
      return { clientId: input.clientId, runs };
    }
  }
});

// ../shared/dist/terminal.js
var require_terminal = __commonJS({
  "../shared/dist/terminal.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TERMINAL_SHELL_KINDS = exports2.TerminalProtocolError = exports2.TerminalLimits = exports2.TERMINAL_AUDIT_EVENTS = exports2.TERMINAL_SESSION_STATUSES = exports2.TERMINAL_ERROR_CODES = void 0;
    exports2.terminalErrorCode = terminalErrorCode;
    exports2.safeTerminalErrorMessage = safeTerminalErrorMessage;
    exports2.isTerminalSessionStatus = isTerminalSessionStatus;
    exports2.isTerminalAuditEventName = isTerminalAuditEventName;
    exports2.utf8ByteLength = utf8ByteLength;
    exports2.isValidTerminalSize = isValidTerminalSize;
    exports2.parseTerminalCapabilityStatus = parseTerminalCapabilityStatus;
    exports2.parseTerminalShellInfo = parseTerminalShellInfo;
    exports2.parseTerminalSessionInfo = parseTerminalSessionInfo;
    exports2.parseTerminalAuditInfo = parseTerminalAuditInfo;
    exports2.parseTerminalSessionCreateRequest = parseTerminalSessionCreateRequest;
    exports2.parseTerminalClientRequest = parseTerminalClientRequest;
    exports2.parseTerminalClientResponse = parseTerminalClientResponse;
    exports2.parseTerminalOutputChunk = parseTerminalOutputChunk;
    exports2.parseTerminalExitReport = parseTerminalExitReport;
    exports2.parseTerminalStateReport = parseTerminalStateReport;
    exports2.parseTerminalStateAck = parseTerminalStateAck;
    exports2.parseTerminalBrowserAttach = parseTerminalBrowserAttach;
    exports2.parseTerminalBrowserInput = parseTerminalBrowserInput;
    exports2.parseTerminalBrowserResize = parseTerminalBrowserResize;
    exports2.parseTerminalBrowserTakeover = parseTerminalBrowserTakeover;
    exports2.parseTerminalBrowserDetach = parseTerminalBrowserDetach;
    exports2.parseTerminalBrowserAckOutput = parseTerminalBrowserAckOutput;
    exports2.parseTerminalBrowserResync = parseTerminalBrowserResync;
    exports2.parseTerminalBrowserAttached = parseTerminalBrowserAttached;
    exports2.parseTerminalSnapshotMessage = parseTerminalSnapshotMessage;
    exports2.parseTerminalControlState = parseTerminalControlState;
    exports2.parseTerminalSessionStateMessage = parseTerminalSessionStateMessage;
    exports2.parseTerminalError = parseTerminalError;
    exports2.TERMINAL_ERROR_CODES = [
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
      "TERMINAL_PROTOCOL_INVALID"
    ];
    function terminalErrorCode(code, message) {
      return { code, message };
    }
    function safeTerminalErrorMessage(value) {
      return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : "Terminal operation failed";
    }
    exports2.TERMINAL_SESSION_STATUSES = [
      "starting",
      "active",
      "detached",
      "exited",
      "interrupted",
      "expired",
      "closed",
      "error"
    ];
    exports2.TERMINAL_AUDIT_EVENTS = [
      "created",
      "create_failed",
      "attached",
      "detached",
      "takeover",
      "closed",
      "expired",
      "exited",
      "interrupted"
    ];
    function isTerminalSessionStatus(v) {
      return typeof v === "string" && exports2.TERMINAL_SESSION_STATUSES.includes(v);
    }
    function isTerminalAuditEventName(v) {
      return typeof v === "string" && exports2.TERMINAL_AUDIT_EVENTS.includes(v);
    }
    exports2.TerminalLimits = {
      maxSessionsPerClient: 5,
      reconnectGraceMs: 3e4,
      detachedTtlMs: 30 * 6e4,
      maxInputBytes: 64 * 1024,
      maxOutputChunkBytes: 64 * 1024,
      maxSnapshotBytes: 8 * 1024 * 1024,
      syncBacklogBytes: 2 * 1024 * 1024,
      scrollbackLines: 2e3,
      /** 慢消费者：live 状态下 ack 落后超过该块数即标记 resync */
      slowConsumerGapBlocks: 512,
      minCols: 20,
      maxCols: 500,
      minRows: 5,
      maxRows: 300,
      maxStateSessions: 5
    };
    function utf8ByteLength(value) {
      return new TextEncoder().encode(value).byteLength;
    }
    function isValidTerminalSize(cols, rows) {
      return Number.isInteger(cols) && Number.isInteger(rows) && cols >= exports2.TerminalLimits.minCols && cols <= exports2.TerminalLimits.maxCols && rows >= exports2.TerminalLimits.minRows && rows <= exports2.TerminalLimits.maxRows;
    }
    var TerminalProtocolError = class extends Error {
      code = "TERMINAL_PROTOCOL_INVALID";
      constructor(message) {
        super(message);
        this.name = "TerminalProtocolError";
      }
    };
    exports2.TerminalProtocolError = TerminalProtocolError;
    function isRecord2(v) {
      return typeof v === "object" && v !== null && !Array.isArray(v);
    }
    function assertRecord(v, what) {
      if (!isRecord2(v))
        throw new TerminalProtocolError(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
    }
    function assertKeys(v, allowed, what) {
      for (const key of Object.keys(v)) {
        if (!allowed.has(key))
          throw new TerminalProtocolError(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
    }
    function assertString(v, what, maxBytes) {
      if (typeof v !== "string" || v.length === 0)
        throw new TerminalProtocolError(`${what} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      if (maxBytes !== void 0 && utf8ByteLength(v) > maxBytes)
        throw new TerminalProtocolError(`${what} \u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650`);
    }
    function assertOptionalString(v, what, maxBytes) {
      if (v !== void 0)
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
      if (!exports2.TERMINAL_ERROR_CODES.includes(v))
        throw new TerminalProtocolError(`${what} \u4E0D\u5728 allowlist`);
    }
    function assertTerminalSize(v, what) {
      const cols = v.cols;
      const rows = v.rows;
      if (typeof cols !== "number" || typeof rows !== "number" || !isValidTerminalSize(cols, rows)) {
        throw new TerminalProtocolError(`${what} \u5C3A\u5BF8\u975E\u6CD5`);
      }
    }
    function assertDate(v, what) {
      assertString(v, what, 64);
      if (Number.isNaN(Date.parse(v)))
        throw new TerminalProtocolError(`${what} \u4E0D\u662F\u5408\u6CD5\u65E5\u671F`);
    }
    function assertOptionalDate(v, what) {
      if (v !== void 0)
        assertDate(v, what);
    }
    function parseTerminalCapabilityStatus(v) {
      assertRecord(v, "capabilityDetails.terminal");
      assertKeys(v, /* @__PURE__ */ new Set(["available", "backend", "code", "message"]), "capabilityDetails.terminal");
      if (typeof v.available !== "boolean")
        throw new TerminalProtocolError("capabilityDetails.terminal.available \u5FC5\u987B\u662F\u5E03\u5C14");
      if (v.backend !== void 0 && v.backend !== "conpty" && v.backend !== "pty") {
        throw new TerminalProtocolError("capabilityDetails.terminal.backend \u4E0D\u53D7\u652F\u6301");
      }
      if (v.code !== void 0)
        assertErrorCode(v.code, "capabilityDetails.terminal.code");
      if (v.message !== void 0)
        assertString(v.message, "capabilityDetails.terminal.message", 200);
      return v;
    }
    exports2.TERMINAL_SHELL_KINDS = [
      "pwsh",
      "powershell",
      "cmd",
      "bash",
      "zsh",
      "sh",
      "other"
    ];
    function parseTerminalShellInfo(v) {
      assertRecord(v, "shell");
      assertKeys(v, /* @__PURE__ */ new Set(["id", "label", "kind", "isDefault"]), "shell");
      assertString(v.id, "shell.id", 64);
      assertString(v.label, "shell.label", 64);
      if (typeof v.kind !== "string" || !exports2.TERMINAL_SHELL_KINDS.includes(v.kind)) {
        throw new TerminalProtocolError("shell.kind \u4E0D\u53D7\u652F\u6301");
      }
      if (typeof v.isDefault !== "boolean")
        throw new TerminalProtocolError("shell.isDefault \u5FC5\u987B\u662F\u5E03\u5C14");
      return v;
    }
    function parseTerminalSessionInfo(v) {
      assertRecord(v, "session");
      assertKeys(v, /* @__PURE__ */ new Set([
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
        "errorCode"
      ]), "session");
      const r = v;
      assertSessionId(r.sessionId);
      assertString(r.clientId, "clientId", 128);
      assertString(r.shellId, "shellId", 64);
      assertString(r.shellLabel, "shellLabel", 64);
      if (!isTerminalSessionStatus(r.status))
        throw new TerminalProtocolError("session.status \u4E0D\u53D7\u652F\u6301");
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
        "endedAt"
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
      assertKeys(v, /* @__PURE__ */ new Set([
        "id",
        "sessionId",
        "clientId",
        "event",
        "identityId",
        "actorName",
        "source",
        "result",
        "reason",
        "createdAt"
      ]), "audit");
      assertString(v.id, "audit.id", 128);
      assertSessionId(v.sessionId);
      assertString(v.clientId, "clientId", 128);
      if (!isTerminalAuditEventName(v.event))
        throw new TerminalProtocolError("audit.event \u4E0D\u53D7\u652F\u6301");
      for (const key of ["identityId", "actorName", "source"]) {
        if (v[key] !== null)
          assertOptionalString(v[key], key, 128);
      }
      if (v.result !== "ok" && v.result !== "error")
        throw new TerminalProtocolError("audit.result \u4E0D\u53D7\u652F\u6301");
      if (v.reason !== null)
        assertOptionalString(v.reason, "audit.reason", 200);
      assertDate(v.createdAt, "createdAt");
      return v;
    }
    function parseTerminalSessionCreateRequest(v) {
      assertRecord(v, "create");
      assertKeys(v, /* @__PURE__ */ new Set(["shellId", "cols", "rows"]), "create");
      assertString(v.shellId, "shellId", 64);
      if (typeof v.cols !== "number" || typeof v.rows !== "number" || !isValidTerminalSize(v.cols, v.rows)) {
        throw new TerminalProtocolError("create \u5C3A\u5BF8\u975E\u6CD5");
      }
      return v;
    }
    var CLIENT_REQUEST_KEYS = {
      "shells.list": /* @__PURE__ */ new Set(["requestId", "action"]),
      "session.create": /* @__PURE__ */ new Set([
        "requestId",
        "action",
        "sessionId",
        "shellId",
        "cols",
        "rows"
      ]),
      "session.attach": /* @__PURE__ */ new Set(["requestId", "action", "sessionId"]),
      "session.detach": /* @__PURE__ */ new Set(["requestId", "action", "sessionId"]),
      "session.input": /* @__PURE__ */ new Set(["requestId", "action", "sessionId", "data"]),
      "session.resize": /* @__PURE__ */ new Set([
        "requestId",
        "action",
        "sessionId",
        "cols",
        "rows"
      ]),
      "session.snapshot": /* @__PURE__ */ new Set(["requestId", "action", "sessionId"]),
      "session.close": /* @__PURE__ */ new Set(["requestId", "action", "sessionId", "reason"])
    };
    function parseTerminalClientRequest(v) {
      assertRecord(v, "request");
      assertRequestId(v.requestId);
      if (typeof v.action !== "string" || !(v.action in CLIENT_REQUEST_KEYS)) {
        throw new TerminalProtocolError(`\u672A\u77E5 action ${String(v.action)}`);
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
          assertString(v.data, "data", exports2.TerminalLimits.maxInputBytes);
          break;
        }
        case "session.resize":
          assertSessionId(v.sessionId);
          assertTerminalSize(v, "resize");
          break;
        case "session.close": {
          assertSessionId(v.sessionId);
          if (v.reason !== "closed" && v.reason !== "expired")
            throw new TerminalProtocolError("close.reason \u4E0D\u53D7\u652F\u6301");
          break;
        }
      }
      return v;
    }
    function parseTerminalClientResponse(v) {
      assertRecord(v, "response");
      assertRequestId(v.requestId);
      if (typeof v.ok !== "boolean")
        throw new TerminalProtocolError("response.ok \u5FC5\u987B\u662F\u5E03\u5C14");
      if (v.ok === false) {
        assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "error"]), "response");
        assertRecord(v.error, "response.error");
        assertKeys(v.error, /* @__PURE__ */ new Set(["code", "message"]), "response.error");
        assertErrorCode(v.error.code, "response.error.code");
        assertString(v.error.message, "response.error.message", 200);
        return v;
      }
      if (typeof v.action !== "string")
        throw new TerminalProtocolError("response.action \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      switch (v.action) {
        case "shells.list": {
          assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "action", "shells"]), "response");
          if (!Array.isArray(v.shells) || v.shells.length > 10)
            throw new TerminalProtocolError("response.shells \u5FC5\u987B\u662F\u6570\u7EC4");
          for (const shell of v.shells)
            parseTerminalShellInfo(shell);
          return v;
        }
        case "session.create": {
          assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "action", "sessionId", "status"]), "response");
          assertSessionId(v.sessionId);
          if (v.status !== "active" && v.status !== "detached")
            throw new TerminalProtocolError("create.status \u4E0D\u53D7\u652F\u6301");
          return v;
        }
        case "session.attach":
        case "session.snapshot": {
          assertKeys(v, /* @__PURE__ */ new Set([
            "requestId",
            "ok",
            "action",
            "sessionId",
            "snapshot",
            "snapshotSeq",
            "cols",
            "rows",
            "historyTruncated"
          ]), "response");
          assertSessionId(v.sessionId);
          assertString(v.snapshot, "snapshot", exports2.TerminalLimits.maxSnapshotBytes);
          if (typeof v.snapshotSeq !== "number" || !Number.isInteger(v.snapshotSeq) || v.snapshotSeq < 0) {
            throw new TerminalProtocolError("snapshotSeq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
          }
          assertTerminalSize(v, "response");
          if (typeof v.historyTruncated !== "boolean")
            throw new TerminalProtocolError("historyTruncated \u5FC5\u987B\u662F\u5E03\u5C14");
          return v;
        }
        case "session.detach":
        case "session.input": {
          assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "action", "sessionId"]), "response");
          assertSessionId(v.sessionId);
          return v;
        }
        case "session.resize": {
          assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "action", "sessionId", "cols", "rows"]), "response");
          assertSessionId(v.sessionId);
          assertTerminalSize(v, "response");
          return v;
        }
        case "session.close": {
          assertKeys(v, /* @__PURE__ */ new Set(["requestId", "ok", "action", "sessionId", "status"]), "response");
          assertSessionId(v.sessionId);
          if (v.status !== "closed")
            throw new TerminalProtocolError("close.status \u4E0D\u53D7\u652F\u6301");
          return v;
        }
        default:
          throw new TerminalProtocolError(`\u672A\u77E5 action ${String(v.action)}`);
      }
    }
    function parseTerminalOutputChunk(v) {
      assertRecord(v, "chunk");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "seq", "data"]), "chunk");
      assertSessionId(v.sessionId);
      if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 1) {
        throw new TerminalProtocolError("chunk.seq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
      }
      assertString(v.data, "data", exports2.TerminalLimits.maxOutputChunkBytes);
      return v;
    }
    function parseTerminalExitReport(v) {
      assertRecord(v, "exit");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "exitCode"]), "exit");
      assertSessionId(v.sessionId);
      if (typeof v.exitCode !== "number" || !Number.isInteger(v.exitCode)) {
        throw new TerminalProtocolError("exit.exitCode \u5FC5\u987B\u662F\u6574\u6570");
      }
      return v;
    }
    function parseTerminalStateReport(v) {
      assertRecord(v, "state");
      assertKeys(v, /* @__PURE__ */ new Set(["clientId", "generationId", "sessions"]), "state");
      assertString(v.clientId, "clientId", 128);
      assertString(v.generationId, "generationId", 128);
      if (!Array.isArray(v.sessions) || v.sessions.length > exports2.TerminalLimits.maxStateSessions) {
        throw new TerminalProtocolError("state.sessions \u6570\u91CF\u8D85\u8FC7\u4E0A\u9650");
      }
      const seen = /* @__PURE__ */ new Set();
      for (const raw of v.sessions) {
        assertRecord(raw, "state.sessions[]");
        assertKeys(raw, /* @__PURE__ */ new Set([
          "sessionId",
          "shellId",
          "status",
          "cols",
          "rows",
          "lastSeq",
          "detachedAt",
          "expiresAt"
        ]), "state.sessions[]");
        assertSessionId(raw.sessionId);
        if (seen.has(raw.sessionId))
          throw new TerminalProtocolError("state.sessions \u542B\u91CD\u590D sessionId");
        seen.add(raw.sessionId);
        assertString(raw.shellId, "shellId", 64);
        if (raw.status !== "active" && raw.status !== "detached") {
          throw new TerminalProtocolError("state.sessions[].status \u4E0D\u53D7\u652F\u6301");
        }
        assertTerminalSize(raw, "state.sessions[]");
        if (typeof raw.lastSeq !== "number" || !Number.isInteger(raw.lastSeq) || raw.lastSeq < 0) {
          throw new TerminalProtocolError("state.sessions[].lastSeq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
        }
        assertOptionalDate(raw.detachedAt, "state.sessions[].detachedAt");
        assertOptionalDate(raw.expiresAt, "state.sessions[].expiresAt");
      }
      return v;
    }
    function parseTerminalStateAck(v) {
      assertRecord(v, "ack");
      assertKeys(v, /* @__PURE__ */ new Set(["acceptedSessionIds", "closeSessionIds"]), "ack");
      for (const key of ["acceptedSessionIds", "closeSessionIds"]) {
        if (!Array.isArray(v[key]))
          throw new TerminalProtocolError(`ack.${key} \u5FC5\u987B\u662F\u6570\u7EC4`);
        for (const id of v[key]) {
          if (typeof id !== "string" || id.length === 0 || id.length > 128) {
            throw new TerminalProtocolError(`ack.${key} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
          }
        }
      }
      return v;
    }
    function parseTerminalBrowserAttach(v) {
      assertRecord(v, "attach");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "reconnectToken"]), "attach");
      assertSessionId(v.sessionId);
      if (v.reconnectToken !== void 0)
        assertString(v.reconnectToken, "reconnectToken", 128);
      return v;
    }
    function parseTerminalBrowserInput(v) {
      assertRecord(v, "input");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId", "data"]), "input");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      assertString(v.data, "data", exports2.TerminalLimits.maxInputBytes);
      return v;
    }
    function parseTerminalBrowserResize(v) {
      assertRecord(v, "resize");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId", "cols", "rows"]), "resize");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      assertTerminalSize(v, "resize");
      return v;
    }
    function parseTerminalBrowserTakeover(v) {
      assertRecord(v, "takeover");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId"]), "takeover");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      return v;
    }
    function parseTerminalBrowserDetach(v) {
      assertRecord(v, "detach");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId"]), "detach");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      return v;
    }
    function parseTerminalBrowserAckOutput(v) {
      assertRecord(v, "ack-output");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId", "seq"]), "ack-output");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) {
        throw new TerminalProtocolError("ack-output.seq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
      }
      return v;
    }
    function parseTerminalBrowserResync(v) {
      assertRecord(v, "resync");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "attachmentId"]), "resync");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      return v;
    }
    function parseTerminalBrowserAttached(v) {
      assertRecord(v, "attached");
      assertKeys(v, /* @__PURE__ */ new Set([
        "sessionId",
        "attachmentId",
        "reconnectToken",
        "mode",
        "controlProtectedUntil"
      ]), "attached");
      assertSessionId(v.sessionId);
      assertString(v.attachmentId, "attachmentId", 128);
      assertString(v.reconnectToken, "reconnectToken", 128);
      if (v.mode !== "operator" && v.mode !== "viewer")
        throw new TerminalProtocolError("attached.mode \u4E0D\u53D7\u652F\u6301");
      if (v.controlProtectedUntil !== null)
        assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
      return v;
    }
    function parseTerminalSnapshotMessage(v) {
      assertRecord(v, "snapshot");
      assertKeys(v, /* @__PURE__ */ new Set([
        "sessionId",
        "snapshot",
        "snapshotSeq",
        "cols",
        "rows",
        "historyTruncated"
      ]), "snapshot");
      assertSessionId(v.sessionId);
      assertString(v.snapshot, "snapshot", exports2.TerminalLimits.maxSnapshotBytes);
      if (typeof v.snapshotSeq !== "number" || !Number.isInteger(v.snapshotSeq) || v.snapshotSeq < 0) {
        throw new TerminalProtocolError("snapshot.snapshotSeq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
      }
      assertTerminalSize(v, "snapshot");
      if (typeof v.historyTruncated !== "boolean")
        throw new TerminalProtocolError("snapshot.historyTruncated \u5FC5\u987B\u662F\u5E03\u5C14");
      return v;
    }
    function parseTerminalControlState(v) {
      assertRecord(v, "control");
      assertKeys(v, /* @__PURE__ */ new Set([
        "sessionId",
        "mode",
        "operatorName",
        "controlProtectedUntil",
        "canTakeover"
      ]), "control");
      assertSessionId(v.sessionId);
      if (v.mode !== "operator" && v.mode !== "viewer")
        throw new TerminalProtocolError("control.mode \u4E0D\u53D7\u652F\u6301");
      if (v.operatorName !== null)
        assertOptionalString(v.operatorName, "operatorName", 128);
      if (v.controlProtectedUntil !== null)
        assertOptionalDate(v.controlProtectedUntil, "controlProtectedUntil");
      if (typeof v.canTakeover !== "boolean")
        throw new TerminalProtocolError("control.canTakeover \u5FC5\u987B\u662F\u5E03\u5C14");
      return v;
    }
    function parseTerminalSessionStateMessage(v) {
      assertRecord(v, "state-message");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "status", "reason"]), "state-message");
      assertSessionId(v.sessionId);
      if (!isTerminalSessionStatus(v.status))
        throw new TerminalProtocolError("state-message.status \u4E0D\u53D7\u652F\u6301");
      if (v.reason !== void 0)
        assertString(v.reason, "reason", 200);
      return v;
    }
    function parseTerminalError(v) {
      assertRecord(v, "error");
      assertKeys(v, /* @__PURE__ */ new Set(["sessionId", "code", "message"]), "error");
      assertString(v.sessionId, "sessionId", 128);
      assertErrorCode(v.code, "error.code");
      assertString(v.message, "message", 200);
      return v;
    }
  }
});

// ../shared/dist/frp-runtime.js
var require_frp_runtime = __commonJS({
  "../shared/dist/frp-runtime.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.FRP_RECONCILE_PROTOCOL_VERSION = void 0;
    exports2.parseFrpCapabilityStatus = parseFrpCapabilityStatus;
    exports2.parseFrpRuntimeStateReport = parseFrpRuntimeStateReport;
    exports2.parseFrpReconcilePayload = parseFrpReconcilePayload;
    exports2.parseFrpRuntimeStateAck = parseFrpRuntimeStateAck;
    exports2.parseFrpReconcileResult = parseFrpReconcileResult;
    exports2.FRP_RECONCILE_PROTOCOL_VERSION = 1;
    function rtString(value, field, maxLength) {
      if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
        throw new Error(`${field} \u683C\u5F0F\u65E0\u6548`);
      }
      return value;
    }
    function rtPort(value, field) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${field} \u5FC5\u987B\u662F 1\u201365535 \u7684\u6574\u6570`);
      }
      return value;
    }
    function rtNonNegativeInt(value, field) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${field} \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570`);
      }
      return value;
    }
    function rtAttempt(value, field) {
      if (value !== 0 && value !== 1 && value !== 2) {
        throw new Error(`${field} \u5FC5\u987B\u662F 0\u30011 \u6216 2`);
      }
      return value;
    }
    function rtBoolean(value, field) {
      if (typeof value !== "boolean") {
        throw new Error(`${field} \u5FC5\u987B\u662F\u5E03\u5C14\u503C`);
      }
      return value;
    }
    function rtRecord(value, field) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${field} \u5FC5\u987B\u662F\u5BF9\u8C61`);
      }
      return value;
    }
    function rtExactKeys(input, allowed, field) {
      for (const key of Object.keys(input)) {
        if (!allowed.includes(key)) {
          throw new Error(`${field} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
    }
    function rtParseMapping(value, field) {
      const input = rtRecord(value, field);
      rtExactKeys(input, ["mappingId", "name", "proxyType", "localIp", "localPort", "remotePort", "customDomain"], field);
      const proxyType = input.proxyType;
      if (proxyType !== "tcp" && proxyType !== "http" && proxyType !== "https") {
        throw new Error(`${field}.proxyType \u5FC5\u987B\u662F tcp\u3001http \u6216 https`);
      }
      return {
        mappingId: rtString(input.mappingId, `${field}.mappingId`, 128),
        name: rtString(input.name, `${field}.name`, 128),
        proxyType,
        localIp: rtString(input.localIp, `${field}.localIp`, 255),
        localPort: rtPort(input.localPort, `${field}.localPort`),
        remotePort: input.remotePort === null || input.remotePort === void 0 ? null : rtPort(input.remotePort, `${field}.remotePort`),
        customDomain: input.customDomain === null || input.customDomain === void 0 ? null : rtString(input.customDomain, `${field}.customDomain`, 253)
      };
    }
    function rtParseMappings(value, field) {
      if (!Array.isArray(value)) {
        throw new Error(`${field} \u5FC5\u987B\u662F\u6570\u7EC4`);
      }
      return value.map((item, i) => rtParseMapping(item, `${field}[${i}]`));
    }
    function rtParseEndpoint(value, field) {
      if (value === null || value === void 0)
        return null;
      const input = rtRecord(value, field);
      rtExactKeys(input, ["serverAddr", "serverPort"], field);
      return {
        serverAddr: rtString(input.serverAddr, `${field}.serverAddr`, 255),
        serverPort: rtPort(input.serverPort, `${field}.serverPort`)
      };
    }
    function parseFrpCapabilityStatus(value) {
      const input = rtRecord(value, "frp capability");
      rtExactKeys(input, ["available", "reconcileProtocolVersion", "code", "message"], "frp capability");
      const available = rtBoolean(input.available, "available");
      const result = { available };
      if (input.reconcileProtocolVersion !== void 0) {
        if (input.reconcileProtocolVersion !== exports2.FRP_RECONCILE_PROTOCOL_VERSION) {
          throw new Error("reconcileProtocolVersion \u5FC5\u987B\u662F 1");
        }
        result.reconcileProtocolVersion = exports2.FRP_RECONCILE_PROTOCOL_VERSION;
      }
      if (input.code !== void 0) {
        if (input.code !== "FRPC_NOT_FOUND") {
          throw new Error("code \u5FC5\u987B\u662F FRPC_NOT_FOUND");
        }
        result.code = "FRPC_NOT_FOUND";
      }
      if (input.message !== void 0) {
        result.message = rtString(input.message, "message", 255);
      }
      return result;
    }
    function parseFrpRuntimeStateReport(value) {
      const input = rtRecord(value, "frp runtime state");
      rtExactKeys(input, [
        "clientId",
        "connectionGeneration",
        "runtimeGeneration",
        "status",
        "processRunning",
        "recoveryOwner",
        "attempt",
        "frpsEndpoint",
        "mappings",
        "errorCode",
        "errorMessage"
      ], "frp runtime state");
      const status = input.status;
      if (status !== "stopped" && status !== "starting" && status !== "running" && status !== "retrying" && status !== "failed") {
        throw new Error("status \u5FC5\u987B\u662F stopped\u3001starting\u3001running\u3001retrying \u6216 failed");
      }
      const recoveryOwner = input.recoveryOwner;
      if (recoveryOwner !== null && recoveryOwner !== "client" && recoveryOwner !== "server") {
        throw new Error("recoveryOwner \u5FC5\u987B\u662F null\u3001client \u6216 server");
      }
      const result = {
        clientId: rtString(input.clientId, "clientId", 128),
        connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
        runtimeGeneration: rtNonNegativeInt(input.runtimeGeneration, "runtimeGeneration"),
        status,
        processRunning: rtBoolean(input.processRunning, "processRunning"),
        recoveryOwner,
        attempt: rtAttempt(input.attempt, "attempt"),
        frpsEndpoint: rtParseEndpoint(input.frpsEndpoint, "frpsEndpoint"),
        mappings: rtParseMappings(input.mappings, "mappings")
      };
      if (input.errorCode !== void 0) {
        result.errorCode = rtString(input.errorCode, "errorCode", 128);
      }
      if (input.errorMessage !== void 0) {
        result.errorMessage = rtString(input.errorMessage, "errorMessage", 255);
      }
      return result;
    }
    function parseFrpReconcilePayload(value) {
      const input = rtRecord(value, "frp reconcile payload");
      rtExactKeys(input, [
        "connectionGeneration",
        "expectedRuntimeGeneration",
        "attempt",
        "timeoutSeconds",
        "frpsInfo",
        "mappings",
        "preservedMappings"
      ], "frp reconcile payload");
      const frpsInfo = rtRecord(input.frpsInfo, "frpsInfo");
      rtExactKeys(frpsInfo, ["serverAddr", "serverPort", "authToken"], "frpsInfo");
      return {
        connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
        expectedRuntimeGeneration: rtNonNegativeInt(input.expectedRuntimeGeneration, "expectedRuntimeGeneration"),
        attempt: rtAttempt(input.attempt, "attempt"),
        timeoutSeconds: rtPort(input.timeoutSeconds, "timeoutSeconds"),
        frpsInfo: {
          serverAddr: rtString(frpsInfo.serverAddr, "frpsInfo.serverAddr", 255),
          serverPort: rtPort(frpsInfo.serverPort, "frpsInfo.serverPort"),
          authToken: rtString(frpsInfo.authToken, "frpsInfo.authToken", 255)
        },
        mappings: rtParseMappings(input.mappings, "mappings"),
        preservedMappings: rtParseMappings(input.preservedMappings, "preservedMappings")
      };
    }
    function parseFrpRuntimeStateAck(value) {
      const input = rtRecord(value, "frp state ack");
      rtExactKeys(input, ["connectionGeneration", "accepted", "action"], "frp state ack");
      const action = input.action;
      if (action !== "none" && action !== "client-retrying" && action !== "server-reconciling" && action !== "stale") {
        throw new Error("action \u5FC5\u987B\u662F none\u3001client-retrying\u3001server-reconciling \u6216 stale");
      }
      return {
        connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
        accepted: rtBoolean(input.accepted, "accepted"),
        action
      };
    }
    function parseFrpReconcileResult(value) {
      const input = rtRecord(value, "frp reconcile result");
      rtExactKeys(input, ["connectionGeneration", "runtimeGeneration", "status", "loadedMappingIds"], "frp reconcile result");
      const status = input.status;
      if (status !== "running" && status !== "failed") {
        throw new Error("status \u5FC5\u987B\u662F running \u6216 failed");
      }
      if (!Array.isArray(input.loadedMappingIds) || input.loadedMappingIds.some((id) => typeof id !== "string")) {
        throw new Error("loadedMappingIds \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
      }
      return {
        connectionGeneration: rtString(input.connectionGeneration, "connectionGeneration", 128),
        runtimeGeneration: rtNonNegativeInt(input.runtimeGeneration, "runtimeGeneration"),
        status,
        loadedMappingIds: input.loadedMappingIds
      };
    }
  }
});

// ../shared/dist/machine-register.js
var require_machine_register = __commonJS({
  "../shared/dist/machine-register.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PrivilegedCapabilityMode = exports2.MachineInstallationMode = void 0;
    exports2.parseMachineInstallation = parseMachineInstallation;
    exports2.parsePrivilegedCapabilityStatus = parsePrivilegedCapabilityStatus;
    exports2.parseMachineRegister = parseMachineRegister;
    var frp_runtime_js_1 = require_frp_runtime();
    var MAX_CLIENT_ID = 128;
    var MAX_HOSTNAME = 256;
    var MAX_OS = 64;
    var MAX_CPU_MODEL = 128;
    var MAX_CLIENT_VERSION = 64;
    var MAX_CAPABILITY = 64;
    var MAX_CAPABILITIES = 100;
    var MAX_TOTAL_MEM_MB = 1e7;
    var MAX_RUN_AS_USER = 256;
    exports2.MachineInstallationMode = {
      SYSTEMD_ROOT_EQUIVALENT: "systemd-root-equivalent",
      LEGACY_PM2: "legacy-pm2"
    };
    exports2.PrivilegedCapabilityMode = {
      SUDO_ALL: "sudo-all",
      UNAVAILABLE: "unavailable"
    };
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function requireString(value, field, maxLength) {
      if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
        throw new Error(`${field} \u5FC5\u987B\u4E3A\u957F\u5EA6 1-${maxLength} \u7684\u5B57\u7B26\u4E32`);
      }
      return value;
    }
    function parseMachineInstallation(value) {
      if (!isRecord2(value) || Object.keys(value).length !== 1) {
        throw new Error("installation \u5FC5\u987B\u4E3A\u4EC5\u542B mode \u7684\u5BF9\u8C61");
      }
      const valid = [exports2.MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT, exports2.MachineInstallationMode.LEGACY_PM2];
      if (!valid.includes(value.mode)) {
        throw new Error(`installation.mode \u5FC5\u987B\u4E3A ${valid.join(" \u6216 ")}`);
      }
      return { mode: value.mode };
    }
    function parsePrivilegedCapabilityStatus(value) {
      if (!isRecord2(value) || Object.keys(value).length !== 4) {
        throw new Error("privileged \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B available/mode/nonInteractive/runAsUser");
      }
      const { available, mode, nonInteractive, runAsUser } = value;
      if (typeof available !== "boolean" || typeof nonInteractive !== "boolean") {
        throw new Error("privileged.available \u4E0E privileged.nonInteractive \u5FC5\u987B\u4E3A boolean");
      }
      if (mode !== exports2.PrivilegedCapabilityMode.SUDO_ALL && mode !== exports2.PrivilegedCapabilityMode.UNAVAILABLE) {
        throw new Error("privileged.mode \u5FC5\u987B\u4E3A sudo-all \u6216 unavailable");
      }
      const user = requireString(runAsUser, "privileged.runAsUser", MAX_RUN_AS_USER);
      if (mode === exports2.PrivilegedCapabilityMode.SUDO_ALL && available !== true) {
        throw new Error("privileged.mode=sudo-all \u5FC5\u987B available=true");
      }
      if (mode === exports2.PrivilegedCapabilityMode.UNAVAILABLE && nonInteractive !== false) {
        throw new Error("privileged.mode=unavailable \u5FC5\u987B nonInteractive=false");
      }
      return { available, mode, nonInteractive, runAsUser: user };
    }
    function parseMachineRegister(value) {
      if (!isRecord2(value))
        throw new Error("register \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      const clientId = requireString(value.clientId, "clientId", MAX_CLIENT_ID);
      const hostname = requireString(value.hostname, "hostname", MAX_HOSTNAME);
      const os = requireString(value.os, "os", MAX_OS);
      const cpuModel = requireString(value.cpuModel, "cpuModel", MAX_CPU_MODEL);
      const clientVersion = requireString(value.clientVersion, "clientVersion", MAX_CLIENT_VERSION);
      const totalMemMB = value.totalMemMB;
      if (typeof totalMemMB !== "number" || !Number.isFinite(totalMemMB) || totalMemMB <= 0 || totalMemMB > MAX_TOTAL_MEM_MB) {
        throw new Error("totalMemMB \u5FC5\u987B\u4E3A 0-10000000 \u7684\u6709\u9650\u6570\u5B57");
      }
      if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITIES) {
        throw new Error(`capabilities \u5FC5\u987B\u4E3A\u957F\u5EA6 0-${MAX_CAPABILITIES} \u7684\u5B57\u7B26\u4E32\u6570\u7EC4`);
      }
      const capabilities = value.capabilities.map((cap) => requireString(cap, "capabilities[]", MAX_CAPABILITY));
      const result = {
        clientId,
        hostname,
        os,
        cpuModel,
        totalMemMB,
        clientVersion,
        capabilities
      };
      if (value.capabilityDetails !== void 0) {
        const details = value.capabilityDetails;
        if (!isRecord2(details))
          throw new Error("capabilityDetails \u5FC5\u987B\u4E3A\u5BF9\u8C61");
        const known = ["pi", "terminal", "frp", "privileged"];
        for (const key of Object.keys(details)) {
          if (!known.includes(key)) {
            throw new Error(`capabilityDetails \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
          }
        }
        const parsedDetails = {};
        if (details.pi !== void 0)
          parsedDetails.pi = details.pi;
        if (details.terminal !== void 0) {
          parsedDetails.terminal = details.terminal;
        }
        if (details.frp !== void 0) {
          parsedDetails.frp = (0, frp_runtime_js_1.parseFrpCapabilityStatus)(details.frp);
        }
        if (details.privileged !== void 0) {
          parsedDetails.privileged = parsePrivilegedCapabilityStatus(details.privileged);
        }
        result.capabilityDetails = parsedDetails;
      }
      if (value.installation !== void 0) {
        result.installation = parseMachineInstallation(value.installation);
      }
      return result;
    }
  }
});

// ../shared/dist/index.js
var require_dist = __commonJS({
  "../shared/dist/index.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __exportStar = exports2 && exports2.__exportStar || function(m, exports3) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports3, p)) __createBinding(exports3, m, p);
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseFrpRuntimeStateReport = exports2.parseFrpRuntimeStateAck = exports2.parseFrpReconcileResult = exports2.parseFrpReconcilePayload = exports2.parseFrpCapabilityStatus = exports2.FRP_RECONCILE_PROTOCOL_VERSION = exports2.FrpJobType = exports2.FrpProtocolError = exports2.FRP_ERROR_CODES = exports2.FRP_MAPPING_STATUSES = exports2.StorageProviderKind = exports2.AuthErrorCode = exports2.FileErrorCode = exports2.parsePrivilegedCapabilityStatus = exports2.parseMachineRegister = exports2.parseMachineInstallation = exports2.PrivilegedCapabilityMode = exports2.MachineInstallationMode = exports2.JobStatus = exports2.JobType = exports2.Events = exports2.safePiErrorMessage = exports2.parsePiAgentState = exports2.isPiThinkingLevel = exports2.isPiAgentIdle = exports2.PI_THINKING_LEVELS = exports2.PI_SESSION_JOB_PROTOCOL_VERSION = exports2.PI_ERROR_CODES = exports2.isReleaseArchiveAvailable = exports2.platformFromOs = exports2.parseReleaseUploadPartRefresh = exports2.parseReleaseUploadCreateInput = exports2.parseReleaseUploadComplete = exports2.ReleaseUploadErrorCode = exports2.ReleaseStatus = exports2.ReleaseClientState = exports2.parseClientInstallerPlatform = exports2.parseClientInstallerNameUpdate = exports2.parseClientInstallerConfigUpdate = exports2.ClientInstallerErrorCode = exports2.VERSION = void 0;
    exports2.parseFrpOperationTimeout = parseFrpOperationTimeout;
    exports2.parseFrpMappingCreateRequest = parseFrpMappingCreateRequest;
    var version_js_1 = require_version();
    Object.defineProperty(exports2, "VERSION", { enumerable: true, get: function() {
      return version_js_1.VERSION;
    } });
    var client_installer_js_1 = require_client_installer();
    Object.defineProperty(exports2, "ClientInstallerErrorCode", { enumerable: true, get: function() {
      return client_installer_js_1.ClientInstallerErrorCode;
    } });
    Object.defineProperty(exports2, "parseClientInstallerConfigUpdate", { enumerable: true, get: function() {
      return client_installer_js_1.parseClientInstallerConfigUpdate;
    } });
    Object.defineProperty(exports2, "parseClientInstallerNameUpdate", { enumerable: true, get: function() {
      return client_installer_js_1.parseClientInstallerNameUpdate;
    } });
    Object.defineProperty(exports2, "parseClientInstallerPlatform", { enumerable: true, get: function() {
      return client_installer_js_1.parseClientInstallerPlatform;
    } });
    __exportStar(require_update(), exports2);
    __exportStar(require_pi(), exports2);
    __exportStar(require_terminal(), exports2);
    var update_js_1 = require_update();
    Object.defineProperty(exports2, "ReleaseClientState", { enumerable: true, get: function() {
      return update_js_1.ReleaseClientState;
    } });
    Object.defineProperty(exports2, "ReleaseStatus", { enumerable: true, get: function() {
      return update_js_1.ReleaseStatus;
    } });
    Object.defineProperty(exports2, "ReleaseUploadErrorCode", { enumerable: true, get: function() {
      return update_js_1.ReleaseUploadErrorCode;
    } });
    Object.defineProperty(exports2, "parseReleaseUploadComplete", { enumerable: true, get: function() {
      return update_js_1.parseReleaseUploadComplete;
    } });
    Object.defineProperty(exports2, "parseReleaseUploadCreateInput", { enumerable: true, get: function() {
      return update_js_1.parseReleaseUploadCreateInput;
    } });
    Object.defineProperty(exports2, "parseReleaseUploadPartRefresh", { enumerable: true, get: function() {
      return update_js_1.parseReleaseUploadPartRefresh;
    } });
    Object.defineProperty(exports2, "platformFromOs", { enumerable: true, get: function() {
      return update_js_1.platformFromOs;
    } });
    Object.defineProperty(exports2, "isReleaseArchiveAvailable", { enumerable: true, get: function() {
      return update_js_1.isReleaseArchiveAvailable;
    } });
    var pi_js_1 = require_pi();
    Object.defineProperty(exports2, "PI_ERROR_CODES", { enumerable: true, get: function() {
      return pi_js_1.PI_ERROR_CODES;
    } });
    Object.defineProperty(exports2, "PI_SESSION_JOB_PROTOCOL_VERSION", { enumerable: true, get: function() {
      return pi_js_1.PI_SESSION_JOB_PROTOCOL_VERSION;
    } });
    Object.defineProperty(exports2, "PI_THINKING_LEVELS", { enumerable: true, get: function() {
      return pi_js_1.PI_THINKING_LEVELS;
    } });
    Object.defineProperty(exports2, "isPiAgentIdle", { enumerable: true, get: function() {
      return pi_js_1.isPiAgentIdle;
    } });
    Object.defineProperty(exports2, "isPiThinkingLevel", { enumerable: true, get: function() {
      return pi_js_1.isPiThinkingLevel;
    } });
    Object.defineProperty(exports2, "parsePiAgentState", { enumerable: true, get: function() {
      return pi_js_1.parsePiAgentState;
    } });
    Object.defineProperty(exports2, "safePiErrorMessage", { enumerable: true, get: function() {
      return pi_js_1.safePiErrorMessage;
    } });
    exports2.Events = {
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
      FRP_STATE_ACK: "frp:state-ack"
    };
    var JobType;
    (function(JobType2) {
      JobType2["EXEC"] = "exec";
      JobType2["FILE_LIST"] = "file.list";
      JobType2["FILE_STAT"] = "file.stat";
      JobType2["FILE_READ_TEXT"] = "file.readText";
      JobType2["FILE_WRITE_TEXT"] = "file.writeText";
      JobType2["FILE_MKDIR"] = "file.mkdir";
      JobType2["FILE_DELETE"] = "file.delete";
      JobType2["FILE_MOVE"] = "file.move";
      JobType2["FILE_EXPORT"] = "file.export";
      JobType2["FILE_IMPORT"] = "file.import";
      JobType2["AGENT_RUN"] = "agent.run";
      JobType2["AGENT_SESSION"] = "agent.session";
      JobType2["FRP_CREATE"] = "frp.create";
      JobType2["FRP_DELETE"] = "frp.delete";
      JobType2["FRP_LIST"] = "frp.list";
      JobType2["FRP_RECONCILE"] = "frp.reconcile";
      JobType2["FILE_ROOTS"] = "file.roots";
    })(JobType || (exports2.JobType = JobType = {}));
    var JobStatus2;
    (function(JobStatus3) {
      JobStatus3["IDLE"] = "idle";
      JobStatus3["PENDING"] = "pending";
      JobStatus3["RUNNING"] = "running";
      JobStatus3["WAITING_INPUT"] = "waiting_input";
      JobStatus3["DONE"] = "done";
      JobStatus3["ERROR"] = "error";
      JobStatus3["DISCONNECTED"] = "disconnected";
      JobStatus3["CANCELLED"] = "cancelled";
    })(JobStatus2 || (exports2.JobStatus = JobStatus2 = {}));
    var machine_register_js_1 = require_machine_register();
    Object.defineProperty(exports2, "MachineInstallationMode", { enumerable: true, get: function() {
      return machine_register_js_1.MachineInstallationMode;
    } });
    Object.defineProperty(exports2, "PrivilegedCapabilityMode", { enumerable: true, get: function() {
      return machine_register_js_1.PrivilegedCapabilityMode;
    } });
    Object.defineProperty(exports2, "parseMachineInstallation", { enumerable: true, get: function() {
      return machine_register_js_1.parseMachineInstallation;
    } });
    Object.defineProperty(exports2, "parseMachineRegister", { enumerable: true, get: function() {
      return machine_register_js_1.parseMachineRegister;
    } });
    Object.defineProperty(exports2, "parsePrivilegedCapabilityStatus", { enumerable: true, get: function() {
      return machine_register_js_1.parsePrivilegedCapabilityStatus;
    } });
    exports2.FileErrorCode = {
      PATH_NOT_FOUND: "PATH_NOT_FOUND",
      PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
      PATH_CONFLICT: "PATH_CONFLICT",
      IO_ERROR: "IO_ERROR",
      SIZE_EXCEEDED: "SIZE_EXCEEDED",
      SHA256_MISMATCH: "SHA256_MISMATCH"
    };
    exports2.AuthErrorCode = {
      AUTH_REQUIRED: "AUTH_REQUIRED",
      AUTH_INVALID: "AUTH_INVALID",
      AUTH_EXPIRED: "AUTH_EXPIRED",
      AUTH_REVOKED: "AUTH_REVOKED",
      IDENTITY_DISABLED: "IDENTITY_DISABLED",
      FORBIDDEN: "FORBIDDEN"
    };
    exports2.StorageProviderKind = {
      LOCAL: "local"
    };
    exports2.FRP_MAPPING_STATUSES = [
      "provisioning",
      "active",
      "inactive",
      "deleting",
      "error",
      "reconciling"
    ];
    exports2.FRP_ERROR_CODES = [
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
      "FRP_CLIENT_NO_FRP_CAPABILITY"
    ];
    var FrpProtocolError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "FrpProtocolError";
      }
    };
    exports2.FrpProtocolError = FrpProtocolError;
    exports2.FrpJobType = {
      FRP_CREATE: "frp.create",
      FRP_DELETE: "frp.delete",
      FRP_LIST: "frp.list",
      FRP_RECONCILE: "frp.reconcile"
    };
    function parseFrpOperationTimeout(value) {
      const parsed = value === void 0 ? 30 : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
        throw new FrpProtocolError("timeoutSeconds \u5FC5\u987B\u662F 1\u2013300 \u7684\u6574\u6570");
      }
      return parsed;
    }
    function parseFrpMappingCreateRequest(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FrpProtocolError("FRP \u521B\u5EFA\u8BF7\u6C42\u5FC5\u987B\u662F\u5BF9\u8C61");
      }
      const input = value;
      const allowed = /* @__PURE__ */ new Set([
        "clientId",
        "name",
        "proxyType",
        "localIp",
        "localPort",
        "remotePort",
        "customDomain",
        "frpsInstanceId",
        "timeoutSeconds"
      ]);
      for (const key of Object.keys(input)) {
        if (!allowed.has(key))
          throw new FrpProtocolError(`FRP \u521B\u5EFA\u8BF7\u6C42\u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      const clientId = frpString(input.clientId, "clientId", 128);
      const proxyType = input.proxyType;
      if (proxyType !== "tcp" && proxyType !== "http" && proxyType !== "https") {
        throw new FrpProtocolError("proxyType \u5FC5\u987B\u662F tcp\u3001http \u6216 https");
      }
      const localPort = frpPort(input.localPort, "localPort");
      const name = optionalFrpString(input.name, "name", 64, /^[A-Za-z0-9._-]+$/);
      const localIp = optionalFrpString(input.localIp, "localIp", 255, /^[A-Za-z0-9.:%_-]+$/) ?? "127.0.0.1";
      const frpsInstanceId = optionalFrpString(input.frpsInstanceId, "frpsInstanceId", 128);
      const remotePort = input.remotePort === void 0 ? void 0 : frpPort(input.remotePort, "remotePort");
      const customDomain = optionalFrpString(input.customDomain, "customDomain", 253, /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/);
      if (proxyType === "tcp" && customDomain) {
        throw new FrpProtocolError("TCP \u6620\u5C04\u4E0D\u5141\u8BB8 customDomain");
      }
      if (proxyType !== "tcp" && remotePort !== void 0) {
        throw new FrpProtocolError("HTTP/HTTPS \u6620\u5C04\u4E0D\u5141\u8BB8 remotePort");
      }
      if (proxyType !== "tcp" && !customDomain) {
        throw new FrpProtocolError("HTTP/HTTPS \u6620\u5C04\u5FC5\u987B\u63D0\u4F9B customDomain");
      }
      return {
        clientId,
        ...name ? { name } : {},
        proxyType,
        localIp,
        localPort,
        ...remotePort !== void 0 ? { remotePort } : {},
        ...customDomain ? { customDomain } : {},
        ...frpsInstanceId ? { frpsInstanceId } : {},
        timeoutSeconds: parseFrpOperationTimeout(input.timeoutSeconds)
      };
    }
    function frpString(value, field, maxLength, pattern) {
      if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value !== value.trim() || pattern && !pattern.test(value)) {
        throw new FrpProtocolError(`${field} \u683C\u5F0F\u65E0\u6548`);
      }
      return value;
    }
    function optionalFrpString(value, field, maxLength, pattern) {
      return value === void 0 ? void 0 : frpString(value, field, maxLength, pattern);
    }
    function frpPort(value, field) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new FrpProtocolError(`${field} \u5FC5\u987B\u662F 1\u201365535 \u7684\u6574\u6570`);
      }
      return value;
    }
    var frp_runtime_js_1 = require_frp_runtime();
    Object.defineProperty(exports2, "FRP_RECONCILE_PROTOCOL_VERSION", { enumerable: true, get: function() {
      return frp_runtime_js_1.FRP_RECONCILE_PROTOCOL_VERSION;
    } });
    Object.defineProperty(exports2, "parseFrpCapabilityStatus", { enumerable: true, get: function() {
      return frp_runtime_js_1.parseFrpCapabilityStatus;
    } });
    Object.defineProperty(exports2, "parseFrpReconcilePayload", { enumerable: true, get: function() {
      return frp_runtime_js_1.parseFrpReconcilePayload;
    } });
    Object.defineProperty(exports2, "parseFrpReconcileResult", { enumerable: true, get: function() {
      return frp_runtime_js_1.parseFrpReconcileResult;
    } });
    Object.defineProperty(exports2, "parseFrpRuntimeStateAck", { enumerable: true, get: function() {
      return frp_runtime_js_1.parseFrpRuntimeStateAck;
    } });
    Object.defineProperty(exports2, "parseFrpRuntimeStateReport", { enumerable: true, get: function() {
      return frp_runtime_js_1.parseFrpRuntimeStateReport;
    } });
  }
});

// ../sdk/dist/aliyundrive.js
function createAliyunDriveApi(client) {
  return {
    verify: (signal) => client.request("POST", "/api/aliyundrive/verify", void 0, signal),
    status: (signal) => client.request("GET", "/api/aliyundrive/status", void 0, signal),
    configure: (input, signal) => client.request("PUT", "/api/aliyundrive/config", input, signal),
    startOAuth: (signal) => client.request("POST", "/api/aliyundrive/oauth/start", void 0, signal),
    completeOAuth: (input, signal) => client.request("POST", "/api/aliyundrive/oauth/complete", input, signal),
    revoke: (signal) => client.request("POST", "/api/aliyundrive/oauth/revoke", void 0, signal)
  };
}

// ../sdk/dist/auth.js
function createAuthApi(client) {
  return {
    login: (input, signal) => client.request("POST", "/api/auth/login", input, signal),
    /** 登录并提取 Cookie；仅供不会自动维护 Cookie 的 Node.js 调用方。 */
    loginSession: async (input, signal) => {
      const { data, response } = await client.requestRaw("POST", "/api/auth/login", {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        signal
      });
      const setCookie = response.headers.get("set-cookie");
      const session = setCookie?.match(/vcpdeck_session=([^;]+)/)?.[1];
      if (!session) {
        throw new Error("Login response did not include a session cookie");
      }
      return { login: data, cookie: `vcpdeck_session=${session}` };
    },
    logout: (signal) => client.request("POST", "/api/auth/logout", void 0, signal),
    me: (signal) => client.request("GET", "/api/auth/me", void 0, signal),
    updateMe: (input, signal) => client.request("PUT", "/api/auth/me", input, signal),
    tokens: {
      list: (signal) => client.request("GET", "/api/auth/tokens", void 0, signal),
      create: (input, signal) => client.request("POST", "/api/auth/tokens", input, signal),
      revoke: (id, signal) => client.request("DELETE", `/api/auth/tokens/${encodeURIComponent(id)}`, void 0, signal)
    }
  };
}
function createIdentitiesApi(client) {
  return {
    list: (signal) => client.request("GET", "/api/identities", void 0, signal),
    create: (input, signal) => client.request("POST", "/api/identities", input, signal),
    disable: (id, signal) => client.request("POST", `/api/identities/${encodeURIComponent(id)}/disable`, void 0, signal),
    enable: (id, signal) => client.request("POST", `/api/identities/${encodeURIComponent(id)}/enable`, void 0, signal)
  };
}

// ../sdk/dist/clients.js
function createClientsApi(client) {
  return {
    list: (signal) => client.request("GET", "/api/clients", void 0, signal),
    /** 修改客户端别名（全局唯一；重名返回 409）。 */
    rename: (clientId, name, signal) => client.request("PATCH", `/api/clients/${encodeURIComponent(clientId)}/name`, { name }, signal)
  };
}

// ../sdk/dist/client-installer.js
function createClientInstallerApi(client) {
  return {
    getConfig: (signal) => client.request("GET", "/api/client-installer/config", void 0, signal),
    updateConfig: (enabled, signal) => client.request("PUT", "/api/client-installer/config", { enabled }, signal),
    preflight: (platform, signal) => {
      const params = new URLSearchParams({ platform });
      return client.request("GET", `/api/client-installer/preflight?${params.toString()}`, void 0, signal);
    },
    bootstrap: (platform, signal) => client.request("POST", "/api/client-installer/bootstrap", { platform }, signal),
    getClientStatus: async (clientId, psk, signal) => {
      const result = await client.requestRaw("GET", `/api/client-installer/clients/${encodeURIComponent(clientId)}/status`, { headers: { "x-vcpdeck-psk": psk }, signal });
      return result.data;
    }
  };
}

// ../sdk/dist/files.js
function createFilesApi(client, jobs) {
  async function run(input, signal) {
    const created = await jobs.create(input, signal);
    const job = await jobs.wait(created.jobId, { signal });
    if (job.status !== "done")
      throw job;
    return job.result;
  }
  return {
    createUploadSession: (input, signal) => client.request("POST", "/api/files/upload-sessions", input, signal),
    completeUpload: (jobId, body, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/complete`, body, signal),
    /** 导出直传会话协商（Client stat 文件后调用） */
    createExportSession: (jobId, size, signal) => client.request("POST", "/api/files/export-sessions", { jobId, size }, signal),
    /** 完成导出直传，返回真实 storage key */
    completeExportUpload: (jobId, uploadedBytes, signal) => client.request("POST", `/api/files/export-sessions/${encodeURIComponent(jobId)}/complete`, { uploadedBytes }, signal),
    /** 续期直传会话指定分片的上传 URL */
    refreshUploadPartUrls: (jobId, partNumbers, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/part-urls`, { partNumbers }, signal),
    /** 直传分片进度上报（节流由调用方控制） */
    updateUploadProgress: (jobId, loaded, signal) => client.request("POST", `/api/files/upload-sessions/${encodeURIComponent(jobId)}/progress`, { loaded }, signal),
    roots: async (clientId, signal) => (await run({ clientId, type: "file.roots", payload: {} }, signal)).roots,
    list: (clientId, rootDir, path2, signal) => run({ clientId, type: "file.list", payload: { rootDir, path: path2 } }, signal),
    stat: (clientId, rootDir, path2, signal) => run({ clientId, type: "file.stat", payload: { rootDir, path: path2 } }, signal),
    readText: (clientId, rootDir, path2, maxBytes = 262144, signal) => run({
      clientId,
      type: "file.readText",
      payload: { rootDir, path: path2, maxBytes }
    }, signal),
    writeText: (clientId, payload, signal) => run({ clientId, type: "file.writeText", payload }, signal),
    mkdir: (clientId, payload, signal) => run({ clientId, type: "file.mkdir", payload }, signal),
    delete: (clientId, payload, signal) => run({ clientId, type: "file.delete", payload }, signal),
    move: (clientId, payload, signal) => run({ clientId, type: "file.move", payload }, signal),
    export: (clientId, payload, signal) => run({ clientId, type: "file.export", payload }, signal),
    import: (clientId, payload, signal) => run({ clientId, type: "file.import", payload }, signal)
  };
}

// ../sdk/dist/frp.js
var import_shared = __toESM(require_dist(), 1);
var FrpOperationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "FrpOperationError";
  }
};
function createFrpApi(client, jobs) {
  return {
    list: (options, signal) => {
      const params = new URLSearchParams();
      if (options?.clientId)
        params.set("clientId", options.clientId);
      if (options?.page)
        params.set("page", String(options.page));
      if (options?.pageSize)
        params.set("pageSize", String(options.pageSize));
      const qs = params.toString();
      return client.request("GET", `/api/frp/mappings${qs ? `?${qs}` : ""}`, void 0, signal);
    },
    get: (id, signal) => client.request("GET", `/api/frp/mappings/${encodeURIComponent(id)}`, void 0, signal),
    create: (input, signal) => client.request("POST", "/api/frp/mappings", input, signal),
    async createAndWait(input, options = {}) {
      if (!jobs)
        throw new Error("FRP wait requires Jobs API");
      const mapping = await client.request("POST", "/api/frp/mappings", input, options.signal);
      if (!mapping.operationJobId)
        throw new Error("Server \u672A\u8FD4\u56DE FRP operationJobId");
      const job = await jobs.wait(mapping.operationJobId, options);
      if (job.status !== import_shared.JobStatus.DONE) {
        throw new FrpOperationError(job.errorCode ?? "FRP_OPERATION_FAILED", job.errorMessage ?? "FRP \u6620\u5C04\u521B\u5EFA\u5931\u8D25");
      }
      return client.request("GET", `/api/frp/mappings/${encodeURIComponent(mapping.id)}`, void 0, options.signal);
    },
    delete: (id, optionsOrSignal = {}) => {
      const options = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : optionsOrSignal;
      const params = new URLSearchParams();
      if (options.timeoutSeconds) {
        params.set("timeoutSeconds", String(options.timeoutSeconds));
      }
      const query = params.toString();
      return client.request("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, void 0, options.signal);
    },
    async deleteAndWait(id, options = {}) {
      if (!jobs)
        throw new Error("FRP wait requires Jobs API");
      const params = new URLSearchParams();
      if (options.timeoutSeconds) {
        params.set("timeoutSeconds", String(options.timeoutSeconds));
      }
      const query = params.toString();
      const mapping = await client.request("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}${query ? `?${query}` : ""}`, void 0, options.signal);
      if (!mapping.operationJobId)
        throw new Error("Server \u672A\u8FD4\u56DE FRP operationJobId");
      const job = await jobs.wait(mapping.operationJobId, options);
      if (job.status !== import_shared.JobStatus.DONE) {
        throw new FrpOperationError(job.errorCode ?? "FRP_OPERATION_FAILED", job.errorMessage ?? "FRP \u6620\u5C04\u5220\u9664\u5931\u8D25");
      }
      return { id, deleted: true };
    },
    instances: {
      list: (options, signal) => {
        const params = new URLSearchParams();
        if (options?.page)
          params.set("page", String(options.page));
        if (options?.pageSize)
          params.set("pageSize", String(options.pageSize));
        const qs = params.toString();
        return client.request("GET", `/api/frp/instances${qs ? `?${qs}` : ""}`, void 0, signal);
      },
      get: (id, signal) => client.request("GET", `/api/frp/instances/${encodeURIComponent(id)}`, void 0, signal),
      create: (input, signal) => client.request("POST", "/api/frp/instances", input, signal),
      update: (id, input, signal) => client.request("PUT", `/api/frp/instances/${encodeURIComponent(id)}`, input, signal),
      delete: (id, signal) => client.request("DELETE", `/api/frp/instances/${encodeURIComponent(id)}`, void 0, signal),
      probe: (id, signal) => client.request("POST", `/api/frp/instances/${encodeURIComponent(id)}/probe`, void 0, signal),
      setDefault: (id, signal) => client.request("POST", `/api/frp/instances/${encodeURIComponent(id)}/set-default`, void 0, signal)
    }
  };
}

// ../sdk/dist/jobs.js
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(["done", "error", "cancelled"]);
function createJobsApi(client) {
  return {
    list: (options, signal) => {
      const params = new URLSearchParams();
      if (options?.clientId)
        params.set("clientId", options.clientId);
      if (options?.status)
        params.set("status", options.status);
      if (options?.page)
        params.set("page", String(options.page));
      if (options?.pageSize)
        params.set("pageSize", String(options.pageSize));
      const qs = params.toString();
      return client.request("GET", `/api/jobs${qs ? `?${qs}` : ""}`, void 0, signal);
    },
    get: (jobId, signal) => client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}`, void 0, signal),
    /** 获取 Job 输出 spool 全文；output 为 null 表示没有落盘输出。 */
    output: (jobId, signal) => client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`, void 0, signal),
    create: (input, signal) => client.request("POST", "/api/jobs", input, signal),
    cancel: (jobId, signal) => client.request("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, void 0, signal),
    async wait(jobId, options = {}) {
      const delays = options.delays?.length ? options.delays : [1e3, 2e3, 5e3];
      for (let attempt = 0; ; attempt++) {
        const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5e3;
        await sleep(delay, options.signal);
        const job = await client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}`, void 0, options.signal);
        options.onUpdate?.(job);
        if (TERMINAL_STATUSES.has(job.status))
          return job;
      }
    }
  };
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ../sdk/dist/pi.js
var import_shared2 = __toESM(require_dist(), 1);
function cwdQuery(cwdRef) {
  const params = new URLSearchParams();
  params.set("rootDir", cwdRef.rootDir);
  params.set("relativePath", cwdRef.relativePath);
  return params.toString();
}
function enc(s) {
  return encodeURIComponent(s);
}
function createPiApi(client) {
  return {
    capability: (clientId, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/capability`, void 0, signal),
    models: (clientId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/models?${cwdQuery(cwdRef)}`, void 0, signal),
    sessions: {
      list: (clientId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions?${cwdQuery(cwdRef)}`, void 0, signal),
      get: (clientId, sessionId, cwdRef, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}?${cwdQuery(cwdRef)}`, void 0, signal),
      context: (clientId, sessionId, cwdRef, options, signal) => {
        const params = new URLSearchParams(cwdQuery(cwdRef));
        if (options?.leafId)
          params.set("leafId", options.leafId);
        if (options?.cursor)
          params.set("cursor", options.cursor);
        return client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/context?${params.toString()}`, void 0, signal);
      },
      entryContent: (clientId, sessionId, entryId, cwdRef, blockIndex, signal) => {
        const params = new URLSearchParams(cwdQuery(cwdRef));
        params.set("blockIndex", String(blockIndex));
        return client.request("GET", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/entries/${enc(entryId)}/content?${params.toString()}`, void 0, signal);
      },
      rename: (clientId, sessionId, cwdRef, name) => client.request("PATCH", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
        ...cwdRef,
        name
      }),
      delete: (clientId, sessionId, cwdRef) => client.request("DELETE", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}`, {
        ...cwdRef
      }),
      fork: (clientId, sessionId, cwdRef, messageId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/fork`, {
        ...cwdRef,
        messageId
      }),
      clone: (clientId, sessionId, cwdRef) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/clone`, {
        ...cwdRef
      }),
      navigate: (clientId, sessionId, cwdRef, targetId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/sessions/${enc(sessionId)}/navigate`, {
        ...cwdRef,
        targetId
      })
    },
    agent: {
      newSession: (clientId, cwdRef, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/new`, { ...cwdRef }, signal),
      open: (clientId, sessionId, cwdRef, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/open`, cwdRef, signal),
      complete: (clientId, sessionId, runId, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/complete`, runId === void 0 ? {} : { runId }, signal),
      state: async (clientId, sessionId, cwdRef, signal) => (0, import_shared2.parsePiAgentState)(await client.request("GET", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}?${cwdQuery(cwdRef)}`, void 0, signal)),
      prompt: (clientId, sessionId, cwdRef, input, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}`, {
        ...cwdRef,
        type: "prompt",
        submissionId: input.submissionId,
        prompt: input.prompt,
        ...input.images?.length ? { images: input.images } : {}
      }, signal),
      steer: (clientId, sessionId, runId, message) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/steer`, {
        runId,
        message
      }),
      followUp: (clientId, sessionId, runId, message) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/follow-up`, {
        runId,
        message
      }),
      abort: (clientId, sessionId, runId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort`, {
        runId
      }),
      compact: (clientId, sessionId, runId, customInstructions) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/compact`, {
        runId,
        ...customInstructions ? { customInstructions } : {}
      }),
      abortCompact: (clientId, sessionId, runId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/abort-compact`, {
        runId
      }),
      setModel: (clientId, sessionId, cwdRef, provider, modelId) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/model`, {
        ...cwdRef,
        provider,
        modelId
      }),
      setThinking: (clientId, sessionId, cwdRef, level) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/thinking`, {
        ...cwdRef,
        level
      }),
      extensionResponse: (clientId, sessionId, runId, response) => client.request("POST", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/extension-response`, { runId, ...response }),
      eventsPath: (clientId, sessionId) => `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}/events`
    },
    attachments: {
      create: (clientId, images, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/attachments`, { images }, signal),
      complete: (clientId, attachmentId, signal) => client.request("POST", `/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}/complete`, void 0, signal),
      delete: (clientId, attachmentId) => client.request("DELETE", `/api/clients/${enc(clientId)}/pi/attachments/${enc(attachmentId)}`)
    },
    running: (clientId, signal) => client.request("GET", `/api/clients/${enc(clientId)}/pi/running`, void 0, signal)
  };
}

// ../sdk/dist/releases.js
function createReleasesApi(client) {
  return {
    list: (options, signal) => {
      const params = new URLSearchParams();
      if (options?.page)
        params.set("page", String(options.page));
      if (options?.pageSize)
        params.set("pageSize", String(options.pageSize));
      const qs = params.toString();
      return client.request("GET", `/api/releases${qs ? `?${qs}` : ""}`, void 0, signal);
    },
    createUploadSession: (input, signal) => client.request("POST", "/api/releases/uploads", input, signal),
    refreshUploadParts: (sessionId, partNumbers, signal) => client.request("POST", `/api/releases/uploads/${encodeURIComponent(sessionId)}/parts`, { partNumbers }, signal),
    completeUploadSession: (sessionId, uploadedBytes, signal) => client.request("POST", `/api/releases/uploads/${encodeURIComponent(sessionId)}/complete`, { uploadedBytes }, signal),
    /** Local 后端及旧 Server 引导使用的 legacy raw 上传。 */
    upload: async (input, signal) => {
      const params = new URLSearchParams({
        version: input.version,
        platform: input.platform,
        sha256: input.sha256
      });
      const result = await client.requestRaw("POST", `/api/releases/upload?${params.toString()}`, {
        body: input.archive,
        headers: {
          "Content-Type": input.contentType ?? "application/zip"
        },
        signal,
        duplex: input.duplex
      });
      return result.data;
    },
    cleanupPreview: (signal) => client.request("GET", "/api/releases/cleanup/preview", void 0, signal),
    cleanupRun: (signal) => client.request("POST", "/api/releases/cleanup/run", void 0, signal),
    status: (signal) => client.request("GET", "/api/status", void 0, signal)
  };
}

// ../sdk/dist/storage.js
function createStorageApi(client) {
  return {
    getBackendConfig: (signal) => client.request("GET", "/api/storage/config", void 0, signal),
    createUploadToken: (input, signal) => client.request("POST", "/api/storage/upload-token", input, signal),
    /** 构造受鉴权的稳定下载地址；不提前签发临时 URL。 */
    downloadUrl: (key) => `/api/storage/download-redirect/${encodeURIComponent(key)}`,
    createDownloadToken: (input, signal) => client.request("POST", "/api/storage/download-token", input, signal),
    delete: (key, signal) => client.request("DELETE", `/api/storage/${encodeURIComponent(key)}`, void 0, signal),
    setBackend: (input, signal) => client.request("PUT", "/api/storage/config", input, signal)
  };
}

// ../sdk/dist/terminal.js
function createTerminalsApi(client) {
  const base = (clientId) => `/api/clients/${encodeURIComponent(clientId)}/terminals`;
  const session = (clientId, sessionId) => `${base(clientId)}/${encodeURIComponent(sessionId)}`;
  return {
    /** 列出 Client 实际可用 Shell。 */
    shells: (clientId, signal) => client.request(`GET`, `${base(clientId)}/shells`, void 0, signal),
    /** 会话列表（分页）。 */
    list: (clientId, options, signal) => {
      const params = new URLSearchParams();
      if (options?.page)
        params.set("page", String(options.page));
      if (options?.pageSize)
        params.set("pageSize", String(options.pageSize));
      const qs = params.toString();
      return client.request("GET", `${base(clientId)}${qs ? `?${qs}` : ""}`, void 0, signal);
    },
    /** 创建终端会话（只允许 shellId/cols/rows）。 */
    create: (clientId, body, signal) => client.request("POST", base(clientId), body, signal),
    /** 会话详情。 */
    get: (clientId, sessionId, signal) => client.request("GET", session(clientId, sessionId), void 0, signal),
    /** 关闭会话（幂等）。 */
    remove: (clientId, sessionId, signal) => client.request("DELETE", session(clientId, sessionId), void 0, signal),
    /** 会话审计分页。 */
    audit: (clientId, sessionId, options, signal) => {
      const params = new URLSearchParams();
      if (options?.page)
        params.set("page", String(options.page));
      if (options?.pageSize)
        params.set("pageSize", String(options.pageSize));
      const qs = params.toString();
      return client.request("GET", `${session(clientId, sessionId)}/audit${qs ? `?${qs}` : ""}`, void 0, signal);
    }
  };
}

// ../sdk/dist/client.js
var VcpDeckApiError = class extends Error {
  status;
  code;
  details;
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = "VcpDeckApiError";
  }
};
var VcpDeckClient = class {
  options;
  fetcher;
  baseUrl;
  jobs;
  files;
  auth;
  identities;
  clients;
  clientInstaller;
  storage;
  aliyundrive;
  frp;
  pi;
  releases;
  terminals;
  health = {
    get: (signal) => this.request("GET", "/api/health", void 0, signal)
  };
  constructor(options) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.jobs = createJobsApi(this);
    this.files = createFilesApi(this, this.jobs);
    this.auth = createAuthApi(this);
    this.identities = createIdentitiesApi(this);
    this.clients = createClientsApi(this);
    this.clientInstaller = createClientInstallerApi(this);
    this.storage = createStorageApi(this);
    this.aliyundrive = createAliyunDriveApi(this);
    this.frp = createFrpApi(this, this.jobs);
    this.pi = createPiApi(this);
    this.releases = createReleasesApi(this);
    this.terminals = createTerminalsApi(this);
  }
  /** 发起 JSON REST 请求并归一化失败响应。 */
  async request(method, path2, body, signal) {
    const result = await this.requestRaw(method, path2, {
      body: body === void 0 ? void 0 : JSON.stringify(body),
      headers: body === void 0 ? void 0 : { "Content-Type": "application/json" },
      signal
    });
    return result.data;
  }
  /** 发起原始 body 请求，同时返回响应头供 Node.js 会话等协议使用。 */
  async requestRaw(method, path2, options = {}) {
    const headers = { ...options.headers };
    if (this.options.auth.type === "bearer") {
      headers.Authorization = `Bearer ${this.options.auth.token}`;
    } else if (this.options.auth.cookie) {
      headers.Cookie = this.options.auth.cookie;
    }
    let response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path2}`, {
        method,
        signal: options.signal,
        credentials: this.options.auth.type === "cookie" ? "include" : void 0,
        headers,
        body: options.body,
        ...options.duplex ? { duplex: options.duplex } : {}
      });
    } catch (error) {
      if (options.signal?.aborted)
        throw error;
      throw new VcpDeckApiError("Network request failed", 0);
    }
    const text = await response.text();
    const parsed = text ? parseJson(text) : void 0;
    if (!response.ok) {
      const details = isRecord(parsed) ? parsed : void 0;
      const code = typeof details?.code === "string" ? details.code : void 0;
      const message = typeof details?.message === "string" ? details.message : response.statusText || `HTTP ${response.status}`;
      throw new VcpDeckApiError(message, response.status, code, parsed);
    }
    return { data: parsed, response };
  }
};
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// dist/config.js
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
function parseEnvFile(content) {
  const result = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
      continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1)
      continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let val = trimmed.slice(eqIndex + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}
function loadConfig(searchDir) {
  const dir = searchDir ?? process.cwd();
  const envPath = import_node_path.default.join(dir, "config.env");
  let envFromFile = {};
  if (import_node_fs.default.existsSync(envPath)) {
    try {
      const content = import_node_fs.default.readFileSync(envPath, "utf-8");
      envFromFile = parseEnvFile(content);
    } catch (err) {
      process.stderr.write(`[VCPDeck] Failed to read config.env: ${err}
`);
    }
  }
  const serverUrl = envFromFile.SERVER_URL || process.env.VCPDECK_SERVER_URL || process.env.SERVER_URL || "";
  const apiToken = envFromFile.API_TOKEN || process.env.VCPDECK_API_TOKEN || process.env.API_TOKEN || "";
  const timeoutStr = envFromFile.REQUEST_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || "30000";
  if (!serverUrl) {
    throw new Error("Missing SERVER_URL in config.env or environment variables");
  }
  if (!apiToken) {
    throw new Error("Missing API_TOKEN in config.env or environment variables");
  }
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    apiToken,
    requestTimeoutMs: Number.parseInt(timeoutStr, 10) || 3e4
  };
}

// dist/handlers/clients.js
async function handleListClients(client) {
  const clients = await client.clients.list();
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(clients, null, 2)
      }
    ],
    messageForAI: `\u6210\u529F\u83B7\u53D6\u673A\u5668\u5217\u8868\uFF0C\u5171 ${clients.length} \u53F0\u673A\u5668\u3002`
  };
}

// dist/utils.js
async function resolveClientId(client, filter) {
  if (!filter)
    throw new Error("Missing client filter");
  const list = await client.clients.list();
  const match = list.find((c) => c.clientId === filter || c.name === filter);
  if (!match) {
    throw new Error(`\u672A\u627E\u5230\u5339\u914D\u7684\u673A\u5668 "${filter}"\uFF0C\u8BF7\u5148\u8C03\u7528 ListClients \u67E5\u770B\u53EF\u7528\u673A\u5668\u5217\u8868\u3002`);
  }
  return match.clientId;
}
async function resolveRootDir(client, clientId, specifiedRoot) {
  if (specifiedRoot)
    return specifiedRoot;
  const roots = await client.files.roots(clientId);
  if (!roots || roots.length === 0) {
    throw new Error(`\u673A\u5668 ${clientId} \u672A\u914D\u7F6E\u4EFB\u4F55\u6388\u6743\u6587\u4EF6\u6839\u76EE\u5F55\u3002`);
  }
  if (roots.length === 1) {
    return roots[0];
  }
  throw new Error(`\u673A\u5668 ${clientId} \u62E5\u6709\u591A\u4E2A\u6388\u6743\u6839\u76EE\u5F55 [${roots.join(", ")}]\uFF0C\u8BF7\u663E\u5F0F\u63D0\u4F9B rootDir \u53C2\u6570\u3002`);
}

// dist/handlers/jobs.js
async function handleListJobs(client, params) {
  const clientFilter = params.clientId || params.clientName || params.client;
  const clientId = clientFilter ? await resolveClientId(client, String(clientFilter)) : void 0;
  const status = params.status ? String(params.status) : void 0;
  const page = params.page ? Number(params.page) : void 0;
  const pageSize = params.pageSize ? Number(params.pageSize) : void 0;
  const jobs = await client.jobs.list({
    clientId,
    status,
    page,
    pageSize
  });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(jobs, null, 2)
      }
    ],
    messageForAI: `\u67E5\u8BE2\u5230 ${jobs.total} \u6761 Job \u8BB0\u5F55 (\u5F53\u524D\u7B2C ${jobs.page}/${jobs.totalPages} \u9875)\u3002`
  };
}
async function handleGetJobOutput(client, params) {
  const jobId = String(params.jobId || "");
  if (!jobId) {
    throw new Error("Missing required parameter: jobId");
  }
  const res = await client.jobs.output(jobId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: res.output ?? "(\u8BE5 Job \u5C1A\u65E0\u8F93\u51FA\u843D\u76D8\u6216\u65E5\u5FD7\u4E3A\u7A7A)"
      }
    ],
    messageForAI: `\u6210\u529F\u83B7\u53D6 Job ${jobId} \u7684\u5B8C\u6574\u65E5\u5FD7\u8F93\u51FA\u3002`
  };
}
async function handleRunShellJob(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const command = String(params.command || "");
  const timeout = params.timeout ? Number(params.timeout) : void 0;
  if (!clientFilter || !command) {
    throw new Error("Missing required parameters: clientId (or client), command");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const job = await client.jobs.create({
    clientId,
    type: "exec",
    payload: {
      command,
      timeout
    }
  });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(job, null, 2)
      }
    ],
    messageForAI: `\u5DF2\u6210\u529F\u5728\u673A\u5668 ${clientId} \u4E0A\u6D3E\u53D1 Shell Job\uFF0CjobId: ${job.jobId}\u3002\u53EF\u4EE5\u4F7F\u7528 GetJob \u6216 GetJobOutput \u67E5\u8BE2\u540E\u7EED\u6267\u884C\u7ED3\u679C\u3002`
  };
}
async function handleGetJob(client, params) {
  const jobId = String(params.jobId || "");
  if (!jobId) {
    throw new Error("Missing required parameter: jobId");
  }
  const job = await client.jobs.get(jobId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(job, null, 2)
      }
    ],
    messageForAI: `\u5DF2\u83B7\u53D6 Job ${jobId} \u7684\u72B6\u6001\u8BE6\u60C5 (\u5F53\u524D\u72B6\u6001: ${job.status})\u3002`
  };
}
async function handleCancelJob(client, params) {
  const jobId = String(params.jobId || "");
  if (!jobId) {
    throw new Error("Missing required parameter: jobId");
  }
  const job = await client.jobs.cancel(jobId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(job, null, 2)
      }
    ],
    messageForAI: `\u5DF2\u53D6\u6D88 Job ${jobId}\u3002`
  };
}

// dist/handlers/files.js
async function handleListRoots(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  if (!clientFilter) {
    throw new Error("Missing required parameter: clientId (or client)");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const roots = await client.files.roots(clientId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(roots, null, 2)
      }
    ],
    messageForAI: `\u673A\u5668 ${clientId} \u6388\u6743\u6587\u4EF6\u6839\u76EE\u5F55\u83B7\u53D6\u6210\u529F: [${roots.join(", ")}]\u3002`
  };
}
async function handleMakeDirectory(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  await client.files.mkdir(clientId, { rootDir, path: filePath });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: `Successfully created directory ${filePath}`
      }
    ],
    messageForAI: `\u76EE\u5F55 ${filePath} (\u6839: ${rootDir}) \u521B\u5EFA\u6210\u529F\u3002`
  };
}
async function handleStatFile(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  const stat = await client.files.stat(clientId, rootDir, filePath);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(stat, null, 2)
      }
    ],
    messageForAI: `\u6587\u4EF6/\u76EE\u5F55 ${filePath} \u5143\u6570\u636E\u83B7\u53D6\u6210\u529F\u3002`
  };
}
async function handleListDirectory(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  if (!clientFilter) {
    throw new Error("Missing required parameter: clientId (or client)");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  const list = await client.files.list(clientId, rootDir, filePath);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(list, null, 2)
      }
    ],
    messageForAI: `\u76EE\u5F55 ${filePath || rootDir} \u6D4F\u89C8\u6210\u529F\u3002`
  };
}
async function handleReadFile(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  const limit = params.limit ? Number(params.limit) : void 0;
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  const fileData = await client.files.readText(clientId, rootDir, filePath, limit);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: typeof fileData === "string" ? fileData : JSON.stringify(fileData, null, 2)
      }
    ],
    messageForAI: `\u6587\u4EF6 ${filePath} \u8BFB\u53D6\u6210\u529F\u3002`
  };
}
async function handleWriteFile(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  const content = String(params.content ?? "");
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  await client.files.writeText(clientId, { rootDir, path: filePath, content });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: `Successfully wrote ${content.length} characters to ${filePath}`
      }
    ],
    messageForAI: `\u6587\u4EF6 ${filePath} \u5199\u5165\u6210\u529F\u3002`
  };
}
async function handleDeleteFile(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  await client.files.delete(clientId, { rootDir, path: filePath });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: `Successfully deleted ${filePath}`
      }
    ],
    messageForAI: `\u6587\u4EF6 ${filePath} \u5220\u9664\u6210\u529F\u3002`
  };
}
async function handleMoveFile(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const source = String(params.source || "");
  const target = String(params.target || "");
  if (!clientFilter || !source || !target) {
    throw new Error("Missing required parameters: clientId (or client), source, target");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  await client.files.move(clientId, {
    rootDir,
    source,
    destination: target
  });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: `Successfully moved from ${source} to ${target}`
      }
    ],
    messageForAI: `\u6587\u4EF6\u5DF2\u6210\u529F\u4ECE ${source} \u79FB\u52A8\u5230 ${target}\u3002`
  };
}

// dist/handlers/frp.js
async function handleListFrpInstances(client, params) {
  const page = params.page ? Number(params.page) : void 0;
  const pageSize = params.pageSize ? Number(params.pageSize) : void 0;
  const instances = await client.frp.instances.list({ page, pageSize });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(instances, null, 2)
      }
    ],
    messageForAI: `FRP \u5B9E\u4F8B\u5217\u8868\u83B7\u53D6\u6210\u529F\uFF0C\u5171 ${instances.total} \u4E2A\u5B9E\u4F8B\u3002`
  };
}
async function handleGetFrpMapping(client, params) {
  const mappingId = String(params.mappingId || "");
  if (!mappingId) {
    throw new Error("Missing required parameter: mappingId");
  }
  const mapping = await client.frp.get(mappingId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(mapping, null, 2)
      }
    ],
    messageForAI: `FRP \u6620\u5C04 ${mappingId} \u8BE6\u60C5\u83B7\u53D6\u6210\u529F\u3002`
  };
}
async function handleListFrpMappings(client, params = {}) {
  const clientFilter = params.clientId || params.clientName || params.client;
  const clientId = clientFilter ? await resolveClientId(client, String(clientFilter)) : void 0;
  const page = params.page ? Number(params.page) : void 0;
  const pageSize = params.pageSize ? Number(params.pageSize) : void 0;
  const mappings = await client.frp.list({ clientId, page, pageSize });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(mappings, null, 2)
      }
    ],
    messageForAI: `FRP \u6620\u5C04\u5217\u8868\u83B7\u53D6\u6210\u529F\uFF0C\u5171 ${mappings.total} \u6761\u3002`
  };
}
async function handleCreateFrpMapping(client, params) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const localPort = Number(params.localPort);
  const remotePort = Number(params.remotePort);
  const proxyType = params.proxyType || params.type || "tcp";
  if (!clientFilter || !localPort) {
    throw new Error("Missing required parameters: clientId (or client), localPort");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const mapping = await client.frp.create({
    clientId,
    localPort,
    remotePort: remotePort || void 0,
    proxyType
  });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(mapping, null, 2)
      }
    ],
    messageForAI: `FRP \u7AEF\u53E3\u6620\u5C04\u521B\u5EFA\u6210\u529F (${localPort} -> ${remotePort || "auto"})\u3002`
  };
}
async function handleDeleteFrpMapping(client, params) {
  const mappingId = String(params.mappingId || "");
  if (!mappingId) {
    throw new Error("Missing required parameter: mappingId");
  }
  await client.frp.delete(mappingId);
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: `Successfully deleted FRP mapping ${mappingId}`
      }
    ],
    messageForAI: `FRP \u7AEF\u53E3\u6620\u5C04 ${mappingId} \u5DF2\u5220\u9664\u3002`
  };
}

// dist/handlers/storage.js
async function handleGetStorageStatus(client) {
  const status = await client.storage.getBackendConfig();
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(status, null, 2)
      }
    ],
    messageForAI: "\u5B58\u50A8\u540E\u7AEF\u72B6\u6001\u67E5\u8BE2\u6210\u529F\u3002"
  };
}

// dist/handlers/releases.js
async function handleListReleases(client, params) {
  const page = params.page ? Number(params.page) : void 0;
  const pageSize = params.pageSize ? Number(params.pageSize) : void 0;
  const releases = await client.releases.list({ page, pageSize });
  return {
    status: "success",
    content: [
      {
        type: "text",
        text: JSON.stringify(releases, null, 2)
      }
    ],
    messageForAI: `\u6210\u529F\u83B7\u53D6 Release \u7248\u672C\u5217\u8868\uFF0C\u5171 ${releases.total} \u6761\u8BB0\u5F55\u3002`
  };
}

// dist/dispatcher.js
async function dispatchCommand(client, req) {
  const command = req.command;
  const params = req.params || {};
  switch (command) {
    case "ListClients":
      return handleListClients(client);
    case "ListJobs":
      return handleListJobs(client, params);
    case "GetJob":
      return handleGetJob(client, params);
    case "GetJobOutput":
      return handleGetJobOutput(client, params);
    case "RunShellJob":
      return handleRunShellJob(client, params);
    case "CancelJob":
      return handleCancelJob(client, params);
    case "ListRoots":
      return handleListRoots(client, params);
    case "ListDirectory":
      return handleListDirectory(client, params);
    case "StatFile":
      return handleStatFile(client, params);
    case "ReadFile":
      return handleReadFile(client, params);
    case "WriteFile":
      return handleWriteFile(client, params);
    case "MakeDirectory":
      return handleMakeDirectory(client, params);
    case "DeleteFile":
      return handleDeleteFile(client, params);
    case "MoveFile":
      return handleMoveFile(client, params);
    case "ListFrpInstances":
      return handleListFrpInstances(client, params);
    case "ListFrpMappings":
      return handleListFrpMappings(client, params);
    case "GetFrpMapping":
      return handleGetFrpMapping(client, params);
    case "CreateFrpMapping":
      return handleCreateFrpMapping(client, params);
    case "DeleteFrpMapping":
      return handleDeleteFrpMapping(client, params);
    case "GetStorageStatus":
      return handleGetStorageStatus(client);
    case "ListReleases":
      return handleListReleases(client, params);
    default:
      throw new Error(`Unknown command identifier: "${command}"`);
  }
}

// dist/index.js
function sendResponse(response) {
  process.stdout.write(JSON.stringify(response));
}
function sendError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const response = {
    status: "error",
    content: [
      {
        type: "text",
        text: message
      }
    ],
    messageForAI: `\u6267\u884C\u5931\u8D25: ${message}`
  };
  sendResponse(response);
}
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", (err) => {
      reject(err);
    });
  });
}
async function main() {
  let rawInput = "";
  try {
    rawInput = await readStdin();
    if (!rawInput.trim()) {
      throw new Error("No input received on stdin");
    }
    let req;
    try {
      req = JSON.parse(rawInput);
    } catch {
      throw new Error(`Invalid JSON input: ${rawInput}`);
    }
    const config = loadConfig();
    const client = new VcpDeckClient({
      baseUrl: config.serverUrl,
      auth: {
        type: "bearer",
        token: config.apiToken
      }
    });
    const res = await dispatchCommand(client, req);
    sendResponse(res);
  } catch (err) {
    process.stderr.write(`[VCPDeck] Error: ${err}
`);
    sendError(err);
  }
}
main().catch((err) => {
  process.stderr.write(`[VCPDeck] Fatal: ${err}
`);
  process.exit(1);
});
