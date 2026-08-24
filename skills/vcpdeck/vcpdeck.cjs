#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../shared/dist/version.js
var require_version = __commonJS({
  "../shared/dist/version.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.VERSION = void 0;
    exports2.VERSION = "0.6.1";
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
    function parseClientInstallerPlatform(value2) {
      if (value2 === "win-x64" || value2 === "linux-x64")
        return value2;
      throw new Error("platform \u5FC5\u987B\u4E3A win-x64 \u6216 linux-x64");
    }
    function parseClientInstallerConfigUpdate(value2) {
      if (!isRecord2(value2) || Object.keys(value2).length !== 1 || typeof value2.enabled !== "boolean") {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B boolean enabled");
      }
      return { enabled: value2.enabled };
    }
    function parseClientInstallerNameUpdate(value2) {
      if (!isRecord2(value2) || Object.keys(value2).length !== 1 || typeof value2.name !== "string") {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B string name");
      }
      const name = value2.name.trim();
      if (!name || name.length > 100)
        throw new Error("name \u957F\u5EA6\u5FC5\u987B\u4E3A 1-100");
      return { name };
    }
    function isRecord2(value2) {
      return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
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
    exports2.platformFromOs = platformFromOs;
    var ReleaseStatus2;
    (function(ReleaseStatus3) {
      ReleaseStatus3["UPLOADED"] = "uploaded";
      ReleaseStatus3["UPDATING_SERVER"] = "updating_server";
      ReleaseStatus3["UPDATING_CLIENTS"] = "updating_clients";
      ReleaseStatus3["DONE"] = "done";
      ReleaseStatus3["FAILED"] = "failed";
    })(ReleaseStatus2 || (exports2.ReleaseStatus = ReleaseStatus2 = {}));
    var ReleaseClientState2;
    (function(ReleaseClientState3) {
      ReleaseClientState3["PENDING"] = "pending";
      ReleaseClientState3["UPDATING"] = "updating";
      ReleaseClientState3["DONE"] = "done";
      ReleaseClientState3["FAILED"] = "failed";
    })(ReleaseClientState2 || (exports2.ReleaseClientState = ReleaseClientState2 = {}));
    exports2.ReleaseUploadErrorCode = {
      DIRECT_UPLOAD_REQUIRED: "RELEASE_DIRECT_UPLOAD_REQUIRED",
      SESSION_NOT_FOUND: "RELEASE_UPLOAD_SESSION_NOT_FOUND",
      SESSION_EXPIRED: "RELEASE_UPLOAD_SESSION_EXPIRED",
      SESSION_CONFLICT: "RELEASE_UPLOAD_SESSION_CONFLICT",
      SIZE_MISMATCH: "RELEASE_UPLOAD_SIZE_MISMATCH",
      PROVIDER_FAILED: "RELEASE_UPLOAD_PROVIDER_FAILED"
    };
    function parseReleaseUploadCreateInput(value2) {
      if (!isRecord2(value2) || !hasOnlyKeys(value2, ["version", "platform", "sha256", "size"])) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B version/platform/sha256/size");
      }
      if (typeof value2.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value2.version)) {
        throw new Error("version \u683C\u5F0F\u5E94\u4E3A x.y.z");
      }
      if (value2.platform !== "win-x64" && value2.platform !== "linux-x64") {
        throw new Error("platform \u5E94\u4E3A win-x64 \u6216 linux-x64");
      }
      if (typeof value2.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value2.sha256)) {
        throw new Error("sha256 \u5E94\u4E3A 64 \u4F4D\u5C0F\u5199\u5341\u516D\u8FDB\u5236");
      }
      if (typeof value2.size !== "number" || !Number.isSafeInteger(value2.size) || value2.size < 1 || value2.size > 2147483647) {
        throw new Error("size \u5E94\u4E3A 1\u20132147483647 \u7684\u6574\u6570");
      }
      return {
        version: value2.version,
        platform: value2.platform,
        sha256: value2.sha256,
        size: value2.size
      };
    }
    function parseReleaseUploadPartRefresh(value2) {
      if (!isRecord2(value2) || !hasOnlyKeys(value2, ["partNumbers"]) || !Array.isArray(value2.partNumbers)) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B partNumbers \u6570\u7EC4");
      }
      const partNumbers = value2.partNumbers;
      if (partNumbers.length < 1 || partNumbers.length > 100 || partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > 1e4) || new Set(partNumbers).size !== partNumbers.length) {
        throw new Error("partNumbers \u5FC5\u987B\u5305\u542B 1\u2013100 \u4E2A\u4E0D\u91CD\u590D\u7684 1\u201310000 \u6574\u6570");
      }
      return { partNumbers };
    }
    function parseReleaseUploadComplete(value2) {
      if (!isRecord2(value2) || !hasOnlyKeys(value2, ["uploadedBytes"]) || typeof value2.uploadedBytes !== "number" || !Number.isSafeInteger(value2.uploadedBytes) || value2.uploadedBytes < 1 || value2.uploadedBytes > 2147483647) {
        throw new Error("body \u5FC5\u987B\u4E14\u53EA\u80FD\u5305\u542B\u6709\u6548\u6574\u6570 uploadedBytes");
      }
      return { uploadedBytes: value2.uploadedBytes };
    }
    function isRecord2(value2) {
      return typeof value2 === "object" && value2 !== null && !Array.isArray(value2);
    }
    function hasOnlyKeys(value2, keys) {
      const actual = Object.keys(value2);
      return actual.length === keys.length && actual.every((key) => keys.includes(key));
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
    function isPiThinkingLevel(value2) {
      return typeof value2 === "string" && exports2.PI_THINKING_LEVELS.includes(value2);
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
    function safePiErrorMessage(value2) {
      return typeof value2 === "string" && value2.length > 0 ? value2.slice(0, MAX_ERROR_MESSAGE_CHARS) : "Pi request failed";
    }
    function parseExtensionUi(value2, what, interactiveOnly = false) {
      assertRecord(value2, what);
      assertKeys(value2, /* @__PURE__ */ new Set([
        "requestId",
        "extensionId",
        "kind",
        "title",
        "message",
        "options",
        "timeoutMs"
      ]), what);
      assertString(value2.requestId, `${what}.requestId`, MAX_TEXT_CHARS);
      assertString(value2.extensionId, `${what}.extensionId`, MAX_TEXT_CHARS);
      assertString(value2.kind, `${what}.kind`);
      const kinds = interactiveOnly ? INTERACTIVE_EXTENSION_UI_KINDS : EXTENSION_UI_KINDS;
      if (!kinds.has(value2.kind))
        throw new PiProtocolError(`${what}.kind \u4E0D\u53D7\u652F\u6301`);
      assertOptionalString(value2.title, `${what}.title`, MAX_TEXT_CHARS);
      assertOptionalString(value2.message, `${what}.message`, MAX_TEXT_CHARS);
      if (value2.options !== void 0) {
        if (!Array.isArray(value2.options))
          throw new PiProtocolError(`${what}.options \u5FC5\u987B\u662F\u6570\u7EC4`);
        if (value2.options.length > MAX_EXTENSION_OPTIONS)
          throw new PiProtocolError(`${what}.options \u6570\u91CF\u8D85\u8FC7\u4E0A\u9650`);
        for (const option of value2.options)
          assertString(option, `${what}.options \u9879`, MAX_OPTION_CHARS);
      }
      if (value2.timeoutMs !== void 0 && (typeof value2.timeoutMs !== "number" || !Number.isFinite(value2.timeoutMs) || value2.timeoutMs < 0)) {
        throw new PiProtocolError(`${what}.timeoutMs \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57`);
      }
      return value2;
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
    function safeTerminalErrorMessage(value2) {
      return typeof value2 === "string" && value2.length > 0 ? value2.slice(0, 200) : "Terminal operation failed";
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
    function utf8ByteLength(value2) {
      return new TextEncoder().encode(value2).byteLength;
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
    exports2.FrpJobType = exports2.FrpProtocolError = exports2.FRP_ERROR_CODES = exports2.FRP_MAPPING_STATUSES = exports2.StorageProviderKind = exports2.AuthErrorCode = exports2.FileErrorCode = exports2.JobStatus = exports2.JobType = exports2.Events = exports2.safePiErrorMessage = exports2.parsePiAgentState = exports2.isPiThinkingLevel = exports2.isPiAgentIdle = exports2.PI_THINKING_LEVELS = exports2.PI_SESSION_JOB_PROTOCOL_VERSION = exports2.PI_ERROR_CODES = exports2.platformFromOs = exports2.parseReleaseUploadPartRefresh = exports2.parseReleaseUploadCreateInput = exports2.parseReleaseUploadComplete = exports2.ReleaseUploadErrorCode = exports2.ReleaseStatus = exports2.ReleaseClientState = exports2.parseClientInstallerPlatform = exports2.parseClientInstallerNameUpdate = exports2.parseClientInstallerConfigUpdate = exports2.ClientInstallerErrorCode = exports2.VERSION = void 0;
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
      SERVER_SHUTDOWN: "server:shutdown"
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
      JobType2["FILE_ROOTS"] = "file.roots";
    })(JobType || (exports2.JobType = JobType = {}));
    var JobStatus4;
    (function(JobStatus5) {
      JobStatus5["IDLE"] = "idle";
      JobStatus5["PENDING"] = "pending";
      JobStatus5["RUNNING"] = "running";
      JobStatus5["WAITING_INPUT"] = "waiting_input";
      JobStatus5["DONE"] = "done";
      JobStatus5["ERROR"] = "error";
      JobStatus5["DISCONNECTED"] = "disconnected";
      JobStatus5["CANCELLED"] = "cancelled";
    })(JobStatus4 || (exports2.JobStatus = JobStatus4 = {}));
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
      "error"
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
      "FRPC_STOP_FAILED"
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
      FRP_LIST: "frp.list"
    };
    function parseFrpOperationTimeout(value2) {
      const parsed = value2 === void 0 ? 30 : Number(value2);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
        throw new FrpProtocolError("timeoutSeconds \u5FC5\u987B\u662F 1\u2013300 \u7684\u6574\u6570");
      }
      return parsed;
    }
    function parseFrpMappingCreateRequest(value2) {
      if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) {
        throw new FrpProtocolError("FRP \u521B\u5EFA\u8BF7\u6C42\u5FC5\u987B\u662F\u5BF9\u8C61");
      }
      const input = value2;
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
    function frpString(value2, field, maxLength, pattern) {
      if (typeof value2 !== "string" || value2.length < 1 || value2.length > maxLength || value2 !== value2.trim() || pattern && !pattern.test(value2)) {
        throw new FrpProtocolError(`${field} \u683C\u5F0F\u65E0\u6548`);
      }
      return value2;
    }
    function optionalFrpString(value2, field, maxLength, pattern) {
      return value2 === void 0 ? void 0 : frpString(value2, field, maxLength, pattern);
    }
    function frpPort(value2, field) {
      if (!Number.isInteger(value2) || value2 < 1 || value2 > 65535) {
        throw new FrpProtocolError(`${field} \u5FC5\u987B\u662F 1\u201365535 \u7684\u6574\u6570`);
      }
      return value2;
    }
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
var init_aliyundrive = __esm({
  "../sdk/dist/aliyundrive.js"() {
    "use strict";
  }
});

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
var init_auth = __esm({
  "../sdk/dist/auth.js"() {
    "use strict";
  }
});

// ../sdk/dist/clients.js
function createClientsApi(client) {
  return {
    list: (signal) => client.request("GET", "/api/clients", void 0, signal),
    /** 修改客户端别名（全局唯一；重名返回 409）。 */
    rename: (clientId, name, signal) => client.request("PATCH", `/api/clients/${encodeURIComponent(clientId)}/name`, { name }, signal)
  };
}
var init_clients = __esm({
  "../sdk/dist/clients.js"() {
    "use strict";
  }
});

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
var init_client_installer = __esm({
  "../sdk/dist/client-installer.js"() {
    "use strict";
  }
});

// ../sdk/dist/files.js
function createFilesApi(client, jobs) {
  async function run2(input, signal) {
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
    roots: async (clientId, signal) => (await run2({ clientId, type: "file.roots", payload: {} }, signal)).roots,
    list: (clientId, rootDir, path, signal) => run2({ clientId, type: "file.list", payload: { rootDir, path } }, signal),
    stat: (clientId, rootDir, path, signal) => run2({ clientId, type: "file.stat", payload: { rootDir, path } }, signal),
    readText: (clientId, rootDir, path, maxBytes = 262144, signal) => run2({
      clientId,
      type: "file.readText",
      payload: { rootDir, path, maxBytes }
    }, signal),
    writeText: (clientId, payload, signal) => run2({ clientId, type: "file.writeText", payload }, signal),
    mkdir: (clientId, payload, signal) => run2({ clientId, type: "file.mkdir", payload }, signal),
    delete: (clientId, payload, signal) => run2({ clientId, type: "file.delete", payload }, signal),
    move: (clientId, payload, signal) => run2({ clientId, type: "file.move", payload }, signal),
    export: (clientId, payload, signal) => run2({ clientId, type: "file.export", payload }, signal),
    import: (clientId, payload, signal) => run2({ clientId, type: "file.import", payload }, signal)
  };
}
var init_files = __esm({
  "../sdk/dist/files.js"() {
    "use strict";
  }
});

// ../sdk/dist/frp.js
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
var import_shared, FrpOperationError;
var init_frp = __esm({
  "../sdk/dist/frp.js"() {
    "use strict";
    import_shared = __toESM(require_dist(), 1);
    FrpOperationError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "FrpOperationError";
      }
    };
  }
});

// ../sdk/dist/jobs.js
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
  return new Promise((resolve2, reject) => {
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
      resolve2();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var TERMINAL_STATUSES;
var init_jobs = __esm({
  "../sdk/dist/jobs.js"() {
    "use strict";
    TERMINAL_STATUSES = /* @__PURE__ */ new Set(["done", "error", "cancelled"]);
  }
});

// ../sdk/dist/pi.js
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
var import_shared2;
var init_pi = __esm({
  "../sdk/dist/pi.js"() {
    "use strict";
    import_shared2 = __toESM(require_dist(), 1);
  }
});

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
    status: (signal) => client.request("GET", "/api/status", void 0, signal)
  };
}
var init_releases = __esm({
  "../sdk/dist/releases.js"() {
    "use strict";
  }
});

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
var init_storage = __esm({
  "../sdk/dist/storage.js"() {
    "use strict";
  }
});

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
var init_terminal = __esm({
  "../sdk/dist/terminal.js"() {
    "use strict";
  }
});

// ../sdk/dist/client.js
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isRecord(value2) {
  return typeof value2 === "object" && value2 !== null;
}
var VcpDeckApiError, VcpDeckClient;
var init_client = __esm({
  "../sdk/dist/client.js"() {
    "use strict";
    init_aliyundrive();
    init_auth();
    init_clients();
    init_client_installer();
    init_files();
    init_frp();
    init_jobs();
    init_pi();
    init_releases();
    init_storage();
    init_terminal();
    VcpDeckApiError = class extends Error {
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
    VcpDeckClient = class {
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
      async request(method, path, body, signal) {
        const result = await this.requestRaw(method, path, {
          body: body === void 0 ? void 0 : JSON.stringify(body),
          headers: body === void 0 ? void 0 : { "Content-Type": "application/json" },
          signal
        });
        return result.data;
      }
      /** 发起原始 body 请求，同时返回响应头供 Node.js 会话等协议使用。 */
      async requestRaw(method, path, options = {}) {
        const headers = { ...options.headers };
        if (this.options.auth.type === "bearer") {
          headers.Authorization = `Bearer ${this.options.auth.token}`;
        } else if (this.options.auth.cookie) {
          headers.Cookie = this.options.auth.cookie;
        }
        let response;
        try {
          response = await this.fetcher(`${this.baseUrl}${path}`, {
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
  }
});

// ../sdk/dist/index.js
var init_dist = __esm({
  "../sdk/dist/index.js"() {
    "use strict";
    init_aliyundrive();
    init_auth();
    init_client();
    init_clients();
    init_client_installer();
    init_files();
    init_frp();
    init_jobs();
    init_pi();
    init_releases();
    init_storage();
    init_terminal();
  }
});

// dist/authenticated-client.js
async function createAuthenticatedClient(environment) {
  if (!environment.credentials)
    throw new Error("\u73AF\u5883\u51ED\u636E\u672A\u89E3\u6790");
  if (environment.credentials.type === "bearer") {
    return new VcpDeckClient({
      baseUrl: environment.server,
      auth: { type: "bearer", token: environment.credentials.token }
    });
  }
  const loginClient = new VcpDeckClient({
    baseUrl: environment.server,
    auth: { type: "cookie" }
  });
  const { cookie } = await loginClient.auth.loginSession({
    username: environment.credentials.username,
    password: environment.credentials.password
  });
  return new VcpDeckClient({
    baseUrl: environment.server,
    auth: { type: "cookie", cookie }
  });
}
var init_authenticated_client = __esm({
  "dist/authenticated-client.js"() {
    "use strict";
    init_dist();
  }
});

// dist/config.js
function defaultConfigPaths(cwd = process.cwd()) {
  return {
    globalConfigPath: (0, import_node_path.join)((0, import_node_os.homedir)(), ".vcpdeck", "cli", "config.json"),
    cwd: (0, import_node_path.resolve)(cwd)
  };
}
function normalizeServerUrl(value2) {
  let url2;
  try {
    url2 = new URL(value2);
  } catch {
    throw new Error(`Server URL \u65E0\u6548: ${value2}`);
  }
  if (url2.protocol !== "http:" && url2.protocol !== "https:" || !url2.hostname) {
    throw new Error("Server URL \u5FC5\u987B\u662F\u5E26\u4E3B\u673A\u540D\u7684 http/https \u5730\u5740");
  }
  if (url2.username || url2.password) {
    throw new Error("Server URL \u4E0D\u5F97\u5185\u5D4C\u7528\u6237\u540D\u6216\u5BC6\u7801");
  }
  if (url2.search || url2.hash) {
    throw new Error("Server URL \u4E0D\u5F97\u5305\u542B query \u6216 fragment");
  }
  if (url2.pathname !== "/" && url2.pathname !== "") {
    throw new Error("Server URL \u5FC5\u987B\u662F origin\uFF0C\u4E0D\u5F97\u5305\u542B\u4E1A\u52A1\u8DEF\u5F84");
  }
  return url2.origin;
}
function assertEnvironmentName(name) {
  if (!ENVIRONMENT_NAME_RE.test(name) || name === "__proto__" || name === "constructor" || name === "prototype") {
    throw new Error("\u73AF\u5883\u540D\u5FC5\u987B\u4EE5\u5B57\u6BCD\u6216\u6570\u5B57\u5F00\u5934\uFF0C\u53EA\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u3001\u8FDE\u5B57\u7B26\uFF08\u6700\u957F 64\uFF09\uFF0C\u4E14\u4E0D\u80FD\u4F7F\u7528\u4FDD\u7559\u540D\u79F0");
  }
}
function assertEnvironmentVariableName(name) {
  if (!ENVIRONMENT_VARIABLE_RE.test(name)) {
    throw new Error(`\u73AF\u5883\u53D8\u91CF\u540D\u65E0\u6548: ${name}`);
  }
}
function parseCliConfig(value2) {
  const root = requireRecord(value2, "CLI \u914D\u7F6E");
  assertOnlyKeys(root, ["version", "defaultEnvironment", "environments"], "CLI \u914D\u7F6E");
  if (root.version !== CLI_CONFIG_VERSION) {
    throw new Error(`CLI \u914D\u7F6E version \u5FC5\u987B\u4E3A ${CLI_CONFIG_VERSION}`);
  }
  if (root.defaultEnvironment !== void 0) {
    if (typeof root.defaultEnvironment !== "string") {
      throw new Error("defaultEnvironment \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
    }
    assertEnvironmentName(root.defaultEnvironment);
  }
  const environmentsValue = requireRecord(root.environments, "environments");
  const environments = {};
  for (const [name, rawEnvironment] of Object.entries(environmentsValue)) {
    assertEnvironmentName(name);
    environments[name] = parseEnvironment(rawEnvironment, name);
  }
  if (root.defaultEnvironment !== void 0 && !Object.hasOwn(environments, root.defaultEnvironment)) {
    throw new Error(`\u9ED8\u8BA4\u73AF\u5883\u4E0D\u5B58\u5728: ${root.defaultEnvironment}`);
  }
  const config = { version: 1, environments };
  if (root.defaultEnvironment) {
    config.defaultEnvironment = root.defaultEnvironment;
  }
  return config;
}
function parseProjectConfig(value2) {
  const root = requireRecord(value2, "\u9879\u76EE\u914D\u7F6E");
  assertOnlyKeys(root, ["version", "environment"], "\u9879\u76EE\u914D\u7F6E");
  if (root.version !== CLI_CONFIG_VERSION) {
    throw new Error(`\u9879\u76EE\u914D\u7F6E version \u5FC5\u987B\u4E3A ${CLI_CONFIG_VERSION}`);
  }
  if (typeof root.environment !== "string") {
    throw new Error("\u9879\u76EE\u914D\u7F6E environment \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
  }
  assertEnvironmentName(root.environment);
  return { version: 1, environment: root.environment };
}
async function loadCliConfig(path, options = {}) {
  const value2 = await readJson(path, options.required ?? false);
  return value2 === void 0 ? { version: CLI_CONFIG_VERSION, environments: {} } : parseCliConfig(value2);
}
async function loadProjectConfig(path) {
  const value2 = await readJson(path, true);
  return parseProjectConfig(value2);
}
async function localProjectConfigTarget(cwd) {
  const normalizedCwd = (0, import_node_path.resolve)(cwd);
  const existing = await findProjectConfig(normalizedCwd);
  if (existing)
    return existing;
  let directory = normalizedCwd;
  for (; ; ) {
    if (await exists((0, import_node_path.join)(directory, ".git"))) {
      return (0, import_node_path.join)(directory, PROJECT_CONFIG_FILE);
    }
    const parent = (0, import_node_path.dirname)(directory);
    if (parent === directory)
      return (0, import_node_path.join)(normalizedCwd, PROJECT_CONFIG_FILE);
    directory = parent;
  }
}
async function saveCliConfig(path, config) {
  const validated = parseCliConfig(config);
  await writeJsonAtomic(path, validated, true);
}
async function saveProjectConfig(path, config) {
  const validated = parseProjectConfig(config);
  await writeJsonAtomic(path, validated, false);
}
async function findProjectConfig(cwd) {
  let directory = (0, import_node_path.resolve)(cwd);
  for (; ; ) {
    const candidate = (0, import_node_path.join)(directory, PROJECT_CONFIG_FILE);
    if (await exists(candidate))
      return candidate;
    if (await exists((0, import_node_path.join)(directory, ".git")))
      return void 0;
    const parent = (0, import_node_path.dirname)(directory);
    if (parent === directory || directory === (0, import_node_path.parse)(directory).root)
      return void 0;
    directory = parent;
  }
}
function parseEnvironment(value2, name) {
  const root = requireRecord(value2, `\u73AF\u5883 ${name}`);
  assertOnlyKeys(root, ["server", "auth"], `\u73AF\u5883 ${name}`);
  if (typeof root.server !== "string") {
    throw new Error(`\u73AF\u5883 ${name}.server \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
  }
  const server = normalizeServerUrl(root.server);
  const auth = requireRecord(root.auth, `\u73AF\u5883 ${name}.auth`);
  if (auth.type === "password") {
    assertOnlyKeys(auth, ["type", "username", "passwordEnv"], `\u73AF\u5883 ${name}.auth`);
    if (typeof auth.username !== "string" || !auth.username.trim()) {
      throw new Error(`\u73AF\u5883 ${name}.auth.username \u4E0D\u80FD\u4E3A\u7A7A`);
    }
    if (typeof auth.passwordEnv !== "string") {
      throw new Error(`\u73AF\u5883 ${name}.auth.passwordEnv \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    }
    assertEnvironmentVariableName(auth.passwordEnv);
    return {
      server,
      auth: {
        type: "password",
        username: auth.username,
        passwordEnv: auth.passwordEnv
      }
    };
  }
  if (auth.type === "bearer") {
    assertOnlyKeys(auth, ["type", "tokenEnv"], `\u73AF\u5883 ${name}.auth`);
    if (typeof auth.tokenEnv !== "string") {
      throw new Error(`\u73AF\u5883 ${name}.auth.tokenEnv \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    }
    assertEnvironmentVariableName(auth.tokenEnv);
    return { server, auth: { type: "bearer", tokenEnv: auth.tokenEnv } };
  }
  throw new Error(`\u73AF\u5883 ${name}.auth.type \u5FC5\u987B\u4E3A password \u6216 bearer`);
}
function requireRecord(value2, label) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) {
    throw new Error(`${label} \u5FC5\u987B\u662F\u5BF9\u8C61`);
  }
  return value2;
}
function assertOnlyKeys(record, allowed, label) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error(`${label} \u542B\u672A\u77E5\u5B57\u6BB5: ${unknown.join(", ")}`);
}
async function readJson(path, required) {
  let text;
  try {
    text = await (0, import_promises.readFile)(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT") && !required)
      return void 0;
    if (isErrno(error, "ENOENT"))
      throw new Error(`\u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728: ${path}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`\u914D\u7F6E\u6587\u4EF6\u4E0D\u662F\u6709\u6548 JSON: ${path}`);
  }
}
async function writeJsonAtomic(path, value2, privateFile) {
  const directory = (0, import_node_path.dirname)(path);
  await (0, import_promises.mkdir)(directory, { recursive: true, mode: privateFile ? 448 : 493 });
  if (privateFile && process.platform !== "win32")
    await (0, import_promises.chmod)(directory, 448);
  const tempPath = (0, import_node_path.join)(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    await (0, import_promises.writeFile)(tempPath, `${JSON.stringify(value2, null, 2)}
`, {
      encoding: "utf8",
      mode: privateFile ? 384 : 420
    });
    if (privateFile && process.platform !== "win32")
      await (0, import_promises.chmod)(tempPath, 384);
    await (0, import_promises.rename)(tempPath, path);
    if (privateFile && process.platform !== "win32")
      await (0, import_promises.chmod)(path, 384);
  } finally {
    try {
      await (0, import_promises.rm)(tempPath, { force: true });
    } catch {
    }
  }
}
async function exists(path) {
  try {
    await (0, import_promises.access)(path, import_node_fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function isErrno(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
var import_node_fs, import_promises, import_node_os, import_node_path, CLI_CONFIG_VERSION, PROJECT_CONFIG_FILE, ENVIRONMENT_NAME_RE, ENVIRONMENT_VARIABLE_RE;
var init_config = __esm({
  "dist/config.js"() {
    "use strict";
    import_node_fs = require("node:fs");
    import_promises = require("node:fs/promises");
    import_node_os = require("node:os");
    import_node_path = require("node:path");
    CLI_CONFIG_VERSION = 1;
    PROJECT_CONFIG_FILE = ".vcpdeck.json";
    ENVIRONMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    ENVIRONMENT_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  }
});

// dist/arguments.js
function parseCommandArgs(argv, schema = {}) {
  const valueOptions = new Set(schema.value ?? []);
  const booleanOptions = new Set(schema.boolean ?? []);
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const parsed = parseLongOption(arg);
    assertKnownOption(parsed.name, valueOptions, booleanOptions);
    if (Object.hasOwn(options, parsed.name)) {
      throw new Error(`\u9009\u9879\u4E0D\u80FD\u91CD\u590D: --${parsed.name}`);
    }
    if (booleanOptions.has(parsed.name)) {
      if (parsed.inlineValue !== void 0) {
        throw new Error(`\u5E03\u5C14\u9009\u9879\u4E0D\u63A5\u53D7\u503C: --${parsed.name}`);
      }
      options[parsed.name] = true;
      continue;
    }
    const value2 = parsed.inlineValue ?? argv[++index];
    options[parsed.name] = requireOptionValue(parsed.name, value2);
  }
  return { positionals, options };
}
function parseLongOption(arg) {
  const raw = arg.slice(2);
  const separator = raw.indexOf("=");
  return separator >= 0 ? { name: raw.slice(0, separator), inlineValue: raw.slice(separator + 1) } : { name: raw };
}
function assertKnownOption(name, valueOptions, booleanOptions) {
  if (!name || !valueOptions.has(name) && !booleanOptions.has(name)) {
    throw new Error(`\u672A\u77E5\u9009\u9879: --${name}`);
  }
}
function requireOptionValue(name, value2) {
  if (value2 === void 0 || value2.startsWith("--") || value2.length === 0) {
    throw new Error(`\u9009\u9879\u7F3A\u5C11\u503C: --${name}`);
  }
  return value2;
}
function stringOption(options, name) {
  const value2 = options[name];
  return typeof value2 === "string" ? value2 : void 0;
}
var init_arguments = __esm({
  "dist/arguments.js"() {
    "use strict";
  }
});

// dist/environment.js
async function resolveEnvironment(options = {}) {
  const paths = options.paths ?? defaultConfigPaths();
  const processEnv = options.processEnv ?? process.env;
  if (options.server && options.environment) {
    throw new Error("--server \u4E0E --env/--environment \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528");
  }
  if (options.server) {
    return resolveDirectEnvironment(options, processEnv);
  }
  const globalConfig = await loadCliConfig(paths.globalConfigPath);
  let source;
  let name;
  if (options.environment) {
    name = options.environment;
    source = { type: "flag", name };
  } else if (processEnv.VCPDECK_ENVIRONMENT) {
    name = processEnv.VCPDECK_ENVIRONMENT;
    source = { type: "environment-variable", name };
  } else {
    const projectPath = await findProjectConfig(paths.cwd);
    if (projectPath) {
      const project = await loadProjectConfig(projectPath);
      name = project.environment;
      source = { type: "project", name, path: projectPath };
    } else if (globalConfig.defaultEnvironment) {
      name = globalConfig.defaultEnvironment;
      source = {
        type: "global-default",
        name,
        path: paths.globalConfigPath
      };
    } else {
      throw new Error("\u672A\u9009\u62E9 VCPDeck \u73AF\u5883\uFF1A\u4F7F\u7528 --env\u3001VCPDECK_ENVIRONMENT\u3001\u9879\u76EE .vcpdeck.json \u6216\u5168\u5C40\u9ED8\u8BA4\u73AF\u5883");
    }
  }
  assertEnvironmentName(name);
  const environment = Object.hasOwn(globalConfig.environments, name) ? globalConfig.environments[name] : void 0;
  if (!environment) {
    throw new Error(`\u73AF\u5883\u4E0D\u5B58\u5728: ${name}\uFF08\u914D\u7F6E: ${paths.globalConfigPath}\uFF09`);
  }
  return resolveRegisteredEnvironment({
    name,
    environment,
    source,
    processEnv,
    requireCredentials: options.requireCredentials ?? true
  });
}
function environmentSourceLabel(source) {
  switch (source.type) {
    case "direct":
      return "--server \u76F4\u8FDE";
    case "flag":
      return `--env=${source.name}`;
    case "environment-variable":
      return `VCPDECK_ENVIRONMENT=${source.name}`;
    case "project":
      return source.path;
    case "global-default":
      return `${source.path}\uFF08\u5168\u5C40\u9ED8\u8BA4\uFF09`;
    default:
      throw new Error("\u672A\u77E5\u73AF\u5883\u6765\u6E90");
  }
}
function formatEnvironmentSummary(environment) {
  const lines = [
    `\u73AF\u5883: ${environment.name ?? "direct"}`,
    `Server: ${environment.server}`,
    `\u6765\u6E90: ${environmentSourceLabel(environment.source)}`
  ];
  if (environment.auth.type === "password") {
    lines.push(`\u8BA4\u8BC1: password (${environment.auth.username}, ${environment.auth.credentialEnv})`);
  } else {
    lines.push(`\u8BA4\u8BC1: bearer (${environment.auth.credentialEnv})`);
  }
  return lines.join("\n");
}
function resolveDirectEnvironment(options, processEnv) {
  const username = options.username ?? processEnv.VCPDECK_ADMIN_USERNAME;
  const password = options.password ?? processEnv.VCPDECK_ADMIN_PASSWORD;
  const requireCredentials = options.requireCredentials ?? true;
  if (requireCredentials && (!username || !password)) {
    throw new Error("\u76F4\u8FDE\u6A21\u5F0F\u9700\u8981 --username/--password \u6216 VCPDECK_ADMIN_USERNAME/VCPDECK_ADMIN_PASSWORD");
  }
  const environment = {
    name: null,
    server: normalizeServerUrl(options.server),
    auth: {
      type: "password",
      username: username ?? "<\u672A\u8BBE\u7F6E>",
      credentialEnv: "VCPDECK_ADMIN_PASSWORD"
    },
    source: { type: "direct" }
  };
  if (username && password) {
    environment.credentials = { type: "password", username, password };
  }
  return environment;
}
function resolveRegisteredEnvironment(options) {
  const { name, environment, source, processEnv, requireCredentials } = options;
  if (environment.auth.type === "password") {
    const password = processEnv[environment.auth.passwordEnv];
    if (requireCredentials && !password) {
      throw new Error(`\u73AF\u5883 ${name} \u7F3A\u5C11\u51ED\u636E\u53D8\u91CF: ${environment.auth.passwordEnv}`);
    }
    const resolved2 = {
      name,
      server: environment.server,
      auth: {
        type: "password",
        username: environment.auth.username,
        credentialEnv: environment.auth.passwordEnv
      },
      source
    };
    if (password) {
      resolved2.credentials = {
        type: "password",
        username: environment.auth.username,
        password
      };
    }
    return resolved2;
  }
  const token = processEnv[environment.auth.tokenEnv];
  if (requireCredentials && !token) {
    throw new Error(`\u73AF\u5883 ${name} \u7F3A\u5C11\u51ED\u636E\u53D8\u91CF: ${environment.auth.tokenEnv}`);
  }
  const resolved = {
    name,
    server: environment.server,
    auth: { type: "bearer", credentialEnv: environment.auth.tokenEnv },
    source
  };
  if (token)
    resolved.credentials = { type: "bearer", token };
  return resolved;
}
var init_environment = __esm({
  "dist/environment.js"() {
    "use strict";
    init_config();
  }
});

// dist/client-resolver.js
async function resolveClientId(clientFilter, paths, processEnv, client) {
  const resolvedClient = client ?? await createAuthenticatedClient(await resolveEnvironment({ paths, processEnv }));
  const clients = await resolvedClient.clients.list();
  const matched = clients.find((entry) => entry.clientId === clientFilter || entry.name === clientFilter);
  if (!matched) {
    throw new Error(`\u672A\u627E\u5230 Client "${clientFilter}"\uFF1B\u5148\u7528 vcpdeck clients list \u67E5\u770B\u53EF\u7528\u673A\u5668`);
  }
  return matched.clientId;
}
async function fetchClientRoots(client, clientId) {
  const roots = await client.files.roots(clientId);
  return Array.isArray(roots) ? roots : [];
}
var init_client_resolver = __esm({
  "dist/client-resolver.js"() {
    "use strict";
    init_authenticated_client();
    init_environment();
  }
});

// dist/table.js
function formatTable3(rows, columns) {
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(columns.map((column) => column.toUpperCase())),
    ...rows.map((row) => line(columns.map((column) => row[column])))
  ].join("\n");
}
var init_table = __esm({
  "dist/table.js"() {
    "use strict";
  }
});

// dist/storage-command.js
var storage_command_exports = {};
__export(storage_command_exports, {
  runStorageCommand: () => runStorageCommand
});
async function runStorageCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "status" || subcommand === void 0) && hasHelp6(argv);
  if (helpRequested) {
    (context.log ?? console.log)(storageUsage());
    return;
  }
  if (subcommand === "status") {
    await runStatus(argv, context);
    return;
  }
  throw new Error(storageUsage());
}
function hasHelp6(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function storageUsage() {
  return [
    "Storage \u547D\u4EE4\uFF08\u53EA\u8BFB\uFF09:",
    "  vcpdeck storage status [--env=<name>] [--json]  # \u67E5\u770B\u5F53\u524D\u6FC0\u6D3B\u7684\u5B58\u50A8\u540E\u7AEF"
  ].join("\n");
}
async function runStatus(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  if (positionals.length > 0)
    throw new Error(storageUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias8(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const config = await client.storage.getBackendConfig();
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(config, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`Storage \u540E\u7AEF: ${config.kind}`);
  if (config.updatedAt)
    log(`\u914D\u7F6E\u66F4\u65B0\u65F6\u95F4: ${config.updatedAt}`);
}
function exclusiveAlias8(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
var init_storage_command = __esm({
  "dist/storage-command.js"() {
    "use strict";
    init_authenticated_client();
    init_arguments();
    init_environment();
  }
});

// ../../node_modules/.pnpm/xmlhttprequest-ssl@2.1.2/node_modules/xmlhttprequest-ssl/lib/XMLHttpRequest.js
var require_XMLHttpRequest = __commonJS({
  "../../node_modules/.pnpm/xmlhttprequest-ssl@2.1.2/node_modules/xmlhttprequest-ssl/lib/XMLHttpRequest.js"(exports2, module2) {
    var fs = require("fs");
    var Url = require("url");
    var spawn = require("child_process").spawn;
    module2.exports = XMLHttpRequest3;
    XMLHttpRequest3.XMLHttpRequest = XMLHttpRequest3;
    function XMLHttpRequest3(opts) {
      "use strict";
      opts = opts || {};
      var self = this;
      var http = require("http");
      var https = require("https");
      var request;
      var response;
      var settings = {};
      var disableHeaderCheck = false;
      var defaultHeaders = {
        "User-Agent": "node-XMLHttpRequest",
        "Accept": "*/*"
      };
      var headers = Object.assign({}, defaultHeaders);
      var forbiddenRequestHeaders = [
        "accept-charset",
        "accept-encoding",
        "access-control-request-headers",
        "access-control-request-method",
        "connection",
        "content-length",
        "content-transfer-encoding",
        "cookie",
        "cookie2",
        "date",
        "expect",
        "host",
        "keep-alive",
        "origin",
        "referer",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via"
      ];
      var forbiddenRequestMethods = [
        "TRACE",
        "TRACK",
        "CONNECT"
      ];
      var sendFlag = false;
      var errorFlag = false;
      var abortedFlag = false;
      var listeners = {};
      this.UNSENT = 0;
      this.OPENED = 1;
      this.HEADERS_RECEIVED = 2;
      this.LOADING = 3;
      this.DONE = 4;
      this.readyState = this.UNSENT;
      this.onreadystatechange = null;
      this.responseText = "";
      this.responseXML = "";
      this.response = Buffer.alloc(0);
      this.status = null;
      this.statusText = null;
      var isAllowedHttpHeader = function(header) {
        return disableHeaderCheck || header && forbiddenRequestHeaders.indexOf(header.toLowerCase()) === -1;
      };
      var isAllowedHttpMethod = function(method) {
        return method && forbiddenRequestMethods.indexOf(method) === -1;
      };
      this.open = function(method, url2, async, user, password) {
        this.abort();
        errorFlag = false;
        abortedFlag = false;
        if (!isAllowedHttpMethod(method)) {
          throw new Error("SecurityError: Request method not allowed");
        }
        settings = {
          "method": method,
          "url": url2.toString(),
          "async": typeof async !== "boolean" ? true : async,
          "user": user || null,
          "password": password || null
        };
        setState(this.OPENED);
      };
      this.setDisableHeaderCheck = function(state) {
        disableHeaderCheck = state;
      };
      this.setRequestHeader = function(header, value2) {
        if (this.readyState != this.OPENED) {
          throw new Error("INVALID_STATE_ERR: setRequestHeader can only be called when state is OPEN");
        }
        if (!isAllowedHttpHeader(header)) {
          console.warn('Refused to set unsafe header "' + header + '"');
          return false;
        }
        if (sendFlag) {
          throw new Error("INVALID_STATE_ERR: send flag is true");
        }
        headers[header] = value2;
        return true;
      };
      this.getResponseHeader = function(header) {
        if (typeof header === "string" && this.readyState > this.OPENED && response.headers[header.toLowerCase()] && !errorFlag) {
          return response.headers[header.toLowerCase()];
        }
        return null;
      };
      this.getAllResponseHeaders = function() {
        if (this.readyState < this.HEADERS_RECEIVED || errorFlag) {
          return "";
        }
        var result = "";
        for (var i in response.headers) {
          if (i !== "set-cookie" && i !== "set-cookie2") {
            result += i + ": " + response.headers[i] + "\r\n";
          }
        }
        return result.substr(0, result.length - 2);
      };
      this.getRequestHeader = function(name) {
        if (typeof name === "string" && headers[name]) {
          return headers[name];
        }
        return "";
      };
      this.send = function(data) {
        if (this.readyState != this.OPENED) {
          throw new Error("INVALID_STATE_ERR: connection must be opened before send() is called");
        }
        if (sendFlag) {
          throw new Error("INVALID_STATE_ERR: send has already been called");
        }
        var ssl = false, local = false;
        var url2 = Url.parse(settings.url);
        var host;
        switch (url2.protocol) {
          case "https:":
            ssl = true;
          // SSL & non-SSL both need host, no break here.
          case "http:":
            host = url2.hostname;
            break;
          case "file:":
            local = true;
            break;
          case void 0:
          case "":
            host = "localhost";
            break;
          default:
            throw new Error("Protocol not supported.");
        }
        if (local) {
          if (settings.method !== "GET") {
            throw new Error("XMLHttpRequest: Only GET method is supported");
          }
          if (settings.async) {
            fs.readFile(unescape(url2.pathname), function(error, data2) {
              if (error) {
                self.handleError(error, error.errno || -1);
              } else {
                self.status = 200;
                self.responseText = data2.toString("utf8");
                self.response = data2;
                setState(self.DONE);
              }
            });
          } else {
            try {
              this.response = fs.readFileSync(unescape(url2.pathname));
              this.responseText = this.response.toString("utf8");
              this.status = 200;
              setState(self.DONE);
            } catch (e) {
              this.handleError(e, e.errno || -1);
            }
          }
          return;
        }
        var port = url2.port || (ssl ? 443 : 80);
        var uri = url2.pathname + (url2.search ? url2.search : "");
        headers["Host"] = host;
        if (!(ssl && port === 443 || port === 80)) {
          headers["Host"] += ":" + url2.port;
        }
        if (settings.user) {
          if (typeof settings.password == "undefined") {
            settings.password = "";
          }
          var authBuf = new Buffer(settings.user + ":" + settings.password);
          headers["Authorization"] = "Basic " + authBuf.toString("base64");
        }
        if (settings.method === "GET" || settings.method === "HEAD") {
          data = null;
        } else if (data) {
          headers["Content-Length"] = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
          var headersKeys = Object.keys(headers);
          if (!headersKeys.some(function(h) {
            return h.toLowerCase() === "content-type";
          })) {
            headers["Content-Type"] = "text/plain;charset=UTF-8";
          }
        } else if (settings.method === "POST") {
          headers["Content-Length"] = 0;
        }
        var agent = opts.agent || false;
        var options = {
          host,
          port,
          path: uri,
          method: settings.method,
          headers,
          agent
        };
        if (ssl) {
          options.pfx = opts.pfx;
          options.key = opts.key;
          options.passphrase = opts.passphrase;
          options.cert = opts.cert;
          options.ca = opts.ca;
          options.ciphers = opts.ciphers;
          options.rejectUnauthorized = opts.rejectUnauthorized === false ? false : true;
        }
        errorFlag = false;
        if (settings.async) {
          var doRequest = ssl ? https.request : http.request;
          sendFlag = true;
          self.dispatchEvent("readystatechange");
          var responseHandler = function(resp2) {
            response = resp2;
            if (response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
              settings.url = response.headers.location;
              var url3 = Url.parse(settings.url);
              host = url3.hostname;
              var newOptions = {
                hostname: url3.hostname,
                port: url3.port,
                path: url3.path,
                method: response.statusCode === 303 ? "GET" : settings.method,
                headers
              };
              if (ssl) {
                newOptions.pfx = opts.pfx;
                newOptions.key = opts.key;
                newOptions.passphrase = opts.passphrase;
                newOptions.cert = opts.cert;
                newOptions.ca = opts.ca;
                newOptions.ciphers = opts.ciphers;
                newOptions.rejectUnauthorized = opts.rejectUnauthorized === false ? false : true;
              }
              request = doRequest(newOptions, responseHandler).on("error", errorHandler);
              request.end();
              return;
            }
            setState(self.HEADERS_RECEIVED);
            self.status = response.statusCode;
            response.on("data", function(chunk) {
              if (chunk) {
                var data2 = Buffer.from(chunk);
                self.response = Buffer.concat([self.response, data2]);
              }
              if (sendFlag) {
                setState(self.LOADING);
              }
            });
            response.on("end", function() {
              if (sendFlag) {
                sendFlag = false;
                setState(self.DONE);
                self.responseText = self.response.toString("utf8");
              }
            });
            response.on("error", function(error) {
              self.handleError(error);
            });
          };
          var errorHandler = function(error) {
            if (request.reusedSocket && error.code === "ECONNRESET")
              return doRequest(options, responseHandler).on("error", errorHandler);
            self.handleError(error);
          };
          request = doRequest(options, responseHandler).on("error", errorHandler);
          if (opts.autoUnref) {
            request.on("socket", (socket) => {
              socket.unref();
            });
          }
          if (data) {
            request.write(data);
          }
          request.end();
          self.dispatchEvent("loadstart");
        } else {
          var contentFile = ".node-xmlhttprequest-content-" + process.pid;
          var syncFile = ".node-xmlhttprequest-sync-" + process.pid;
          fs.writeFileSync(syncFile, "", "utf8");
          var execString = "var http = require('http'), https = require('https'), fs = require('fs');var doRequest = http" + (ssl ? "s" : "") + ".request;var options = " + JSON.stringify(options) + ";var responseText = '';var responseData = Buffer.alloc(0);var req = doRequest(options, function(response) {response.on('data', function(chunk) {  var data = Buffer.from(chunk);  responseText += data.toString('utf8');  responseData = Buffer.concat([responseData, data]);});response.on('end', function() {fs.writeFileSync('" + contentFile + "', JSON.stringify({err: null, data: {statusCode: response.statusCode, headers: response.headers, text: responseText, data: responseData.toString('base64')}}), 'utf8');fs.unlinkSync('" + syncFile + "');});response.on('error', function(error) {fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');fs.unlinkSync('" + syncFile + "');});}).on('error', function(error) {fs.writeFileSync('" + contentFile + "', 'NODE-XMLHTTPREQUEST-ERROR:' + JSON.stringify(error), 'utf8');fs.unlinkSync('" + syncFile + "');});" + (data ? "req.write('" + JSON.stringify(data).slice(1, -1).replace(/'/g, "\\'") + "');" : "") + "req.end();";
          var syncProc = spawn(process.argv[0], ["-e", execString]);
          var statusText;
          while (fs.existsSync(syncFile)) {
          }
          self.responseText = fs.readFileSync(contentFile, "utf8");
          syncProc.stdin.end();
          fs.unlinkSync(contentFile);
          if (self.responseText.match(/^NODE-XMLHTTPREQUEST-ERROR:/)) {
            var errorObj = JSON.parse(self.responseText.replace(/^NODE-XMLHTTPREQUEST-ERROR:/, ""));
            self.handleError(errorObj, 503);
          } else {
            self.status = self.responseText.replace(/^NODE-XMLHTTPREQUEST-STATUS:([0-9]*),.*/, "$1");
            var resp = JSON.parse(self.responseText.replace(/^NODE-XMLHTTPREQUEST-STATUS:[0-9]*,(.*)/, "$1"));
            response = {
              statusCode: self.status,
              headers: resp.data.headers
            };
            self.responseText = resp.data.text;
            self.response = Buffer.from(resp.data.data, "base64");
            setState(self.DONE, true);
          }
        }
      };
      this.handleError = function(error, status) {
        this.status = status || 0;
        this.statusText = error;
        this.responseText = error.stack;
        errorFlag = true;
        setState(this.DONE);
      };
      this.abort = function() {
        if (request) {
          request.abort();
          request = null;
        }
        headers = Object.assign({}, defaultHeaders);
        this.responseText = "";
        this.responseXML = "";
        this.response = Buffer.alloc(0);
        errorFlag = abortedFlag = true;
        if (this.readyState !== this.UNSENT && (this.readyState !== this.OPENED || sendFlag) && this.readyState !== this.DONE) {
          sendFlag = false;
          setState(this.DONE);
        }
        this.readyState = this.UNSENT;
      };
      this.addEventListener = function(event, callback) {
        if (!(event in listeners)) {
          listeners[event] = [];
        }
        listeners[event].push(callback);
      };
      this.removeEventListener = function(event, callback) {
        if (event in listeners) {
          listeners[event] = listeners[event].filter(function(ev) {
            return ev !== callback;
          });
        }
      };
      this.dispatchEvent = function(event) {
        if (typeof self["on" + event] === "function") {
          if (this.readyState === this.DONE && settings.async)
            setTimeout(function() {
              self["on" + event]();
            }, 0);
          else
            self["on" + event]();
        }
        if (event in listeners) {
          for (let i = 0, len = listeners[event].length; i < len; i++) {
            if (this.readyState === this.DONE)
              setTimeout(function() {
                listeners[event][i].call(self);
              }, 0);
            else
              listeners[event][i].call(self);
          }
        }
      };
      var setState = function(state) {
        if (self.readyState === state || self.readyState === self.UNSENT && abortedFlag)
          return;
        self.readyState = state;
        if (settings.async || self.readyState < self.OPENED || self.readyState === self.DONE) {
          self.dispatchEvent("readystatechange");
        }
        if (self.readyState === self.DONE) {
          let fire;
          if (abortedFlag)
            fire = "abort";
          else if (errorFlag)
            fire = "error";
          else
            fire = "load";
          self.dispatchEvent(fire);
          self.dispatchEvent("loadend");
        }
      };
    }
  }
});

// ../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/commons.js
var PACKET_TYPES, PACKET_TYPES_REVERSE, ERROR_PACKET;
var init_commons = __esm({
  "../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/commons.js"() {
    PACKET_TYPES = /* @__PURE__ */ Object.create(null);
    PACKET_TYPES["open"] = "0";
    PACKET_TYPES["close"] = "1";
    PACKET_TYPES["ping"] = "2";
    PACKET_TYPES["pong"] = "3";
    PACKET_TYPES["message"] = "4";
    PACKET_TYPES["upgrade"] = "5";
    PACKET_TYPES["noop"] = "6";
    PACKET_TYPES_REVERSE = /* @__PURE__ */ Object.create(null);
    Object.keys(PACKET_TYPES).forEach((key) => {
      PACKET_TYPES_REVERSE[PACKET_TYPES[key]] = key;
    });
    ERROR_PACKET = { type: "error", data: "parser error" };
  }
});

// ../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/encodePacket.js
function encodePacketToBinary(packet, callback) {
  if (packet.data instanceof ArrayBuffer || ArrayBuffer.isView(packet.data)) {
    return callback(toBuffer(packet.data, false));
  }
  encodePacket(packet, true, (encoded) => {
    if (!TEXT_ENCODER) {
      TEXT_ENCODER = new TextEncoder();
    }
    callback(TEXT_ENCODER.encode(encoded));
  });
}
var encodePacket, toBuffer, TEXT_ENCODER;
var init_encodePacket = __esm({
  "../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/encodePacket.js"() {
    init_commons();
    encodePacket = ({ type, data }, supportsBinary, callback) => {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return callback(supportsBinary ? data : "b" + toBuffer(data, true).toString("base64"));
      }
      return callback(PACKET_TYPES[type] + (data || ""));
    };
    toBuffer = (data, forceBufferConversion) => {
      if (Buffer.isBuffer(data) || data instanceof Uint8Array && !forceBufferConversion) {
        return data;
      } else if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
      } else {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/decodePacket.js
var decodePacket, mapBinary;
var init_decodePacket = __esm({
  "../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/decodePacket.js"() {
    init_commons();
    decodePacket = (encodedPacket, binaryType) => {
      if (typeof encodedPacket !== "string") {
        return {
          type: "message",
          data: mapBinary(encodedPacket, binaryType)
        };
      }
      const type = encodedPacket.charAt(0);
      if (type === "b") {
        const buffer = Buffer.from(encodedPacket.substring(1), "base64");
        return {
          type: "message",
          data: mapBinary(buffer, binaryType)
        };
      }
      if (!PACKET_TYPES_REVERSE[type]) {
        return ERROR_PACKET;
      }
      return encodedPacket.length > 1 ? {
        type: PACKET_TYPES_REVERSE[type],
        data: encodedPacket.substring(1)
      } : {
        type: PACKET_TYPES_REVERSE[type]
      };
    };
    mapBinary = (data, binaryType) => {
      switch (binaryType) {
        case "arraybuffer":
          if (data instanceof ArrayBuffer) {
            return data;
          } else if (Buffer.isBuffer(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
          } else {
            return data.buffer;
          }
        case "nodebuffer":
        default:
          if (Buffer.isBuffer(data)) {
            return data;
          } else {
            return Buffer.from(data);
          }
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/index.js
function createPacketEncoderStream() {
  return new TransformStream({
    transform(packet, controller) {
      encodePacketToBinary(packet, (encodedPacket) => {
        const payloadLength = encodedPacket.length;
        let header;
        if (payloadLength < 126) {
          header = new Uint8Array(1);
          new DataView(header.buffer).setUint8(0, payloadLength);
        } else if (payloadLength < 65536) {
          header = new Uint8Array(3);
          const view = new DataView(header.buffer);
          view.setUint8(0, 126);
          view.setUint16(1, payloadLength);
        } else {
          header = new Uint8Array(9);
          const view = new DataView(header.buffer);
          view.setUint8(0, 127);
          view.setBigUint64(1, BigInt(payloadLength));
        }
        if (packet.data && typeof packet.data !== "string") {
          header[0] |= 128;
        }
        controller.enqueue(header);
        controller.enqueue(encodedPacket);
      });
    }
  });
}
function totalLength(chunks) {
  return chunks.reduce((acc, chunk) => acc + chunk.length, 0);
}
function concatChunks(chunks, size) {
  if (chunks[0].length === size) {
    return chunks.shift();
  }
  const buffer = new Uint8Array(size);
  let j = 0;
  for (let i = 0; i < size; i++) {
    buffer[i] = chunks[0][j++];
    if (j === chunks[0].length) {
      chunks.shift();
      j = 0;
    }
  }
  if (chunks.length && j < chunks[0].length) {
    chunks[0] = chunks[0].slice(j);
  }
  return buffer;
}
function createPacketDecoderStream(maxPayload, binaryType) {
  if (!TEXT_DECODER) {
    TEXT_DECODER = new TextDecoder();
  }
  const chunks = [];
  let state = 0;
  let expectedLength = -1;
  let isBinary2 = false;
  return new TransformStream({
    transform(chunk, controller) {
      chunks.push(chunk);
      while (true) {
        if (state === 0) {
          if (totalLength(chunks) < 1) {
            break;
          }
          const header = concatChunks(chunks, 1);
          isBinary2 = (header[0] & 128) === 128;
          expectedLength = header[0] & 127;
          if (expectedLength < 126) {
            state = 3;
          } else if (expectedLength === 126) {
            state = 1;
          } else {
            state = 2;
          }
        } else if (state === 1) {
          if (totalLength(chunks) < 2) {
            break;
          }
          const headerArray = concatChunks(chunks, 2);
          expectedLength = new DataView(headerArray.buffer, headerArray.byteOffset, headerArray.length).getUint16(0);
          state = 3;
        } else if (state === 2) {
          if (totalLength(chunks) < 8) {
            break;
          }
          const headerArray = concatChunks(chunks, 8);
          const view = new DataView(headerArray.buffer, headerArray.byteOffset, headerArray.length);
          const n = view.getUint32(0);
          if (n > Math.pow(2, 53 - 32) - 1) {
            controller.enqueue(ERROR_PACKET);
            break;
          }
          expectedLength = n * Math.pow(2, 32) + view.getUint32(4);
          state = 3;
        } else {
          if (totalLength(chunks) < expectedLength) {
            break;
          }
          const data = concatChunks(chunks, expectedLength);
          controller.enqueue(decodePacket(isBinary2 ? data : TEXT_DECODER.decode(data), binaryType));
          state = 0;
        }
        if (expectedLength === 0 || expectedLength > maxPayload) {
          controller.enqueue(ERROR_PACKET);
          break;
        }
      }
    }
  });
}
var SEPARATOR, encodePayload, decodePayload, TEXT_DECODER, protocol;
var init_esm = __esm({
  "../../node_modules/.pnpm/engine.io-parser@5.2.3/node_modules/engine.io-parser/build/esm/index.js"() {
    init_encodePacket();
    init_decodePacket();
    init_commons();
    SEPARATOR = String.fromCharCode(30);
    encodePayload = (packets, callback) => {
      const length = packets.length;
      const encodedPackets = new Array(length);
      let count = 0;
      packets.forEach((packet, i) => {
        encodePacket(packet, false, (encodedPacket) => {
          encodedPackets[i] = encodedPacket;
          if (++count === length) {
            callback(encodedPackets.join(SEPARATOR));
          }
        });
      });
    };
    decodePayload = (encodedPayload, binaryType) => {
      const encodedPackets = encodedPayload.split(SEPARATOR);
      const packets = [];
      for (let i = 0; i < encodedPackets.length; i++) {
        const decodedPacket = decodePacket(encodedPackets[i], binaryType);
        packets.push(decodedPacket);
        if (decodedPacket.type === "error") {
          break;
        }
      }
      return packets;
    };
    protocol = 4;
  }
});

// ../../node_modules/.pnpm/@socket.io+component-emitter@3.1.2/node_modules/@socket.io/component-emitter/lib/cjs/index.js
var require_cjs = __commonJS({
  "../../node_modules/.pnpm/@socket.io+component-emitter@3.1.2/node_modules/@socket.io/component-emitter/lib/cjs/index.js"(exports2) {
    exports2.Emitter = Emitter7;
    function Emitter7(obj) {
      if (obj) return mixin(obj);
    }
    function mixin(obj) {
      for (var key in Emitter7.prototype) {
        obj[key] = Emitter7.prototype[key];
      }
      return obj;
    }
    Emitter7.prototype.on = Emitter7.prototype.addEventListener = function(event, fn) {
      this._callbacks = this._callbacks || {};
      (this._callbacks["$" + event] = this._callbacks["$" + event] || []).push(fn);
      return this;
    };
    Emitter7.prototype.once = function(event, fn) {
      function on2() {
        this.off(event, on2);
        fn.apply(this, arguments);
      }
      on2.fn = fn;
      this.on(event, on2);
      return this;
    };
    Emitter7.prototype.off = Emitter7.prototype.removeListener = Emitter7.prototype.removeAllListeners = Emitter7.prototype.removeEventListener = function(event, fn) {
      this._callbacks = this._callbacks || {};
      if (0 == arguments.length) {
        this._callbacks = {};
        return this;
      }
      var callbacks = this._callbacks["$" + event];
      if (!callbacks) return this;
      if (1 == arguments.length) {
        delete this._callbacks["$" + event];
        return this;
      }
      var cb;
      for (var i = 0; i < callbacks.length; i++) {
        cb = callbacks[i];
        if (cb === fn || cb.fn === fn) {
          callbacks.splice(i, 1);
          break;
        }
      }
      if (callbacks.length === 0) {
        delete this._callbacks["$" + event];
      }
      return this;
    };
    Emitter7.prototype.emit = function(event) {
      this._callbacks = this._callbacks || {};
      var args = new Array(arguments.length - 1), callbacks = this._callbacks["$" + event];
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
      if (callbacks) {
        callbacks = callbacks.slice(0);
        for (var i = 0, len = callbacks.length; i < len; ++i) {
          callbacks[i].apply(this, args);
        }
      }
      return this;
    };
    Emitter7.prototype.emitReserved = Emitter7.prototype.emit;
    Emitter7.prototype.listeners = function(event) {
      this._callbacks = this._callbacks || {};
      return this._callbacks["$" + event] || [];
    };
    Emitter7.prototype.hasListeners = function(event) {
      return !!this.listeners(event).length;
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/globals.node.js
function createCookieJar() {
  return new CookieJar();
}
function parse2(setCookieString) {
  const parts2 = setCookieString.split("; ");
  const i = parts2[0].indexOf("=");
  if (i === -1) {
    return;
  }
  const name = parts2[0].substring(0, i).trim();
  if (!name.length) {
    return;
  }
  let value2 = parts2[0].substring(i + 1).trim();
  if (value2.charCodeAt(0) === 34) {
    value2 = value2.slice(1, -1);
  }
  const cookie = {
    name,
    value: value2
  };
  for (let j = 1; j < parts2.length; j++) {
    const subParts = parts2[j].split("=");
    if (subParts.length !== 2) {
      continue;
    }
    const key = subParts[0].trim();
    const value3 = subParts[1].trim();
    switch (key) {
      case "Expires":
        cookie.expires = new Date(value3);
        break;
      case "Max-Age":
        const expiration = /* @__PURE__ */ new Date();
        expiration.setUTCSeconds(expiration.getUTCSeconds() + parseInt(value3, 10));
        cookie.expires = expiration;
        break;
      default:
    }
  }
  return cookie;
}
var nextTick, globalThisShim, defaultBinaryType, CookieJar;
var init_globals_node = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/globals.node.js"() {
    nextTick = process.nextTick;
    globalThisShim = global;
    defaultBinaryType = "nodebuffer";
    CookieJar = class {
      constructor() {
        this._cookies = /* @__PURE__ */ new Map();
      }
      parseCookies(values) {
        if (!values) {
          return;
        }
        values.forEach((value2) => {
          const parsed = parse2(value2);
          if (parsed) {
            this._cookies.set(parsed.name, parsed);
          }
        });
      }
      get cookies() {
        const now = Date.now();
        this._cookies.forEach((cookie, name) => {
          var _a;
          if (((_a = cookie.expires) === null || _a === void 0 ? void 0 : _a.getTime()) < now) {
            this._cookies.delete(name);
          }
        });
        return this._cookies.entries();
      }
      addCookies(xhr) {
        const cookies = [];
        for (const [name, cookie] of this.cookies) {
          cookies.push(`${name}=${cookie.value}`);
        }
        if (cookies.length) {
          xhr.setDisableHeaderCheck(true);
          xhr.setRequestHeader("cookie", cookies.join("; "));
        }
      }
      appendCookies(headers) {
        for (const [name, cookie] of this.cookies) {
          headers.append("cookie", `${name}=${cookie.value}`);
        }
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/util.js
function pick(obj, ...attr) {
  return attr.reduce((acc, k) => {
    if (obj.hasOwnProperty(k)) {
      acc[k] = obj[k];
    }
    return acc;
  }, {});
}
function installTimerFunctions(obj, opts) {
  if (opts.useNativeTimers) {
    obj.setTimeoutFn = NATIVE_SET_TIMEOUT.bind(globalThisShim);
    obj.clearTimeoutFn = NATIVE_CLEAR_TIMEOUT.bind(globalThisShim);
  } else {
    obj.setTimeoutFn = globalThisShim.setTimeout.bind(globalThisShim);
    obj.clearTimeoutFn = globalThisShim.clearTimeout.bind(globalThisShim);
  }
}
function byteLength(obj) {
  if (typeof obj === "string") {
    return utf8Length(obj);
  }
  return Math.ceil((obj.byteLength || obj.size) * BASE64_OVERHEAD);
}
function utf8Length(str) {
  let c = 0, length = 0;
  for (let i = 0, l = str.length; i < l; i++) {
    c = str.charCodeAt(i);
    if (c < 128) {
      length += 1;
    } else if (c < 2048) {
      length += 2;
    } else if (c < 55296 || c >= 57344) {
      length += 3;
    } else {
      i++;
      length += 4;
    }
  }
  return length;
}
function randomString() {
  return Date.now().toString(36).substring(3) + Math.random().toString(36).substring(2, 5);
}
var NATIVE_SET_TIMEOUT, NATIVE_CLEAR_TIMEOUT, BASE64_OVERHEAD;
var init_util = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/util.js"() {
    init_globals_node();
    NATIVE_SET_TIMEOUT = globalThisShim.setTimeout;
    NATIVE_CLEAR_TIMEOUT = globalThisShim.clearTimeout;
    BASE64_OVERHEAD = 1.33;
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/parseqs.js
function encode(obj) {
  let str = "";
  for (let i in obj) {
    if (obj.hasOwnProperty(i)) {
      if (str.length)
        str += "&";
      str += encodeURIComponent(i) + "=" + encodeURIComponent(obj[i]);
    }
  }
  return str;
}
function decode(qs) {
  let qry = {};
  let pairs = qs.split("&");
  for (let i = 0, l = pairs.length; i < l; i++) {
    let pair = pairs[i].split("=");
    qry[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
  }
  return qry;
}
var init_parseqs = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/parseqs.js"() {
  }
});

// ../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "../../node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports2, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse4(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse4(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// ../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js
var require_common = __commonJS({
  "../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js"(exports2, module2) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug12(...args) {
          if (!debug12.enabled) {
            return;
          }
          const self = debug12;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self.diff = ms;
          self.prev = prevTime;
          self.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self, args);
          const logFn = self.log || createDebug.log;
          logFn.apply(self, args);
        }
        debug12.namespace = namespace;
        debug12.useColors = createDebug.useColors();
        debug12.color = createDebug.selectColor(namespace);
        debug12.extend = extend;
        debug12.destroy = createDebug.destroy;
        Object.defineProperty(debug12, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug12);
        }
        return debug12;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module2.exports = setup;
  }
});

// ../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js"(exports2, module2) {
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.storage = localstorage();
    exports2.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports2.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module2.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports2.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports2.storage.setItem("debug", namespaces);
        } else {
          exports2.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports2.storage.getItem("debug") || exports2.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// ../../node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/index.js
var require_has_flag = __commonJS({
  "../../node_modules/.pnpm/has-flag@4.0.0/node_modules/has-flag/index.js"(exports2, module2) {
    "use strict";
    module2.exports = (flag, argv = process.argv) => {
      const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
      const position = argv.indexOf(prefix + flag);
      const terminatorPosition = argv.indexOf("--");
      return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
    };
  }
});

// ../../node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/index.js
var require_supports_color = __commonJS({
  "../../node_modules/.pnpm/supports-color@7.2.0/node_modules/supports-color/index.js"(exports2, module2) {
    "use strict";
    var os = require("os");
    var tty = require("tty");
    var hasFlag = require_has_flag();
    var { env } = process;
    var forceColor;
    if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
      forceColor = 0;
    } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
      forceColor = 1;
    }
    if ("FORCE_COLOR" in env) {
      if (env.FORCE_COLOR === "true") {
        forceColor = 1;
      } else if (env.FORCE_COLOR === "false") {
        forceColor = 0;
      } else {
        forceColor = env.FORCE_COLOR.length === 0 ? 1 : Math.min(parseInt(env.FORCE_COLOR, 10), 3);
      }
    }
    function translateLevel(level) {
      if (level === 0) {
        return false;
      }
      return {
        level,
        hasBasic: true,
        has256: level >= 2,
        has16m: level >= 3
      };
    }
    function supportsColor(haveStream, streamIsTTY) {
      if (forceColor === 0) {
        return 0;
      }
      if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
        return 3;
      }
      if (hasFlag("color=256")) {
        return 2;
      }
      if (haveStream && !streamIsTTY && forceColor === void 0) {
        return 0;
      }
      const min = forceColor || 0;
      if (env.TERM === "dumb") {
        return min;
      }
      if (process.platform === "win32") {
        const osRelease = os.release().split(".");
        if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
          return Number(osRelease[2]) >= 14931 ? 3 : 2;
        }
        return 1;
      }
      if ("CI" in env) {
        if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
          return 1;
        }
        return min;
      }
      if ("TEAMCITY_VERSION" in env) {
        return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
      }
      if (env.COLORTERM === "truecolor") {
        return 3;
      }
      if ("TERM_PROGRAM" in env) {
        const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
        switch (env.TERM_PROGRAM) {
          case "iTerm.app":
            return version >= 3 ? 3 : 2;
          case "Apple_Terminal":
            return 2;
        }
      }
      if (/-256(color)?$/i.test(env.TERM)) {
        return 2;
      }
      if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
        return 1;
      }
      if ("COLORTERM" in env) {
        return 1;
      }
      return min;
    }
    function getSupportLevel(stream) {
      const level = supportsColor(stream, stream && stream.isTTY);
      return translateLevel(level);
    }
    module2.exports = {
      supportsColor: getSupportLevel,
      stdout: translateLevel(supportsColor(true, tty.isatty(1))),
      stderr: translateLevel(supportsColor(true, tty.isatty(2)))
    };
  }
});

// ../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js
var require_node = __commonJS({
  "../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js"(exports2, module2) {
    var tty = require("tty");
    var util = require("util");
    exports2.init = init;
    exports2.log = log;
    exports2.formatArgs = formatArgs;
    exports2.save = save;
    exports2.load = load;
    exports2.useColors = useColors;
    exports2.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports2.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = require_supports_color();
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports2.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports2.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports2.inspectOpts ? Boolean(exports2.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module2.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports2.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports2.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug12) {
      debug12.inspectOpts = {};
      const keys = Object.keys(exports2.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug12.inspectOpts[keys[i]] = exports2.inspectOpts[keys[i]];
      }
    }
    module2.exports = require_common()(exports2);
    var { formatters } = module2.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// ../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js
var require_src = __commonJS({
  "../../node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js"(exports2, module2) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module2.exports = require_browser();
    } else {
      module2.exports = require_node();
    }
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transport.js
var import_component_emitter, import_debug, debug, TransportError, Transport;
var init_transport = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transport.js"() {
    init_esm();
    import_component_emitter = __toESM(require_cjs(), 1);
    init_util();
    init_parseqs();
    import_debug = __toESM(require_src(), 1);
    debug = (0, import_debug.default)("engine.io-client:transport");
    TransportError = class extends Error {
      constructor(reason, description, context) {
        super(reason);
        this.description = description;
        this.context = context;
        this.type = "TransportError";
      }
    };
    Transport = class extends import_component_emitter.Emitter {
      /**
       * Transport abstract constructor.
       *
       * @param {Object} opts - options
       * @protected
       */
      constructor(opts) {
        super();
        this.writable = false;
        installTimerFunctions(this, opts);
        this.opts = opts;
        this.query = opts.query;
        this.socket = opts.socket;
        this.supportsBinary = !opts.forceBase64;
      }
      /**
       * Emits an error.
       *
       * @param {String} reason
       * @param description
       * @param context - the error context
       * @return {Transport} for chaining
       * @protected
       */
      onError(reason, description, context) {
        super.emitReserved("error", new TransportError(reason, description, context));
        return this;
      }
      /**
       * Opens the transport.
       */
      open() {
        this.readyState = "opening";
        this.doOpen();
        return this;
      }
      /**
       * Closes the transport.
       */
      close() {
        if (this.readyState === "opening" || this.readyState === "open") {
          this.doClose();
          this.onClose();
        }
        return this;
      }
      /**
       * Sends multiple packets.
       *
       * @param {Array} packets
       */
      send(packets) {
        if (this.readyState === "open") {
          this.write(packets);
        } else {
          debug("transport is not open, discarding packets");
        }
      }
      /**
       * Called upon open
       *
       * @protected
       */
      onOpen() {
        this.readyState = "open";
        this.writable = true;
        super.emitReserved("open");
      }
      /**
       * Called with data.
       *
       * @param {String} data
       * @protected
       */
      onData(data) {
        const packet = decodePacket(data, this.socket.binaryType);
        this.onPacket(packet);
      }
      /**
       * Called with a decoded packet.
       *
       * @protected
       */
      onPacket(packet) {
        super.emitReserved("packet", packet);
      }
      /**
       * Called upon close.
       *
       * @protected
       */
      onClose(details) {
        this.readyState = "closed";
        super.emitReserved("close", details);
      }
      /**
       * Pauses the transport, in order not to lose packets during an upgrade.
       *
       * @param onPause
       */
      pause(onPause) {
      }
      createUri(schema, query = {}) {
        return schema + "://" + this._hostname() + this._port() + this.opts.path + this._query(query);
      }
      _hostname() {
        const hostname = this.opts.hostname;
        return hostname.indexOf(":") === -1 ? hostname : "[" + hostname + "]";
      }
      _port() {
        if (this.opts.port && (this.opts.secure && Number(this.opts.port) !== 443 || !this.opts.secure && Number(this.opts.port) !== 80)) {
          return ":" + this.opts.port;
        } else {
          return "";
        }
      }
      _query(query) {
        const encodedQuery = encode(query);
        return encodedQuery.length ? "?" + encodedQuery : "";
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling.js
var import_debug2, debug2, Polling;
var init_polling = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling.js"() {
    init_transport();
    init_util();
    init_esm();
    import_debug2 = __toESM(require_src(), 1);
    debug2 = (0, import_debug2.default)("engine.io-client:polling");
    Polling = class extends Transport {
      constructor() {
        super(...arguments);
        this._polling = false;
      }
      get name() {
        return "polling";
      }
      /**
       * Opens the socket (triggers polling). We write a PING message to determine
       * when the transport is open.
       *
       * @protected
       */
      doOpen() {
        this._poll();
      }
      /**
       * Pauses polling.
       *
       * @param {Function} onPause - callback upon buffers are flushed and transport is paused
       * @package
       */
      pause(onPause) {
        this.readyState = "pausing";
        const pause = () => {
          debug2("paused");
          this.readyState = "paused";
          onPause();
        };
        if (this._polling || !this.writable) {
          let total = 0;
          if (this._polling) {
            debug2("we are currently polling - waiting to pause");
            total++;
            this.once("pollComplete", function() {
              debug2("pre-pause polling complete");
              --total || pause();
            });
          }
          if (!this.writable) {
            debug2("we are currently writing - waiting to pause");
            total++;
            this.once("drain", function() {
              debug2("pre-pause writing complete");
              --total || pause();
            });
          }
        } else {
          pause();
        }
      }
      /**
       * Starts polling cycle.
       *
       * @private
       */
      _poll() {
        debug2("polling");
        this._polling = true;
        this.doPoll();
        this.emitReserved("poll");
      }
      /**
       * Overloads onData to detect payloads.
       *
       * @protected
       */
      onData(data) {
        debug2("polling got data %s", data);
        const callback = (packet) => {
          if ("opening" === this.readyState && packet.type === "open") {
            this.onOpen();
          }
          if ("close" === packet.type) {
            this.onClose({ description: "transport closed by the server" });
            return false;
          }
          this.onPacket(packet);
        };
        decodePayload(data, this.socket.binaryType).forEach(callback);
        if ("closed" !== this.readyState) {
          this._polling = false;
          this.emitReserved("pollComplete");
          if ("open" === this.readyState) {
            this._poll();
          } else {
            debug2('ignoring poll - transport state "%s"', this.readyState);
          }
        }
      }
      /**
       * For polling, send a close packet.
       *
       * @protected
       */
      doClose() {
        const close = () => {
          debug2("writing close packet");
          this.write([{ type: "close" }]);
        };
        if ("open" === this.readyState) {
          debug2("transport open - closing");
          close();
        } else {
          debug2("transport not open - deferring close");
          this.once("open", close);
        }
      }
      /**
       * Writes a packets payload.
       *
       * @param {Array} packets - data packets
       * @protected
       */
      write(packets) {
        this.writable = false;
        encodePayload(packets, (data) => {
          this.doWrite(data, () => {
            this.writable = true;
            this.emitReserved("drain");
          });
        });
      }
      /**
       * Generates uri for connection.
       *
       * @private
       */
      uri() {
        const schema = this.opts.secure ? "https" : "http";
        const query = this.query || {};
        if (false !== this.opts.timestampRequests) {
          query[this.opts.timestampParam] = randomString();
        }
        if (!this.supportsBinary && !query.sid) {
          query.b64 = 1;
        }
        return this.createUri(schema, query);
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/has-cors.js
var value, hasCORS;
var init_has_cors = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/has-cors.js"() {
    value = false;
    try {
      value = typeof XMLHttpRequest !== "undefined" && "withCredentials" in new XMLHttpRequest();
    } catch (err) {
    }
    hasCORS = value;
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-xhr.js
function empty() {
}
function unloadHandler() {
  for (let i in Request.requests) {
    if (Request.requests.hasOwnProperty(i)) {
      Request.requests[i].abort();
    }
  }
}
function newRequest(opts) {
  const xdomain = opts.xdomain;
  try {
    if ("undefined" !== typeof XMLHttpRequest && (!xdomain || hasCORS)) {
      return new XMLHttpRequest();
    }
  } catch (e) {
  }
  if (!xdomain) {
    try {
      return new globalThisShim[["Active"].concat("Object").join("X")]("Microsoft.XMLHTTP");
    } catch (e) {
    }
  }
}
var import_component_emitter2, import_debug3, debug3, BaseXHR, Request, hasXHR2;
var init_polling_xhr = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-xhr.js"() {
    init_polling();
    import_component_emitter2 = __toESM(require_cjs(), 1);
    init_util();
    init_globals_node();
    init_has_cors();
    import_debug3 = __toESM(require_src(), 1);
    debug3 = (0, import_debug3.default)("engine.io-client:polling");
    BaseXHR = class extends Polling {
      /**
       * XHR Polling constructor.
       *
       * @param {Object} opts
       * @package
       */
      constructor(opts) {
        super(opts);
        if (typeof location !== "undefined") {
          const isSSL = "https:" === location.protocol;
          let port = location.port;
          if (!port) {
            port = isSSL ? "443" : "80";
          }
          this.xd = typeof location !== "undefined" && opts.hostname !== location.hostname || port !== opts.port;
        }
      }
      /**
       * Sends data.
       *
       * @param {String} data - data to send.
       * @param {Function} fn - called upon flush.
       * @private
       */
      doWrite(data, fn) {
        const req = this.request({
          method: "POST",
          data
        });
        req.on("success", fn);
        req.on("error", (xhrStatus, context) => {
          this.onError("xhr post error", xhrStatus, context);
        });
      }
      /**
       * Starts a poll cycle.
       *
       * @private
       */
      doPoll() {
        debug3("xhr poll");
        const req = this.request();
        req.on("data", this.onData.bind(this));
        req.on("error", (xhrStatus, context) => {
          this.onError("xhr poll error", xhrStatus, context);
        });
        this.pollXhr = req;
      }
    };
    Request = class _Request extends import_component_emitter2.Emitter {
      /**
       * Request constructor
       *
       * @param {Object} options
       * @package
       */
      constructor(createRequest, uri, opts) {
        super();
        this.createRequest = createRequest;
        installTimerFunctions(this, opts);
        this._opts = opts;
        this._method = opts.method || "GET";
        this._uri = uri;
        this._data = void 0 !== opts.data ? opts.data : null;
        this._create();
      }
      /**
       * Creates the XHR object and sends the request.
       *
       * @private
       */
      _create() {
        var _a;
        const opts = pick(this._opts, "agent", "pfx", "key", "passphrase", "cert", "ca", "ciphers", "rejectUnauthorized", "autoUnref");
        opts.xdomain = !!this._opts.xd;
        const xhr = this._xhr = this.createRequest(opts);
        try {
          debug3("xhr open %s: %s", this._method, this._uri);
          xhr.open(this._method, this._uri, true);
          try {
            if (this._opts.extraHeaders) {
              xhr.setDisableHeaderCheck && xhr.setDisableHeaderCheck(true);
              for (let i in this._opts.extraHeaders) {
                if (this._opts.extraHeaders.hasOwnProperty(i)) {
                  xhr.setRequestHeader(i, this._opts.extraHeaders[i]);
                }
              }
            }
          } catch (e) {
          }
          if ("POST" === this._method) {
            try {
              xhr.setRequestHeader("Content-type", "text/plain;charset=UTF-8");
            } catch (e) {
            }
          }
          try {
            xhr.setRequestHeader("Accept", "*/*");
          } catch (e) {
          }
          (_a = this._opts.cookieJar) === null || _a === void 0 ? void 0 : _a.addCookies(xhr);
          if ("withCredentials" in xhr) {
            xhr.withCredentials = this._opts.withCredentials;
          }
          if (this._opts.requestTimeout) {
            xhr.timeout = this._opts.requestTimeout;
          }
          xhr.onreadystatechange = () => {
            var _a2;
            if (xhr.readyState === 3) {
              (_a2 = this._opts.cookieJar) === null || _a2 === void 0 ? void 0 : _a2.parseCookies(
                // @ts-ignore
                xhr.getResponseHeader("set-cookie")
              );
            }
            if (4 !== xhr.readyState)
              return;
            if (200 === xhr.status || 1223 === xhr.status) {
              this._onLoad();
            } else {
              this.setTimeoutFn(() => {
                this._onError(typeof xhr.status === "number" ? xhr.status : 0);
              }, 0);
            }
          };
          debug3("xhr data %s", this._data);
          xhr.send(this._data);
        } catch (e) {
          this.setTimeoutFn(() => {
            this._onError(e);
          }, 0);
          return;
        }
        if (typeof document !== "undefined") {
          this._index = _Request.requestsCount++;
          _Request.requests[this._index] = this;
        }
      }
      /**
       * Called upon error.
       *
       * @private
       */
      _onError(err) {
        this.emitReserved("error", err, this._xhr);
        this._cleanup(true);
      }
      /**
       * Cleans up house.
       *
       * @private
       */
      _cleanup(fromError) {
        if ("undefined" === typeof this._xhr || null === this._xhr) {
          return;
        }
        this._xhr.onreadystatechange = empty;
        if (fromError) {
          try {
            this._xhr.abort();
          } catch (e) {
          }
        }
        if (typeof document !== "undefined") {
          delete _Request.requests[this._index];
        }
        this._xhr = null;
      }
      /**
       * Called upon load.
       *
       * @private
       */
      _onLoad() {
        const data = this._xhr.responseText;
        if (data !== null) {
          this.emitReserved("data", data);
          this.emitReserved("success");
          this._cleanup();
        }
      }
      /**
       * Aborts the request.
       *
       * @package
       */
      abort() {
        this._cleanup();
      }
    };
    Request.requestsCount = 0;
    Request.requests = {};
    if (typeof document !== "undefined") {
      if (typeof attachEvent === "function") {
        attachEvent("onunload", unloadHandler);
      } else if (typeof addEventListener === "function") {
        const terminationEvent = "onpagehide" in globalThisShim ? "pagehide" : "unload";
        addEventListener(terminationEvent, unloadHandler, false);
      }
    }
    hasXHR2 = function() {
      const xhr = newRequest({
        xdomain: false
      });
      return xhr && xhr.responseType !== null;
    }();
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-xhr.node.js
var XMLHttpRequestModule, XMLHttpRequest2, XHR;
var init_polling_xhr_node = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-xhr.node.js"() {
    XMLHttpRequestModule = __toESM(require_XMLHttpRequest(), 1);
    init_polling_xhr();
    XMLHttpRequest2 = XMLHttpRequestModule.default || XMLHttpRequestModule;
    XHR = class extends BaseXHR {
      request(opts = {}) {
        var _a;
        Object.assign(opts, { xd: this.xd, cookieJar: (_a = this.socket) === null || _a === void 0 ? void 0 : _a._cookieJar }, this.opts);
        return new Request((opts2) => new XMLHttpRequest2(opts2), this.uri(), opts);
      }
    };
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength2) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength2);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength2) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer2(data) {
      toBuffer2.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer2.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer: toBuffer2,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value2 = params[key];
            if (value2.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value2 = value2[0];
            if (key === "client_max_window_bits") {
              if (value2 !== true) {
                const num = +value2;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value2}`
                  );
                }
                value2 = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value2;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
              value2 = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value2 !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value2;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value2) {
      return hasBlob && typeof value2 === "object" && typeof value2.arrayBuffer === "function" && typeof value2.type === "string" && typeof value2.stream === "function" && (value2[Symbol.toStringTag] === "Blob" || value2[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer: toBuffer2 } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer2(data);
          byteLength2 = data.length;
          readOnly = toBuffer2.readOnly;
        }
        if (byteLength2 > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength2,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer2(data);
          byteLength2 = data.length;
          readOnly = toBuffer2.readOnly;
        }
        if (byteLength2 > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength2,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer2(data);
          byteLength2 = data.length;
          readOnly = toBuffer2.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength2 >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength2,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer2(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary2) {
            const event = new MessageEvent("message", {
              data: isBinary2 ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse4(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value2 = header.slice(start, end);
            if (mustUnescape) {
              value2 = value2.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value2);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse: parse4 };
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash: createHash3 } = require("crypto");
    var { Duplex, Readable: Readable2 } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener: addEventListener2, removeEventListener: removeEventListener2 }
    } = require_event_target();
    var { format, parse: parse4 } = require_extension();
    var { toBuffer: toBuffer2 } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener2;
    WebSocket2.prototype.removeEventListener = removeEventListener2;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol4 of protocols) {
          if (typeof protocol4 !== "string" || !subprotocolRegex.test(protocol4) || protocolSet.has(protocol4)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol4);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts2 = opts.path.split(":");
        opts.socketPath = parts2[0];
        opts.path = parts2[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value2] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value2;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location2 = res.headers.location;
        const statusCode = res.statusCode;
        if (location2 && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location2, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location2}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse4(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer2(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary2) {
      this[kWebSocket].emit("message", data, isBinary2);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary2) {
        const data = !isBinary2 && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open3() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open3() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse4(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol5 = header.slice(start, end);
          if (protocols.has(protocol5)) {
            throw new SyntaxError(`The "${protocol5}" subprotocol is duplicated`);
          }
          protocols.add(protocol5);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol4 = header.slice(start, i);
      if (protocols.has(protocol4)) {
        throw new SyntaxError(`The "${protocol4}" subprotocol is duplicated`);
      }
      protocols.add(protocol4);
      return protocols;
    }
    module2.exports = { parse: parse4 };
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http = require("http");
    var { Duplex } = require("stream");
    var { createHash: createHash3 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol4 = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol4) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol4}`);
            ws._protocol = protocol4;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value2 = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value2}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// ../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/wrapper.mjs
var import_stream, import_extension, import_permessage_deflate, import_receiver, import_sender, import_subprotocol, import_websocket, import_websocket_server;
var init_wrapper = __esm({
  "../../node_modules/.pnpm/ws@8.21.1/node_modules/ws/wrapper.mjs"() {
    import_stream = __toESM(require_stream(), 1);
    import_extension = __toESM(require_extension(), 1);
    import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
    import_receiver = __toESM(require_receiver(), 1);
    import_sender = __toESM(require_sender(), 1);
    import_subprotocol = __toESM(require_subprotocol(), 1);
    import_websocket = __toESM(require_websocket(), 1);
    import_websocket_server = __toESM(require_websocket_server(), 1);
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/websocket.js
var import_debug4, debug4, isReactNative, BaseWS, WebSocketCtor;
var init_websocket = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/websocket.js"() {
    init_transport();
    init_util();
    init_esm();
    init_globals_node();
    import_debug4 = __toESM(require_src(), 1);
    debug4 = (0, import_debug4.default)("engine.io-client:websocket");
    isReactNative = typeof navigator !== "undefined" && typeof navigator.product === "string" && navigator.product.toLowerCase() === "reactnative";
    BaseWS = class extends Transport {
      get name() {
        return "websocket";
      }
      doOpen() {
        const uri = this.uri();
        const protocols = this.opts.protocols;
        const opts = isReactNative ? {} : pick(this.opts, "agent", "perMessageDeflate", "pfx", "key", "passphrase", "cert", "ca", "ciphers", "rejectUnauthorized", "localAddress", "protocolVersion", "origin", "maxPayload", "family", "checkServerIdentity");
        if (this.opts.extraHeaders) {
          opts.headers = this.opts.extraHeaders;
        }
        try {
          this.ws = this.createSocket(uri, protocols, opts);
        } catch (err) {
          return this.emitReserved("error", err);
        }
        this.ws.binaryType = this.socket.binaryType;
        this.addEventListeners();
      }
      /**
       * Adds event listeners to the socket
       *
       * @private
       */
      addEventListeners() {
        this.ws.onopen = () => {
          if (this.opts.autoUnref) {
            this.ws._socket.unref();
          }
          this.onOpen();
        };
        this.ws.onclose = (closeEvent) => this.onClose({
          description: "websocket connection closed",
          context: closeEvent
        });
        this.ws.onmessage = (ev) => this.onData(ev.data);
        this.ws.onerror = (e) => this.onError("websocket error", e);
      }
      write(packets) {
        this.writable = false;
        for (let i = 0; i < packets.length; i++) {
          const packet = packets[i];
          const lastPacket = i === packets.length - 1;
          encodePacket(packet, this.supportsBinary, (data) => {
            try {
              this.doWrite(packet, data);
            } catch (e) {
              debug4("websocket closed before onclose event");
            }
            if (lastPacket) {
              nextTick(() => {
                this.writable = true;
                this.emitReserved("drain");
              }, this.setTimeoutFn);
            }
          });
        }
      }
      doClose() {
        if (typeof this.ws !== "undefined") {
          this.ws.onerror = () => {
          };
          this.ws.close();
          this.ws = null;
        }
      }
      /**
       * Generates uri for connection.
       *
       * @private
       */
      uri() {
        const schema = this.opts.secure ? "wss" : "ws";
        const query = this.query || {};
        if (this.opts.timestampRequests) {
          query[this.opts.timestampParam] = randomString();
        }
        if (!this.supportsBinary) {
          query.b64 = 1;
        }
        return this.createUri(schema, query);
      }
    };
    WebSocketCtor = globalThisShim.WebSocket || globalThisShim.MozWebSocket;
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/websocket.node.js
var WS;
var init_websocket_node = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/websocket.node.js"() {
    init_wrapper();
    init_websocket();
    WS = class extends BaseWS {
      createSocket(uri, protocols, opts) {
        var _a;
        if ((_a = this.socket) === null || _a === void 0 ? void 0 : _a._cookieJar) {
          opts.headers = opts.headers || {};
          opts.headers.cookie = typeof opts.headers.cookie === "string" ? [opts.headers.cookie] : opts.headers.cookie || [];
          for (const [name, cookie] of this.socket._cookieJar.cookies) {
            opts.headers.cookie.push(`${name}=${cookie.value}`);
          }
        }
        return new import_websocket.default(uri, protocols, opts);
      }
      doWrite(packet, data) {
        const opts = {};
        if (packet.options) {
          opts.compress = packet.options.compress;
        }
        if (this.opts.perMessageDeflate) {
          const len = (
            // @ts-ignore
            "string" === typeof data ? Buffer.byteLength(data) : data.length
          );
          if (len < this.opts.perMessageDeflate.threshold) {
            opts.compress = false;
          }
        }
        this.ws.send(data, opts);
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/webtransport.js
var import_debug5, debug5, WT;
var init_webtransport = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/webtransport.js"() {
    init_transport();
    init_globals_node();
    init_esm();
    import_debug5 = __toESM(require_src(), 1);
    debug5 = (0, import_debug5.default)("engine.io-client:webtransport");
    WT = class extends Transport {
      get name() {
        return "webtransport";
      }
      doOpen() {
        try {
          this._transport = new WebTransport(this.createUri("https"), this.opts.transportOptions[this.name]);
        } catch (err) {
          return this.emitReserved("error", err);
        }
        this._transport.closed.then(() => {
          debug5("transport closed gracefully");
          this.onClose();
        }).catch((err) => {
          debug5("transport closed due to %s", err);
          this.onError("webtransport error", err);
        });
        this._transport.ready.then(() => {
          this._transport.createBidirectionalStream().then((stream) => {
            const decoderStream = createPacketDecoderStream(Number.MAX_SAFE_INTEGER, this.socket.binaryType);
            const reader = stream.readable.pipeThrough(decoderStream).getReader();
            const encoderStream = createPacketEncoderStream();
            encoderStream.readable.pipeTo(stream.writable);
            this._writer = encoderStream.writable.getWriter();
            const read = () => {
              reader.read().then(({ done, value: value2 }) => {
                if (done) {
                  debug5("session is closed");
                  return;
                }
                debug5("received chunk: %o", value2);
                this.onPacket(value2);
                read();
              }).catch((err) => {
                debug5("an error occurred while reading: %s", err);
              });
            };
            read();
            const packet = { type: "open" };
            if (this.query.sid) {
              packet.data = `{"sid":"${this.query.sid}"}`;
            }
            this._writer.write(packet).then(() => this.onOpen());
          });
        });
      }
      write(packets) {
        this.writable = false;
        for (let i = 0; i < packets.length; i++) {
          const packet = packets[i];
          const lastPacket = i === packets.length - 1;
          this._writer.write(packet).then(() => {
            if (lastPacket) {
              nextTick(() => {
                this.writable = true;
                this.emitReserved("drain");
              }, this.setTimeoutFn);
            }
          });
        }
      }
      doClose() {
        var _a;
        (_a = this._transport) === null || _a === void 0 ? void 0 : _a.close();
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/index.js
var transports;
var init_transports = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/index.js"() {
    init_polling_xhr_node();
    init_websocket_node();
    init_webtransport();
    transports = {
      websocket: WS,
      webtransport: WT,
      polling: XHR
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/parseuri.js
function parse3(str) {
  if (str.length > 8e3) {
    throw "URI too long";
  }
  const src = str, b = str.indexOf("["), e = str.indexOf("]");
  if (b != -1 && e != -1) {
    str = str.substring(0, b) + str.substring(b, e).replace(/:/g, ";") + str.substring(e, str.length);
  }
  let m = re.exec(str || ""), uri = {}, i = 14;
  while (i--) {
    uri[parts[i]] = m[i] || "";
  }
  if (b != -1 && e != -1) {
    uri.source = src;
    uri.host = uri.host.substring(1, uri.host.length - 1).replace(/;/g, ":");
    uri.authority = uri.authority.replace("[", "").replace("]", "").replace(/;/g, ":");
    uri.ipv6uri = true;
  }
  uri.pathNames = pathNames(uri, uri["path"]);
  uri.queryKey = queryKey(uri, uri["query"]);
  return uri;
}
function pathNames(obj, path) {
  const regx = /\/{2,9}/g, names = path.replace(regx, "/").split("/");
  if (path.slice(0, 1) == "/" || path.length === 0) {
    names.splice(0, 1);
  }
  if (path.slice(-1) == "/") {
    names.splice(names.length - 1, 1);
  }
  return names;
}
function queryKey(uri, query) {
  const data = {};
  query.replace(/(?:^|&)([^&=]*)=?([^&]*)/g, function($0, $1, $2) {
    if ($1) {
      data[$1] = $2;
    }
  });
  return data;
}
var re, parts;
var init_parseuri = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/contrib/parseuri.js"() {
    re = /^(?:(?![^:@\/?#]+:[^:@\/]*@)(http|https|ws|wss):\/\/)?((?:(([^:@\/?#]*)(?::([^:@\/?#]*))?)?@)?((?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}|[^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;
    parts = [
      "source",
      "protocol",
      "authority",
      "userInfo",
      "user",
      "password",
      "host",
      "port",
      "relative",
      "path",
      "directory",
      "file",
      "query",
      "anchor"
    ];
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/socket.js
var import_component_emitter3, import_debug6, debug6, withEventListeners, OFFLINE_EVENT_LISTENERS, SocketWithoutUpgrade, SocketWithUpgrade, Socket;
var init_socket = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/socket.js"() {
    init_transports();
    init_util();
    init_parseqs();
    init_parseuri();
    import_component_emitter3 = __toESM(require_cjs(), 1);
    init_esm();
    init_globals_node();
    import_debug6 = __toESM(require_src(), 1);
    debug6 = (0, import_debug6.default)("engine.io-client:socket");
    withEventListeners = typeof addEventListener === "function" && typeof removeEventListener === "function";
    OFFLINE_EVENT_LISTENERS = [];
    if (withEventListeners) {
      addEventListener("offline", () => {
        debug6("closing %d connection(s) because the network was lost", OFFLINE_EVENT_LISTENERS.length);
        OFFLINE_EVENT_LISTENERS.forEach((listener) => listener());
      }, false);
    }
    SocketWithoutUpgrade = class _SocketWithoutUpgrade extends import_component_emitter3.Emitter {
      /**
       * Socket constructor.
       *
       * @param {String|Object} uri - uri or options
       * @param {Object} opts - options
       */
      constructor(uri, opts) {
        super();
        this.binaryType = defaultBinaryType;
        this.writeBuffer = [];
        this._prevBufferLen = 0;
        this._pingInterval = -1;
        this._pingTimeout = -1;
        this._maxPayload = -1;
        this._pingTimeoutTime = Infinity;
        if (uri && "object" === typeof uri) {
          opts = uri;
          uri = null;
        }
        if (uri) {
          const parsedUri = parse3(uri);
          opts.hostname = parsedUri.host;
          opts.secure = parsedUri.protocol === "https" || parsedUri.protocol === "wss";
          opts.port = parsedUri.port;
          if (parsedUri.query)
            opts.query = parsedUri.query;
        } else if (opts.host) {
          opts.hostname = parse3(opts.host).host;
        }
        installTimerFunctions(this, opts);
        this.secure = null != opts.secure ? opts.secure : typeof location !== "undefined" && "https:" === location.protocol;
        if (opts.hostname && !opts.port) {
          opts.port = this.secure ? "443" : "80";
        }
        this.hostname = opts.hostname || (typeof location !== "undefined" ? location.hostname : "localhost");
        this.port = opts.port || (typeof location !== "undefined" && location.port ? location.port : this.secure ? "443" : "80");
        this.transports = [];
        this._transportsByName = {};
        opts.transports.forEach((t) => {
          const transportName = t.prototype.name;
          this.transports.push(transportName);
          this._transportsByName[transportName] = t;
        });
        this.opts = Object.assign({
          path: "/engine.io",
          agent: false,
          withCredentials: false,
          upgrade: true,
          timestampParam: "t",
          rememberUpgrade: false,
          addTrailingSlash: true,
          rejectUnauthorized: true,
          perMessageDeflate: {
            threshold: 1024
          },
          transportOptions: {},
          closeOnBeforeunload: false
        }, opts);
        this.opts.path = this.opts.path.replace(/\/$/, "") + (this.opts.addTrailingSlash ? "/" : "");
        if (typeof this.opts.query === "string") {
          this.opts.query = decode(this.opts.query);
        }
        if (withEventListeners) {
          if (this.opts.closeOnBeforeunload) {
            this._beforeunloadEventListener = () => {
              if (this.transport) {
                this.transport.removeAllListeners();
                this.transport.close();
              }
            };
            addEventListener("beforeunload", this._beforeunloadEventListener, false);
          }
          if (this.hostname !== "localhost") {
            debug6("adding listener for the 'offline' event");
            this._offlineEventListener = () => {
              this._onClose("transport close", {
                description: "network connection lost"
              });
            };
            OFFLINE_EVENT_LISTENERS.push(this._offlineEventListener);
          }
        }
        if (this.opts.withCredentials) {
          this._cookieJar = createCookieJar();
        }
        this._open();
      }
      /**
       * Creates transport of the given type.
       *
       * @param {String} name - transport name
       * @return {Transport}
       * @private
       */
      createTransport(name) {
        debug6('creating transport "%s"', name);
        const query = Object.assign({}, this.opts.query);
        query.EIO = protocol;
        query.transport = name;
        if (this.id)
          query.sid = this.id;
        const opts = Object.assign({}, this.opts, {
          query,
          socket: this,
          hostname: this.hostname,
          secure: this.secure,
          port: this.port
        }, this.opts.transportOptions[name]);
        debug6("options: %j", opts);
        return new this._transportsByName[name](opts);
      }
      /**
       * Initializes transport to use and starts probe.
       *
       * @private
       */
      _open() {
        if (this.transports.length === 0) {
          this.setTimeoutFn(() => {
            this.emitReserved("error", "No transports available");
          }, 0);
          return;
        }
        const transportName = this.opts.rememberUpgrade && _SocketWithoutUpgrade.priorWebsocketSuccess && this.transports.indexOf("websocket") !== -1 ? "websocket" : this.transports[0];
        this.readyState = "opening";
        const transport = this.createTransport(transportName);
        transport.open();
        this.setTransport(transport);
      }
      /**
       * Sets the current transport. Disables the existing one (if any).
       *
       * @private
       */
      setTransport(transport) {
        debug6("setting transport %s", transport.name);
        if (this.transport) {
          debug6("clearing existing transport %s", this.transport.name);
          this.transport.removeAllListeners();
        }
        this.transport = transport;
        transport.on("drain", this._onDrain.bind(this)).on("packet", this._onPacket.bind(this)).on("error", this._onError.bind(this)).on("close", (reason) => this._onClose("transport close", reason));
      }
      /**
       * Called when connection is deemed open.
       *
       * @private
       */
      onOpen() {
        debug6("socket open");
        this.readyState = "open";
        _SocketWithoutUpgrade.priorWebsocketSuccess = "websocket" === this.transport.name;
        this.emitReserved("open");
        this.flush();
      }
      /**
       * Handles a packet.
       *
       * @private
       */
      _onPacket(packet) {
        if ("opening" === this.readyState || "open" === this.readyState || "closing" === this.readyState) {
          debug6('socket receive: type "%s", data "%s"', packet.type, packet.data);
          this.emitReserved("packet", packet);
          this.emitReserved("heartbeat");
          switch (packet.type) {
            case "open":
              this.onHandshake(JSON.parse(packet.data));
              break;
            case "ping":
              this._sendPacket("pong");
              this.emitReserved("ping");
              this.emitReserved("pong");
              this._resetPingTimeout();
              break;
            case "error":
              const err = new Error("server error");
              err.code = packet.data;
              this._onError(err);
              break;
            case "message":
              this.emitReserved("data", packet.data);
              this.emitReserved("message", packet.data);
              break;
          }
        } else {
          debug6('packet received with socket readyState "%s"', this.readyState);
        }
      }
      /**
       * Called upon handshake completion.
       *
       * @param {Object} data - handshake obj
       * @private
       */
      onHandshake(data) {
        this.emitReserved("handshake", data);
        this.id = data.sid;
        this.transport.query.sid = data.sid;
        this._pingInterval = data.pingInterval;
        this._pingTimeout = data.pingTimeout;
        this._maxPayload = data.maxPayload;
        this.onOpen();
        if ("closed" === this.readyState)
          return;
        this._resetPingTimeout();
      }
      /**
       * Sets and resets ping timeout timer based on server pings.
       *
       * @private
       */
      _resetPingTimeout() {
        this.clearTimeoutFn(this._pingTimeoutTimer);
        const delay = this._pingInterval + this._pingTimeout;
        this._pingTimeoutTime = Date.now() + delay;
        this._pingTimeoutTimer = this.setTimeoutFn(() => {
          this._onClose("ping timeout");
        }, delay);
        if (this.opts.autoUnref) {
          this._pingTimeoutTimer.unref();
        }
      }
      /**
       * Called on `drain` event
       *
       * @private
       */
      _onDrain() {
        this.writeBuffer.splice(0, this._prevBufferLen);
        this._prevBufferLen = 0;
        if (0 === this.writeBuffer.length) {
          this.emitReserved("drain");
        } else {
          this.flush();
        }
      }
      /**
       * Flush write buffers.
       *
       * @private
       */
      flush() {
        if ("closed" !== this.readyState && this.transport.writable && !this.upgrading && this.writeBuffer.length) {
          const packets = this._getWritablePackets();
          debug6("flushing %d packets in socket", packets.length);
          this.transport.send(packets);
          this._prevBufferLen = packets.length;
          this.emitReserved("flush");
        }
      }
      /**
       * Ensure the encoded size of the writeBuffer is below the maxPayload value sent by the server (only for HTTP
       * long-polling)
       *
       * @private
       */
      _getWritablePackets() {
        const shouldCheckPayloadSize = this._maxPayload && this.transport.name === "polling" && this.writeBuffer.length > 1;
        if (!shouldCheckPayloadSize) {
          return this.writeBuffer;
        }
        let payloadSize = 1;
        for (let i = 0; i < this.writeBuffer.length; i++) {
          const data = this.writeBuffer[i].data;
          if (data) {
            payloadSize += byteLength(data);
          }
          if (i > 0 && payloadSize > this._maxPayload) {
            debug6("only send %d out of %d packets", i, this.writeBuffer.length);
            return this.writeBuffer.slice(0, i);
          }
          payloadSize += 2;
        }
        debug6("payload size is %d (max: %d)", payloadSize, this._maxPayload);
        return this.writeBuffer;
      }
      /**
       * Checks whether the heartbeat timer has expired but the socket has not yet been notified.
       *
       * Note: this method is private for now because it does not really fit the WebSocket API, but if we put it in the
       * `write()` method then the message would not be buffered by the Socket.IO client.
       *
       * @return {boolean}
       * @private
       */
      /* private */
      _hasPingExpired() {
        if (!this._pingTimeoutTime)
          return true;
        const hasExpired = Date.now() > this._pingTimeoutTime;
        if (hasExpired) {
          debug6("throttled timer detected, scheduling connection close");
          this._pingTimeoutTime = 0;
          nextTick(() => {
            this._onClose("ping timeout");
          }, this.setTimeoutFn);
        }
        return hasExpired;
      }
      /**
       * Sends a message.
       *
       * @param {String} msg - message.
       * @param {Object} options.
       * @param {Function} fn - callback function.
       * @return {Socket} for chaining.
       */
      write(msg, options, fn) {
        this._sendPacket("message", msg, options, fn);
        return this;
      }
      /**
       * Sends a message. Alias of {@link Socket#write}.
       *
       * @param {String} msg - message.
       * @param {Object} options.
       * @param {Function} fn - callback function.
       * @return {Socket} for chaining.
       */
      send(msg, options, fn) {
        this._sendPacket("message", msg, options, fn);
        return this;
      }
      /**
       * Sends a packet.
       *
       * @param {String} type - packet type.
       * @param {String} data.
       * @param {Object} options.
       * @param {Function} fn - callback function.
       * @private
       */
      _sendPacket(type, data, options, fn) {
        if ("function" === typeof data) {
          fn = data;
          data = void 0;
        }
        if ("function" === typeof options) {
          fn = options;
          options = null;
        }
        if ("closing" === this.readyState || "closed" === this.readyState) {
          return;
        }
        options = options || {};
        options.compress = false !== options.compress;
        const packet = {
          type,
          data,
          options
        };
        this.emitReserved("packetCreate", packet);
        this.writeBuffer.push(packet);
        if (fn)
          this.once("flush", fn);
        this.flush();
      }
      /**
       * Closes the connection.
       */
      close() {
        const close = () => {
          this._onClose("forced close");
          debug6("socket closing - telling transport to close");
          this.transport.close();
        };
        const cleanupAndClose = () => {
          this.off("upgrade", cleanupAndClose);
          this.off("upgradeError", cleanupAndClose);
          close();
        };
        const waitForUpgrade = () => {
          this.once("upgrade", cleanupAndClose);
          this.once("upgradeError", cleanupAndClose);
        };
        if ("opening" === this.readyState || "open" === this.readyState) {
          this.readyState = "closing";
          if (this.writeBuffer.length) {
            this.once("drain", () => {
              if (this.upgrading) {
                waitForUpgrade();
              } else {
                close();
              }
            });
          } else if (this.upgrading) {
            waitForUpgrade();
          } else {
            close();
          }
        }
        return this;
      }
      /**
       * Called upon transport error
       *
       * @private
       */
      _onError(err) {
        debug6("socket error %j", err);
        _SocketWithoutUpgrade.priorWebsocketSuccess = false;
        if (this.opts.tryAllTransports && this.transports.length > 1 && this.readyState === "opening") {
          debug6("trying next transport");
          this.transports.shift();
          return this._open();
        }
        this.emitReserved("error", err);
        this._onClose("transport error", err);
      }
      /**
       * Called upon transport close.
       *
       * @private
       */
      _onClose(reason, description) {
        if ("opening" === this.readyState || "open" === this.readyState || "closing" === this.readyState) {
          debug6('socket close with reason: "%s"', reason);
          this.clearTimeoutFn(this._pingTimeoutTimer);
          this.transport.removeAllListeners("close");
          this.transport.close();
          this.transport.removeAllListeners();
          if (withEventListeners) {
            if (this._beforeunloadEventListener) {
              removeEventListener("beforeunload", this._beforeunloadEventListener, false);
            }
            if (this._offlineEventListener) {
              const i = OFFLINE_EVENT_LISTENERS.indexOf(this._offlineEventListener);
              if (i !== -1) {
                debug6("removing listener for the 'offline' event");
                OFFLINE_EVENT_LISTENERS.splice(i, 1);
              }
            }
          }
          this.readyState = "closed";
          this.id = null;
          this.emitReserved("close", reason, description);
          this.writeBuffer = [];
          this._prevBufferLen = 0;
        }
      }
    };
    SocketWithoutUpgrade.protocol = protocol;
    SocketWithUpgrade = class extends SocketWithoutUpgrade {
      constructor() {
        super(...arguments);
        this._upgrades = [];
      }
      onOpen() {
        super.onOpen();
        if ("open" === this.readyState && this.opts.upgrade) {
          debug6("starting upgrade probes");
          for (let i = 0; i < this._upgrades.length; i++) {
            this._probe(this._upgrades[i]);
          }
        }
      }
      /**
       * Probes a transport.
       *
       * @param {String} name - transport name
       * @private
       */
      _probe(name) {
        debug6('probing transport "%s"', name);
        let transport = this.createTransport(name);
        let failed = false;
        SocketWithoutUpgrade.priorWebsocketSuccess = false;
        const onTransportOpen = () => {
          if (failed)
            return;
          debug6('probe transport "%s" opened', name);
          transport.send([{ type: "ping", data: "probe" }]);
          transport.once("packet", (msg) => {
            if (failed)
              return;
            if ("pong" === msg.type && "probe" === msg.data) {
              debug6('probe transport "%s" pong', name);
              this.upgrading = true;
              this.emitReserved("upgrading", transport);
              if (!transport)
                return;
              SocketWithoutUpgrade.priorWebsocketSuccess = "websocket" === transport.name;
              debug6('pausing current transport "%s"', this.transport.name);
              this.transport.pause(() => {
                if (failed)
                  return;
                if ("closed" === this.readyState)
                  return;
                debug6("changing transport and sending upgrade packet");
                cleanup();
                this.setTransport(transport);
                transport.send([{ type: "upgrade" }]);
                this.emitReserved("upgrade", transport);
                transport = null;
                this.upgrading = false;
                this.flush();
              });
            } else {
              debug6('probe transport "%s" failed', name);
              const err = new Error("probe error");
              err.transport = transport.name;
              this.emitReserved("upgradeError", err);
            }
          });
        };
        function freezeTransport() {
          if (failed)
            return;
          failed = true;
          cleanup();
          transport.close();
          transport = null;
        }
        const onerror = (err) => {
          const error = new Error("probe error: " + err);
          error.transport = transport.name;
          freezeTransport();
          debug6('probe transport "%s" failed because of error: %s', name, err);
          this.emitReserved("upgradeError", error);
        };
        function onTransportClose() {
          onerror("transport closed");
        }
        function onclose() {
          onerror("socket closed");
        }
        function onupgrade(to) {
          if (transport && to.name !== transport.name) {
            debug6('"%s" works - aborting "%s"', to.name, transport.name);
            freezeTransport();
          }
        }
        const cleanup = () => {
          transport.removeListener("open", onTransportOpen);
          transport.removeListener("error", onerror);
          transport.removeListener("close", onTransportClose);
          this.off("close", onclose);
          this.off("upgrading", onupgrade);
        };
        transport.once("open", onTransportOpen);
        transport.once("error", onerror);
        transport.once("close", onTransportClose);
        this.once("close", onclose);
        this.once("upgrading", onupgrade);
        if (this._upgrades.indexOf("webtransport") !== -1 && name !== "webtransport") {
          this.setTimeoutFn(() => {
            if (!failed) {
              transport.open();
            }
          }, 200);
        } else {
          transport.open();
        }
      }
      onHandshake(data) {
        this._upgrades = this._filterUpgrades(data.upgrades);
        super.onHandshake(data);
      }
      /**
       * Filters upgrades, returning only those matching client transports.
       *
       * @param {Array} upgrades - server upgrades
       * @private
       */
      _filterUpgrades(upgrades) {
        const filteredUpgrades = [];
        for (let i = 0; i < upgrades.length; i++) {
          if (~this.transports.indexOf(upgrades[i]))
            filteredUpgrades.push(upgrades[i]);
        }
        return filteredUpgrades;
      }
    };
    Socket = class extends SocketWithUpgrade {
      constructor(uri, opts = {}) {
        const isOptionsOnly = typeof uri === "object";
        const o = isOptionsOnly ? { ...uri } : { ...opts };
        if (!o.transports || o.transports && typeof o.transports[0] === "string") {
          o.transports = (o.transports || ["polling", "websocket", "webtransport"]).map((transportName) => transports[transportName]).filter((t) => !!t);
        }
        super(isOptionsOnly ? o : uri, o);
      }
    };
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-fetch.js
var init_polling_fetch = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/transports/polling-fetch.js"() {
    init_polling();
  }
});

// ../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/index.js
var protocol2;
var init_esm_debug = __esm({
  "../../node_modules/.pnpm/engine.io-client@6.6.6/node_modules/engine.io-client/build/esm-debug/index.js"() {
    init_socket();
    init_socket();
    init_transport();
    init_transports();
    init_util();
    init_parseuri();
    init_globals_node();
    init_polling_fetch();
    init_polling_xhr_node();
    init_polling_xhr();
    init_websocket_node();
    init_websocket();
    init_webtransport();
    protocol2 = Socket.protocol;
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/url.js
function url(uri, path = "", loc) {
  let obj = uri;
  loc = loc || typeof location !== "undefined" && location;
  if (null == uri)
    uri = loc.protocol + "//" + loc.host;
  if (typeof uri === "string") {
    if ("/" === uri.charAt(0)) {
      if ("/" === uri.charAt(1)) {
        uri = loc.protocol + uri;
      } else {
        uri = loc.host + uri;
      }
    }
    if (!/^(https?|wss?):\/\//.test(uri)) {
      debug7("protocol-less url %s", uri);
      if ("undefined" !== typeof loc) {
        uri = loc.protocol + "//" + uri;
      } else {
        uri = "https://" + uri;
      }
    }
    debug7("parse %s", uri);
    obj = parse3(uri);
  }
  if (!obj.port) {
    if (/^(http|ws)$/.test(obj.protocol)) {
      obj.port = "80";
    } else if (/^(http|ws)s$/.test(obj.protocol)) {
      obj.port = "443";
    }
  }
  obj.path = obj.path || "/";
  const ipv6 = obj.host.indexOf(":") !== -1;
  const host = ipv6 ? "[" + obj.host + "]" : obj.host;
  obj.id = obj.protocol + "://" + host + ":" + obj.port + path;
  obj.href = obj.protocol + "://" + host + (loc && loc.port === obj.port ? "" : ":" + obj.port);
  return obj;
}
var import_debug7, debug7;
var init_url = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/url.js"() {
    init_esm_debug();
    import_debug7 = __toESM(require_src(), 1);
    debug7 = (0, import_debug7.default)("socket.io-client:url");
  }
});

// ../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/is-binary.js
function isBinary(obj) {
  return withNativeArrayBuffer && (obj instanceof ArrayBuffer || isView(obj)) || withNativeBlob && obj instanceof Blob || withNativeFile && obj instanceof File;
}
function hasBinary(obj, toJSON) {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  if (Array.isArray(obj)) {
    for (let i = 0, l = obj.length; i < l; i++) {
      if (hasBinary(obj[i])) {
        return true;
      }
    }
    return false;
  }
  if (isBinary(obj)) {
    return true;
  }
  if (obj.toJSON && typeof obj.toJSON === "function" && arguments.length === 1) {
    return hasBinary(obj.toJSON(), true);
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && hasBinary(obj[key])) {
      return true;
    }
  }
  return false;
}
var withNativeArrayBuffer, isView, toString, withNativeBlob, withNativeFile;
var init_is_binary = __esm({
  "../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/is-binary.js"() {
    withNativeArrayBuffer = typeof ArrayBuffer === "function";
    isView = (obj) => {
      return typeof ArrayBuffer.isView === "function" ? ArrayBuffer.isView(obj) : obj.buffer instanceof ArrayBuffer;
    };
    toString = Object.prototype.toString;
    withNativeBlob = typeof Blob === "function" || typeof Blob !== "undefined" && toString.call(Blob) === "[object BlobConstructor]";
    withNativeFile = typeof File === "function" || typeof File !== "undefined" && toString.call(File) === "[object FileConstructor]";
  }
});

// ../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/binary.js
function deconstructPacket(packet) {
  const buffers = [];
  const packetData = packet.data;
  const pack = packet;
  pack.data = _deconstructPacket(packetData, buffers);
  pack.attachments = buffers.length;
  return { packet: pack, buffers };
}
function _deconstructPacket(data, buffers, toJSON) {
  if (!data)
    return data;
  if (isBinary(data)) {
    const placeholder = { _placeholder: true, num: buffers.length };
    buffers.push(data);
    return placeholder;
  } else if (Array.isArray(data)) {
    const newData = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      newData[i] = _deconstructPacket(data[i], buffers);
    }
    return newData;
  } else if (typeof data === "object" && !(data instanceof Date)) {
    if (data.toJSON && typeof data.toJSON === "function" && !toJSON) {
      return _deconstructPacket(data.toJSON(), buffers, true);
    }
    const newData = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        newData[key] = _deconstructPacket(data[key], buffers);
      }
    }
    return newData;
  }
  return data;
}
function reconstructPacket(packet, buffers) {
  packet.data = _reconstructPacket(packet.data, buffers);
  delete packet.attachments;
  return packet;
}
function _reconstructPacket(data, buffers) {
  if (!data)
    return data;
  if (data && data._placeholder === true) {
    const isIndexValid = typeof data.num === "number" && data.num >= 0 && data.num < buffers.length;
    if (isIndexValid) {
      return buffers[data.num];
    } else {
      throw new Error("illegal attachments");
    }
  } else if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      data[i] = _reconstructPacket(data[i], buffers);
    }
  } else if (typeof data === "object") {
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        data[key] = _reconstructPacket(data[key], buffers);
      }
    }
  }
  return data;
}
var init_binary = __esm({
  "../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/binary.js"() {
    init_is_binary();
  }
});

// ../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/index.js
var esm_debug_exports = {};
__export(esm_debug_exports, {
  Decoder: () => Decoder,
  Encoder: () => Encoder,
  PacketType: () => PacketType,
  isPacketValid: () => isPacketValid,
  protocol: () => protocol3
});
function isNamespaceValid(nsp) {
  return typeof nsp === "string";
}
function isAckIdValid(id) {
  return id === void 0 || isInteger(id);
}
function isObject(value2) {
  return Object.prototype.toString.call(value2) === "[object Object]";
}
function isDataValid(type, payload) {
  switch (type) {
    case PacketType.CONNECT:
      return payload === void 0 || isObject(payload);
    case PacketType.DISCONNECT:
      return payload === void 0;
    case PacketType.EVENT:
      return Array.isArray(payload) && (typeof payload[0] === "number" || typeof payload[0] === "string" && RESERVED_EVENTS.indexOf(payload[0]) === -1);
    case PacketType.ACK:
      return Array.isArray(payload);
    case PacketType.CONNECT_ERROR:
      return typeof payload === "string" || isObject(payload);
    default:
      return false;
  }
}
function isPacketValid(packet) {
  return isNamespaceValid(packet.nsp) && isAckIdValid(packet.id) && isDataValid(packet.type, packet.data);
}
var import_component_emitter4, import_debug8, debug8, RESERVED_EVENTS, protocol3, PacketType, Encoder, Decoder, BinaryReconstructor, isInteger;
var init_esm_debug2 = __esm({
  "../../node_modules/.pnpm/socket.io-parser@4.2.7/node_modules/socket.io-parser/build/esm-debug/index.js"() {
    import_component_emitter4 = __toESM(require_cjs(), 1);
    init_binary();
    init_is_binary();
    import_debug8 = __toESM(require_src(), 1);
    debug8 = (0, import_debug8.default)("socket.io-parser");
    RESERVED_EVENTS = [
      "connect",
      // used on the client side
      "connect_error",
      // used on the client side
      "disconnect",
      // used on both sides
      "disconnecting",
      // used on the server side
      "newListener",
      // used by the Node.js EventEmitter
      "removeListener"
      // used by the Node.js EventEmitter
    ];
    protocol3 = 5;
    (function(PacketType2) {
      PacketType2[PacketType2["CONNECT"] = 0] = "CONNECT";
      PacketType2[PacketType2["DISCONNECT"] = 1] = "DISCONNECT";
      PacketType2[PacketType2["EVENT"] = 2] = "EVENT";
      PacketType2[PacketType2["ACK"] = 3] = "ACK";
      PacketType2[PacketType2["CONNECT_ERROR"] = 4] = "CONNECT_ERROR";
      PacketType2[PacketType2["BINARY_EVENT"] = 5] = "BINARY_EVENT";
      PacketType2[PacketType2["BINARY_ACK"] = 6] = "BINARY_ACK";
    })(PacketType || (PacketType = {}));
    Encoder = class {
      /**
       * Encoder constructor
       *
       * @param {function} replacer - custom replacer to pass down to JSON.parse
       */
      constructor(replacer) {
        this.replacer = replacer;
      }
      /**
       * Encode a packet as a single string if non-binary, or as a
       * buffer sequence, depending on packet type.
       *
       * @param {Object} obj - packet object
       */
      encode(obj) {
        debug8("encoding packet %j", obj);
        if (obj.type === PacketType.EVENT || obj.type === PacketType.ACK) {
          if (hasBinary(obj)) {
            return this.encodeAsBinary({
              type: obj.type === PacketType.EVENT ? PacketType.BINARY_EVENT : PacketType.BINARY_ACK,
              nsp: obj.nsp,
              data: obj.data,
              id: obj.id
            });
          }
        }
        return [this.encodeAsString(obj)];
      }
      /**
       * Encode packet as string.
       */
      encodeAsString(obj) {
        let str = "" + obj.type;
        if (obj.type === PacketType.BINARY_EVENT || obj.type === PacketType.BINARY_ACK) {
          str += obj.attachments + "-";
        }
        if (obj.nsp && "/" !== obj.nsp) {
          str += obj.nsp + ",";
        }
        if (null != obj.id) {
          str += obj.id;
        }
        if (null != obj.data) {
          str += JSON.stringify(obj.data, this.replacer);
        }
        debug8("encoded %j as %s", obj, str);
        return str;
      }
      /**
       * Encode packet as 'buffer sequence' by removing blobs, and
       * deconstructing packet into object with placeholders and
       * a list of buffers.
       */
      encodeAsBinary(obj) {
        const deconstruction = deconstructPacket(obj);
        const pack = this.encodeAsString(deconstruction.packet);
        const buffers = deconstruction.buffers;
        buffers.unshift(pack);
        return buffers;
      }
    };
    Decoder = class _Decoder extends import_component_emitter4.Emitter {
      /**
       * Decoder constructor
       */
      constructor(opts) {
        super();
        this.opts = Object.assign({
          reviver: void 0,
          maxAttachments: 10
        }, typeof opts === "function" ? { reviver: opts } : opts);
      }
      /**
       * Decodes an encoded packet string into packet JSON.
       *
       * @param {String} obj - encoded packet
       */
      add(obj) {
        let packet;
        if (typeof obj === "string") {
          if (this.reconstructor) {
            throw new Error("got plaintext data when reconstructing a packet");
          }
          packet = this.decodeString(obj);
          const isBinaryEvent = packet.type === PacketType.BINARY_EVENT;
          if (isBinaryEvent || packet.type === PacketType.BINARY_ACK) {
            packet.type = isBinaryEvent ? PacketType.EVENT : PacketType.ACK;
            this.reconstructor = new BinaryReconstructor(packet);
          } else {
            super.emitReserved("decoded", packet);
          }
        } else if (isBinary(obj) || obj.base64) {
          if (!this.reconstructor) {
            throw new Error("got binary data when not reconstructing a packet");
          } else {
            packet = this.reconstructor.takeBinaryData(obj);
            if (packet) {
              this.reconstructor = null;
              super.emitReserved("decoded", packet);
            }
          }
        } else {
          throw new Error("Unknown type: " + obj);
        }
      }
      /**
       * Decode a packet String (JSON data)
       *
       * @param {String} str
       * @return {Object} packet
       */
      decodeString(str) {
        let i = 0;
        const p = {
          type: Number(str.charAt(0))
        };
        if (PacketType[p.type] === void 0) {
          throw new Error("unknown packet type " + p.type);
        }
        if (p.type === PacketType.BINARY_EVENT || p.type === PacketType.BINARY_ACK) {
          const start = i + 1;
          while (str.charAt(++i) !== "-" && i != str.length) {
          }
          const buf = str.substring(start, i);
          if (buf != Number(buf) || str.charAt(i) !== "-") {
            throw new Error("Illegal attachments");
          }
          const n = Number(buf);
          if (!isInteger(n) || n < 1) {
            throw new Error("Illegal attachments");
          } else if (n > this.opts.maxAttachments) {
            throw new Error("too many attachments");
          }
          p.attachments = n;
        }
        if ("/" === str.charAt(i + 1)) {
          const start = i + 1;
          while (++i) {
            const c = str.charAt(i);
            if ("," === c)
              break;
            if (i === str.length)
              break;
          }
          p.nsp = str.substring(start, i);
        } else {
          p.nsp = "/";
        }
        const next = str.charAt(i + 1);
        if ("" !== next && Number(next) == next) {
          const start = i + 1;
          while (++i) {
            const c = str.charAt(i);
            if (null == c || Number(c) != c) {
              --i;
              break;
            }
            if (i === str.length)
              break;
          }
          p.id = Number(str.substring(start, i + 1));
        }
        if (str.charAt(++i)) {
          const payload = this.tryParse(str.substr(i));
          if (_Decoder.isPayloadValid(p.type, payload)) {
            p.data = payload;
          } else {
            throw new Error("invalid payload");
          }
        }
        debug8("decoded %s as %j", str, p);
        return p;
      }
      tryParse(str) {
        try {
          return JSON.parse(str, this.opts.reviver);
        } catch (e) {
          return false;
        }
      }
      static isPayloadValid(type, payload) {
        switch (type) {
          case PacketType.CONNECT:
            return isObject(payload);
          case PacketType.DISCONNECT:
            return payload === void 0;
          case PacketType.CONNECT_ERROR:
            return typeof payload === "string" || isObject(payload);
          case PacketType.EVENT:
          case PacketType.BINARY_EVENT:
            return Array.isArray(payload) && (typeof payload[0] === "number" || typeof payload[0] === "string" && RESERVED_EVENTS.indexOf(payload[0]) === -1);
          case PacketType.ACK:
          case PacketType.BINARY_ACK:
            return Array.isArray(payload);
        }
      }
      /**
       * Deallocates a parser's resources
       */
      destroy() {
        if (this.reconstructor) {
          this.reconstructor.finishedReconstruction();
          this.reconstructor = null;
        }
      }
    };
    BinaryReconstructor = class {
      constructor(packet) {
        this.packet = packet;
        this.buffers = [];
        this.reconPack = packet;
      }
      /**
       * Method to be called when binary data received from connection
       * after a BINARY_EVENT packet.
       *
       * @param {Buffer | ArrayBuffer} binData - the raw binary data received
       * @return {null | Object} returns null if more binary data is expected or
       *   a reconstructed packet object if all buffers have been received.
       */
      takeBinaryData(binData) {
        this.buffers.push(binData);
        if (this.buffers.length === this.reconPack.attachments) {
          const packet = reconstructPacket(this.reconPack, this.buffers);
          this.finishedReconstruction();
          return packet;
        }
        return null;
      }
      /**
       * Cleans up binary packet reconstruction variables.
       */
      finishedReconstruction() {
        this.reconPack = null;
        this.buffers = [];
      }
    };
    isInteger = Number.isInteger || function(value2) {
      return typeof value2 === "number" && isFinite(value2) && Math.floor(value2) === value2;
    };
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/on.js
function on(obj, ev, fn) {
  obj.on(ev, fn);
  return function subDestroy() {
    obj.off(ev, fn);
  };
}
var init_on = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/on.js"() {
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/socket.js
var import_component_emitter5, import_debug9, debug9, RESERVED_EVENTS2, Socket2;
var init_socket2 = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/socket.js"() {
    init_esm_debug2();
    init_on();
    import_component_emitter5 = __toESM(require_cjs(), 1);
    import_debug9 = __toESM(require_src(), 1);
    debug9 = (0, import_debug9.default)("socket.io-client:socket");
    RESERVED_EVENTS2 = Object.freeze({
      connect: 1,
      connect_error: 1,
      disconnect: 1,
      disconnecting: 1,
      // EventEmitter reserved events: https://nodejs.org/api/events.html#events_event_newlistener
      newListener: 1,
      removeListener: 1
    });
    Socket2 = class extends import_component_emitter5.Emitter {
      /**
       * `Socket` constructor.
       */
      constructor(io, nsp, opts) {
        super();
        this.connected = false;
        this.recovered = false;
        this.receiveBuffer = [];
        this.sendBuffer = [];
        this._queue = [];
        this._queueSeq = 0;
        this.ids = 0;
        this.acks = {};
        this.flags = {};
        this.io = io;
        this.nsp = nsp;
        if (opts && opts.auth) {
          this.auth = opts.auth;
        }
        this._opts = Object.assign({}, opts);
        if (this.io._autoConnect)
          this.open();
      }
      /**
       * Whether the socket is currently disconnected
       *
       * @example
       * const socket = io();
       *
       * socket.on("connect", () => {
       *   console.log(socket.disconnected); // false
       * });
       *
       * socket.on("disconnect", () => {
       *   console.log(socket.disconnected); // true
       * });
       */
      get disconnected() {
        return !this.connected;
      }
      /**
       * Subscribe to open, close and packet events
       *
       * @private
       */
      subEvents() {
        if (this.subs)
          return;
        const io = this.io;
        this.subs = [
          on(io, "open", this.onopen.bind(this)),
          on(io, "packet", this.onpacket.bind(this)),
          on(io, "error", this.onerror.bind(this)),
          on(io, "close", this.onclose.bind(this))
        ];
      }
      /**
       * Whether the Socket will try to reconnect when its Manager connects or reconnects.
       *
       * @example
       * const socket = io();
       *
       * console.log(socket.active); // true
       *
       * socket.on("disconnect", (reason) => {
       *   if (reason === "io server disconnect") {
       *     // the disconnection was initiated by the server, you need to manually reconnect
       *     console.log(socket.active); // false
       *   }
       *   // else the socket will automatically try to reconnect
       *   console.log(socket.active); // true
       * });
       */
      get active() {
        return !!this.subs;
      }
      /**
       * "Opens" the socket.
       *
       * @example
       * const socket = io({
       *   autoConnect: false
       * });
       *
       * socket.connect();
       */
      connect() {
        if (this.connected)
          return this;
        this.subEvents();
        if (!this.io["_reconnecting"])
          this.io.open();
        if ("open" === this.io._readyState)
          this.onopen();
        return this;
      }
      /**
       * Alias for {@link connect()}.
       */
      open() {
        return this.connect();
      }
      /**
       * Sends a `message` event.
       *
       * This method mimics the WebSocket.send() method.
       *
       * @see https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/send
       *
       * @example
       * socket.send("hello");
       *
       * // this is equivalent to
       * socket.emit("message", "hello");
       *
       * @return self
       */
      send(...args) {
        args.unshift("message");
        this.emit.apply(this, args);
        return this;
      }
      /**
       * Override `emit`.
       * If the event is in `events`, it's emitted normally.
       *
       * @example
       * socket.emit("hello", "world");
       *
       * // all serializable datastructures are supported (no need to call JSON.stringify)
       * socket.emit("hello", 1, "2", { 3: ["4"], 5: Uint8Array.from([6]) });
       *
       * // with an acknowledgement from the server
       * socket.emit("hello", "world", (val) => {
       *   // ...
       * });
       *
       * @return self
       */
      emit(ev, ...args) {
        var _a, _b, _c;
        if (RESERVED_EVENTS2.hasOwnProperty(ev)) {
          throw new Error('"' + ev.toString() + '" is a reserved event name');
        }
        args.unshift(ev);
        if (this._opts.retries && !this.flags.fromQueue && !this.flags.volatile) {
          this._addToQueue(args);
          return this;
        }
        const packet = {
          type: PacketType.EVENT,
          data: args
        };
        packet.options = {};
        packet.options.compress = this.flags.compress !== false;
        if ("function" === typeof args[args.length - 1]) {
          const id = this.ids++;
          debug9("emitting packet with ack id %d", id);
          const ack = args.pop();
          this._registerAckCallback(id, ack);
          packet.id = id;
        }
        const isTransportWritable = (_b = (_a = this.io.engine) === null || _a === void 0 ? void 0 : _a.transport) === null || _b === void 0 ? void 0 : _b.writable;
        const isConnected = this.connected && !((_c = this.io.engine) === null || _c === void 0 ? void 0 : _c._hasPingExpired());
        const discardPacket = this.flags.volatile && !isTransportWritable;
        if (discardPacket) {
          debug9("discard packet as the transport is not currently writable");
        } else if (isConnected) {
          this.notifyOutgoingListeners(packet);
          this.packet(packet);
        } else {
          this.sendBuffer.push(packet);
        }
        this.flags = {};
        return this;
      }
      /**
       * @private
       */
      _registerAckCallback(id, ack) {
        var _a;
        const timeout = (_a = this.flags.timeout) !== null && _a !== void 0 ? _a : this._opts.ackTimeout;
        if (timeout === void 0) {
          this.acks[id] = ack;
          return;
        }
        const timer = this.io.setTimeoutFn(() => {
          delete this.acks[id];
          for (let i = 0; i < this.sendBuffer.length; i++) {
            if (this.sendBuffer[i].id === id) {
              debug9("removing packet with ack id %d from the buffer", id);
              this.sendBuffer.splice(i, 1);
            }
          }
          debug9("event with ack id %d has timed out after %d ms", id, timeout);
          ack.call(this, new Error("operation has timed out"));
        }, timeout);
        const fn = (...args) => {
          this.io.clearTimeoutFn(timer);
          ack.apply(this, args);
        };
        fn.withError = true;
        this.acks[id] = fn;
      }
      /**
       * Emits an event and waits for an acknowledgement
       *
       * @example
       * // without timeout
       * const response = await socket.emitWithAck("hello", "world");
       *
       * // with a specific timeout
       * try {
       *   const response = await socket.timeout(1000).emitWithAck("hello", "world");
       * } catch (err) {
       *   // the server did not acknowledge the event in the given delay
       * }
       *
       * @return a Promise that will be fulfilled when the server acknowledges the event
       */
      emitWithAck(ev, ...args) {
        return new Promise((resolve2, reject) => {
          const fn = (arg1, arg2) => {
            return arg1 ? reject(arg1) : resolve2(arg2);
          };
          fn.withError = true;
          args.push(fn);
          this.emit(ev, ...args);
        });
      }
      /**
       * Add the packet to the queue.
       * @param args
       * @private
       */
      _addToQueue(args) {
        let ack;
        if (typeof args[args.length - 1] === "function") {
          ack = args.pop();
        }
        const packet = {
          id: this._queueSeq++,
          tryCount: 0,
          pending: false,
          args,
          flags: Object.assign({ fromQueue: true }, this.flags)
        };
        args.push((err, ...responseArgs) => {
          if (packet !== this._queue[0]) {
            return debug9("packet [%d] already acknowledged", packet.id);
          }
          const hasError = err !== null;
          if (hasError) {
            if (packet.tryCount > this._opts.retries) {
              debug9("packet [%d] is discarded after %d tries", packet.id, packet.tryCount);
              this._queue.shift();
              if (ack) {
                ack(err);
              }
            }
          } else {
            debug9("packet [%d] was successfully sent", packet.id);
            this._queue.shift();
            if (ack) {
              ack(null, ...responseArgs);
            }
          }
          packet.pending = false;
          return this._drainQueue();
        });
        this._queue.push(packet);
        this._drainQueue();
      }
      /**
       * Send the first packet of the queue, and wait for an acknowledgement from the server.
       * @param force - whether to resend a packet that has not been acknowledged yet
       *
       * @private
       */
      _drainQueue(force = false) {
        debug9("draining queue");
        if (!this.connected || this._queue.length === 0) {
          return;
        }
        const packet = this._queue[0];
        if (packet.pending && !force) {
          debug9("packet [%d] has already been sent and is waiting for an ack", packet.id);
          return;
        }
        packet.pending = true;
        packet.tryCount++;
        debug9("sending packet [%d] (try n\xB0%d)", packet.id, packet.tryCount);
        this.flags = packet.flags;
        this.emit.apply(this, packet.args);
      }
      /**
       * Sends a packet.
       *
       * @param packet
       * @private
       */
      packet(packet) {
        packet.nsp = this.nsp;
        this.io._packet(packet);
      }
      /**
       * Called upon engine `open`.
       *
       * @private
       */
      onopen() {
        debug9("transport is open - connecting");
        if (typeof this.auth == "function") {
          this.auth((data) => {
            this._sendConnectPacket(data);
          });
        } else {
          this._sendConnectPacket(this.auth);
        }
      }
      /**
       * Sends a CONNECT packet to initiate the Socket.IO session.
       *
       * @param data
       * @private
       */
      _sendConnectPacket(data) {
        this.packet({
          type: PacketType.CONNECT,
          data: this._pid ? Object.assign({ pid: this._pid, offset: this._lastOffset }, data) : data
        });
      }
      /**
       * Called upon engine or manager `error`.
       *
       * @param err
       * @private
       */
      onerror(err) {
        if (!this.connected) {
          this.emitReserved("connect_error", err);
        }
      }
      /**
       * Called upon engine `close`.
       *
       * @param reason
       * @param description
       * @private
       */
      onclose(reason, description) {
        debug9("close (%s)", reason);
        this.connected = false;
        delete this.id;
        this.emitReserved("disconnect", reason, description);
        this._clearAcks();
      }
      /**
       * Clears the acknowledgement handlers upon disconnection, since the client will never receive an acknowledgement from
       * the server.
       *
       * @private
       */
      _clearAcks() {
        Object.keys(this.acks).forEach((id) => {
          const isBuffered = this.sendBuffer.some((packet) => String(packet.id) === id);
          if (!isBuffered) {
            const ack = this.acks[id];
            delete this.acks[id];
            if (ack.withError) {
              ack.call(this, new Error("socket has been disconnected"));
            }
          }
        });
      }
      /**
       * Called with socket packet.
       *
       * @param packet
       * @private
       */
      onpacket(packet) {
        const sameNamespace = packet.nsp === this.nsp;
        if (!sameNamespace)
          return;
        switch (packet.type) {
          case PacketType.CONNECT:
            if (packet.data && packet.data.sid) {
              this.onconnect(packet.data.sid, packet.data.pid);
            } else {
              this.emitReserved("connect_error", new Error("It seems you are trying to reach a Socket.IO server in v2.x with a v3.x client, but they are not compatible (more information here: https://socket.io/docs/v3/migrating-from-2-x-to-3-0/)"));
            }
            break;
          case PacketType.EVENT:
          case PacketType.BINARY_EVENT:
            this.onevent(packet);
            break;
          case PacketType.ACK:
          case PacketType.BINARY_ACK:
            this.onack(packet);
            break;
          case PacketType.DISCONNECT:
            this.ondisconnect();
            break;
          case PacketType.CONNECT_ERROR:
            this.destroy();
            const err = new Error(packet.data.message);
            err.data = packet.data.data;
            this.emitReserved("connect_error", err);
            break;
        }
      }
      /**
       * Called upon a server event.
       *
       * @param packet
       * @private
       */
      onevent(packet) {
        const args = packet.data || [];
        debug9("emitting event %j", args);
        if (null != packet.id) {
          debug9("attaching ack callback to event");
          args.push(this.ack(packet.id));
        }
        if (this.connected) {
          this.emitEvent(args);
        } else {
          this.receiveBuffer.push(Object.freeze(args));
        }
      }
      emitEvent(args) {
        if (this._anyListeners && this._anyListeners.length) {
          const listeners = this._anyListeners.slice();
          for (const listener of listeners) {
            listener.apply(this, args);
          }
        }
        super.emit.apply(this, args);
        if (this._pid && args.length && typeof args[args.length - 1] === "string") {
          this._lastOffset = args[args.length - 1];
        }
      }
      /**
       * Produces an ack callback to emit with an event.
       *
       * @private
       */
      ack(id) {
        const self = this;
        let sent = false;
        return function(...args) {
          if (sent)
            return;
          sent = true;
          debug9("sending ack %j", args);
          self.packet({
            type: PacketType.ACK,
            id,
            data: args
          });
        };
      }
      /**
       * Called upon a server acknowledgement.
       *
       * @param packet
       * @private
       */
      onack(packet) {
        const ack = this.acks[packet.id];
        if (typeof ack !== "function") {
          debug9("bad ack %s", packet.id);
          return;
        }
        delete this.acks[packet.id];
        debug9("calling ack %s with %j", packet.id, packet.data);
        if (ack.withError) {
          packet.data.unshift(null);
        }
        ack.apply(this, packet.data);
      }
      /**
       * Called upon server connect.
       *
       * @private
       */
      onconnect(id, pid) {
        debug9("socket connected with id %s", id);
        this.id = id;
        this.recovered = pid && this._pid === pid;
        this._pid = pid;
        this.connected = true;
        this.emitBuffered();
        this._drainQueue(true);
        this.emitReserved("connect");
      }
      /**
       * Emit buffered events (received and emitted).
       *
       * @private
       */
      emitBuffered() {
        this.receiveBuffer.forEach((args) => this.emitEvent(args));
        this.receiveBuffer = [];
        this.sendBuffer.forEach((packet) => {
          this.notifyOutgoingListeners(packet);
          this.packet(packet);
        });
        this.sendBuffer = [];
      }
      /**
       * Called upon server disconnect.
       *
       * @private
       */
      ondisconnect() {
        debug9("server disconnect (%s)", this.nsp);
        this.destroy();
        this.onclose("io server disconnect");
      }
      /**
       * Called upon forced client/server side disconnections,
       * this method ensures the manager stops tracking us and
       * that reconnections don't get triggered for this.
       *
       * @private
       */
      destroy() {
        if (this.subs) {
          this.subs.forEach((subDestroy) => subDestroy());
          this.subs = void 0;
        }
        this.io["_destroy"](this);
      }
      /**
       * Disconnects the socket manually. In that case, the socket will not try to reconnect.
       *
       * If this is the last active Socket instance of the {@link Manager}, the low-level connection will be closed.
       *
       * @example
       * const socket = io();
       *
       * socket.on("disconnect", (reason) => {
       *   // console.log(reason); prints "io client disconnect"
       * });
       *
       * socket.disconnect();
       *
       * @return self
       */
      disconnect() {
        if (this.connected) {
          debug9("performing disconnect (%s)", this.nsp);
          this.packet({ type: PacketType.DISCONNECT });
        }
        this.destroy();
        if (this.connected) {
          this.onclose("io client disconnect");
        }
        return this;
      }
      /**
       * Alias for {@link disconnect()}.
       *
       * @return self
       */
      close() {
        return this.disconnect();
      }
      /**
       * Sets the compress flag.
       *
       * @example
       * socket.compress(false).emit("hello");
       *
       * @param compress - if `true`, compresses the sending data
       * @return self
       */
      compress(compress) {
        this.flags.compress = compress;
        return this;
      }
      /**
       * Sets a modifier for a subsequent event emission that the event message will be dropped when this socket is not
       * ready to send messages.
       *
       * @example
       * socket.volatile.emit("hello"); // the server may or may not receive it
       *
       * @returns self
       */
      get volatile() {
        this.flags.volatile = true;
        return this;
      }
      /**
       * Sets a modifier for a subsequent event emission that the callback will be called with an error when the
       * given number of milliseconds have elapsed without an acknowledgement from the server:
       *
       * @example
       * socket.timeout(5000).emit("my-event", (err) => {
       *   if (err) {
       *     // the server did not acknowledge the event in the given delay
       *   }
       * });
       *
       * @returns self
       */
      timeout(timeout) {
        this.flags.timeout = timeout;
        return this;
      }
      /**
       * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
       * callback.
       *
       * @example
       * socket.onAny((event, ...args) => {
       *   console.log(`got ${event}`);
       * });
       *
       * @param listener
       */
      onAny(listener) {
        this._anyListeners = this._anyListeners || [];
        this._anyListeners.push(listener);
        return this;
      }
      /**
       * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
       * callback. The listener is added to the beginning of the listeners array.
       *
       * @example
       * socket.prependAny((event, ...args) => {
       *   console.log(`got event ${event}`);
       * });
       *
       * @param listener
       */
      prependAny(listener) {
        this._anyListeners = this._anyListeners || [];
        this._anyListeners.unshift(listener);
        return this;
      }
      /**
       * Removes the listener that will be fired when any event is emitted.
       *
       * @example
       * const catchAllListener = (event, ...args) => {
       *   console.log(`got event ${event}`);
       * }
       *
       * socket.onAny(catchAllListener);
       *
       * // remove a specific listener
       * socket.offAny(catchAllListener);
       *
       * // or remove all listeners
       * socket.offAny();
       *
       * @param listener
       */
      offAny(listener) {
        if (!this._anyListeners) {
          return this;
        }
        if (listener) {
          const listeners = this._anyListeners;
          for (let i = 0; i < listeners.length; i++) {
            if (listener === listeners[i]) {
              listeners.splice(i, 1);
              return this;
            }
          }
        } else {
          this._anyListeners = [];
        }
        return this;
      }
      /**
       * Returns an array of listeners that are listening for any event that is specified. This array can be manipulated,
       * e.g. to remove listeners.
       */
      listenersAny() {
        return this._anyListeners || [];
      }
      /**
       * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
       * callback.
       *
       * Note: acknowledgements sent to the server are not included.
       *
       * @example
       * socket.onAnyOutgoing((event, ...args) => {
       *   console.log(`sent event ${event}`);
       * });
       *
       * @param listener
       */
      onAnyOutgoing(listener) {
        this._anyOutgoingListeners = this._anyOutgoingListeners || [];
        this._anyOutgoingListeners.push(listener);
        return this;
      }
      /**
       * Adds a listener that will be fired when any event is emitted. The event name is passed as the first argument to the
       * callback. The listener is added to the beginning of the listeners array.
       *
       * Note: acknowledgements sent to the server are not included.
       *
       * @example
       * socket.prependAnyOutgoing((event, ...args) => {
       *   console.log(`sent event ${event}`);
       * });
       *
       * @param listener
       */
      prependAnyOutgoing(listener) {
        this._anyOutgoingListeners = this._anyOutgoingListeners || [];
        this._anyOutgoingListeners.unshift(listener);
        return this;
      }
      /**
       * Removes the listener that will be fired when any event is emitted.
       *
       * @example
       * const catchAllListener = (event, ...args) => {
       *   console.log(`sent event ${event}`);
       * }
       *
       * socket.onAnyOutgoing(catchAllListener);
       *
       * // remove a specific listener
       * socket.offAnyOutgoing(catchAllListener);
       *
       * // or remove all listeners
       * socket.offAnyOutgoing();
       *
       * @param [listener] - the catch-all listener (optional)
       */
      offAnyOutgoing(listener) {
        if (!this._anyOutgoingListeners) {
          return this;
        }
        if (listener) {
          const listeners = this._anyOutgoingListeners;
          for (let i = 0; i < listeners.length; i++) {
            if (listener === listeners[i]) {
              listeners.splice(i, 1);
              return this;
            }
          }
        } else {
          this._anyOutgoingListeners = [];
        }
        return this;
      }
      /**
       * Returns an array of listeners that are listening for any event that is specified. This array can be manipulated,
       * e.g. to remove listeners.
       */
      listenersAnyOutgoing() {
        return this._anyOutgoingListeners || [];
      }
      /**
       * Notify the listeners for each packet sent
       *
       * @param packet
       *
       * @private
       */
      notifyOutgoingListeners(packet) {
        if (this._anyOutgoingListeners && this._anyOutgoingListeners.length) {
          const listeners = this._anyOutgoingListeners.slice();
          for (const listener of listeners) {
            listener.apply(this, packet.data);
          }
        }
      }
    };
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/contrib/backo2.js
function Backoff(opts) {
  opts = opts || {};
  this.ms = opts.min || 100;
  this.max = opts.max || 1e4;
  this.factor = opts.factor || 2;
  this.jitter = opts.jitter > 0 && opts.jitter <= 1 ? opts.jitter : 0;
  this.attempts = 0;
}
var init_backo2 = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/contrib/backo2.js"() {
    Backoff.prototype.duration = function() {
      var ms = this.ms * Math.pow(this.factor, this.attempts++);
      if (this.jitter) {
        var rand = Math.random();
        var deviation = Math.floor(rand * this.jitter * ms);
        ms = (Math.floor(rand * 10) & 1) == 0 ? ms - deviation : ms + deviation;
      }
      return Math.min(ms, this.max) | 0;
    };
    Backoff.prototype.reset = function() {
      this.attempts = 0;
    };
    Backoff.prototype.setMin = function(min) {
      this.ms = min;
    };
    Backoff.prototype.setMax = function(max) {
      this.max = max;
    };
    Backoff.prototype.setJitter = function(jitter) {
      this.jitter = jitter;
    };
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/manager.js
var import_component_emitter6, import_debug10, debug10, Manager;
var init_manager = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/manager.js"() {
    init_esm_debug();
    init_socket2();
    init_esm_debug2();
    init_on();
    init_backo2();
    import_component_emitter6 = __toESM(require_cjs(), 1);
    import_debug10 = __toESM(require_src(), 1);
    debug10 = (0, import_debug10.default)("socket.io-client:manager");
    Manager = class extends import_component_emitter6.Emitter {
      constructor(uri, opts) {
        var _a;
        super();
        this.nsps = {};
        this.subs = [];
        if (uri && "object" === typeof uri) {
          opts = uri;
          uri = void 0;
        }
        opts = opts || {};
        opts.path = opts.path || "/socket.io";
        this.opts = opts;
        installTimerFunctions(this, opts);
        this.reconnection(opts.reconnection !== false);
        this.reconnectionAttempts(opts.reconnectionAttempts || Infinity);
        this.reconnectionDelay(opts.reconnectionDelay || 1e3);
        this.reconnectionDelayMax(opts.reconnectionDelayMax || 5e3);
        this.randomizationFactor((_a = opts.randomizationFactor) !== null && _a !== void 0 ? _a : 0.5);
        this.backoff = new Backoff({
          min: this.reconnectionDelay(),
          max: this.reconnectionDelayMax(),
          jitter: this.randomizationFactor()
        });
        this.timeout(null == opts.timeout ? 2e4 : opts.timeout);
        this._readyState = "closed";
        this.uri = uri;
        const _parser = opts.parser || esm_debug_exports;
        this.encoder = new _parser.Encoder();
        this.decoder = new _parser.Decoder();
        this._autoConnect = opts.autoConnect !== false;
        if (this._autoConnect)
          this.open();
      }
      reconnection(v) {
        if (!arguments.length)
          return this._reconnection;
        this._reconnection = !!v;
        if (!v) {
          this.skipReconnect = true;
        }
        return this;
      }
      reconnectionAttempts(v) {
        if (v === void 0)
          return this._reconnectionAttempts;
        this._reconnectionAttempts = v;
        return this;
      }
      reconnectionDelay(v) {
        var _a;
        if (v === void 0)
          return this._reconnectionDelay;
        this._reconnectionDelay = v;
        (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setMin(v);
        return this;
      }
      randomizationFactor(v) {
        var _a;
        if (v === void 0)
          return this._randomizationFactor;
        this._randomizationFactor = v;
        (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setJitter(v);
        return this;
      }
      reconnectionDelayMax(v) {
        var _a;
        if (v === void 0)
          return this._reconnectionDelayMax;
        this._reconnectionDelayMax = v;
        (_a = this.backoff) === null || _a === void 0 ? void 0 : _a.setMax(v);
        return this;
      }
      timeout(v) {
        if (!arguments.length)
          return this._timeout;
        this._timeout = v;
        return this;
      }
      /**
       * Starts trying to reconnect if reconnection is enabled and we have not
       * started reconnecting yet
       *
       * @private
       */
      maybeReconnectOnOpen() {
        if (!this._reconnecting && this._reconnection && this.backoff.attempts === 0) {
          this.reconnect();
        }
      }
      /**
       * Sets the current transport `socket`.
       *
       * @param {Function} fn - optional, callback
       * @return self
       * @public
       */
      open(fn) {
        debug10("readyState %s", this._readyState);
        if (~this._readyState.indexOf("open"))
          return this;
        debug10("opening %s", this.uri);
        this.engine = new Socket(this.uri, this.opts);
        const socket = this.engine;
        const self = this;
        this._readyState = "opening";
        this.skipReconnect = false;
        const openSubDestroy = on(socket, "open", function() {
          self.onopen();
          fn && fn();
        });
        const onError = (err) => {
          debug10("error");
          this.cleanup();
          this._readyState = "closed";
          this.emitReserved("error", err);
          if (fn) {
            fn(err);
          } else {
            this.maybeReconnectOnOpen();
          }
        };
        const errorSub = on(socket, "error", onError);
        if (false !== this._timeout) {
          const timeout = this._timeout;
          debug10("connect attempt will timeout after %d", timeout);
          const timer = this.setTimeoutFn(() => {
            debug10("connect attempt timed out after %d", timeout);
            openSubDestroy();
            onError(new Error("timeout"));
            socket.close();
          }, timeout);
          if (this.opts.autoUnref) {
            timer.unref();
          }
          this.subs.push(() => {
            this.clearTimeoutFn(timer);
          });
        }
        this.subs.push(openSubDestroy);
        this.subs.push(errorSub);
        return this;
      }
      /**
       * Alias for open()
       *
       * @return self
       * @public
       */
      connect(fn) {
        return this.open(fn);
      }
      /**
       * Called upon transport open.
       *
       * @private
       */
      onopen() {
        debug10("open");
        this.cleanup();
        this._readyState = "open";
        this.emitReserved("open");
        const socket = this.engine;
        this.subs.push(
          on(socket, "ping", this.onping.bind(this)),
          on(socket, "data", this.ondata.bind(this)),
          on(socket, "error", this.onerror.bind(this)),
          on(socket, "close", this.onclose.bind(this)),
          // @ts-ignore
          on(this.decoder, "decoded", this.ondecoded.bind(this))
        );
      }
      /**
       * Called upon a ping.
       *
       * @private
       */
      onping() {
        this.emitReserved("ping");
      }
      /**
       * Called with data.
       *
       * @private
       */
      ondata(data) {
        try {
          this.decoder.add(data);
        } catch (e) {
          this.onclose("parse error", e);
        }
      }
      /**
       * Called when parser fully decodes a packet.
       *
       * @private
       */
      ondecoded(packet) {
        nextTick(() => {
          this.emitReserved("packet", packet);
        }, this.setTimeoutFn);
      }
      /**
       * Called upon socket error.
       *
       * @private
       */
      onerror(err) {
        debug10("error", err);
        this.emitReserved("error", err);
      }
      /**
       * Creates a new socket for the given `nsp`.
       *
       * @return {Socket}
       * @public
       */
      socket(nsp, opts) {
        let socket = this.nsps[nsp];
        if (!socket) {
          socket = new Socket2(this, nsp, opts);
          this.nsps[nsp] = socket;
        } else if (this._autoConnect && !socket.active) {
          socket.connect();
        }
        return socket;
      }
      /**
       * Called upon a socket close.
       *
       * @param socket
       * @private
       */
      _destroy(socket) {
        const nsps = Object.keys(this.nsps);
        for (const nsp of nsps) {
          const socket2 = this.nsps[nsp];
          if (socket2.active) {
            debug10("socket %s is still active, skipping close", nsp);
            return;
          }
        }
        this._close();
      }
      /**
       * Writes a packet.
       *
       * @param packet
       * @private
       */
      _packet(packet) {
        debug10("writing packet %j", packet);
        const encodedPackets = this.encoder.encode(packet);
        for (let i = 0; i < encodedPackets.length; i++) {
          this.engine.write(encodedPackets[i], packet.options);
        }
      }
      /**
       * Clean up transport subscriptions and packet buffer.
       *
       * @private
       */
      cleanup() {
        debug10("cleanup");
        this.subs.forEach((subDestroy) => subDestroy());
        this.subs.length = 0;
        this.decoder.destroy();
      }
      /**
       * Close the current socket.
       *
       * @private
       */
      _close() {
        debug10("disconnect");
        this.skipReconnect = true;
        this._reconnecting = false;
        this.onclose("forced close");
      }
      /**
       * Alias for close()
       *
       * @private
       */
      disconnect() {
        return this._close();
      }
      /**
       * Called when:
       *
       * - the low-level engine is closed
       * - the parser encountered a badly formatted packet
       * - all sockets are disconnected
       *
       * @private
       */
      onclose(reason, description) {
        var _a;
        debug10("closed due to %s", reason);
        this.cleanup();
        (_a = this.engine) === null || _a === void 0 ? void 0 : _a.close();
        this.backoff.reset();
        this._readyState = "closed";
        this.emitReserved("close", reason, description);
        if (this._reconnection && !this.skipReconnect) {
          this.reconnect();
        }
      }
      /**
       * Attempt a reconnection.
       *
       * @private
       */
      reconnect() {
        if (this._reconnecting || this.skipReconnect)
          return this;
        const self = this;
        if (this.backoff.attempts >= this._reconnectionAttempts) {
          debug10("reconnect failed");
          this.backoff.reset();
          this.emitReserved("reconnect_failed");
          this._reconnecting = false;
        } else {
          const delay = this.backoff.duration();
          debug10("will wait %dms before reconnect attempt", delay);
          this._reconnecting = true;
          const timer = this.setTimeoutFn(() => {
            if (self.skipReconnect)
              return;
            debug10("attempting reconnect");
            this.emitReserved("reconnect_attempt", self.backoff.attempts);
            if (self.skipReconnect)
              return;
            self.open((err) => {
              if (err) {
                debug10("reconnect attempt error");
                self._reconnecting = false;
                self.reconnect();
                this.emitReserved("reconnect_error", err);
              } else {
                debug10("reconnect success");
                self.onreconnect();
              }
            });
          }, delay);
          if (this.opts.autoUnref) {
            timer.unref();
          }
          this.subs.push(() => {
            this.clearTimeoutFn(timer);
          });
        }
      }
      /**
       * Called upon successful reconnect.
       *
       * @private
       */
      onreconnect() {
        const attempt = this.backoff.attempts;
        this._reconnecting = false;
        this.backoff.reset();
        this.emitReserved("reconnect", attempt);
      }
    };
  }
});

// ../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/index.js
function lookup(uri, opts) {
  if (typeof uri === "object") {
    opts = uri;
    uri = void 0;
  }
  opts = opts || {};
  const parsed = url(uri, opts.path || "/socket.io");
  const source = parsed.source;
  const id = parsed.id;
  const path = parsed.path;
  const sameNamespace = cache[id] && path in cache[id]["nsps"];
  const newConnection = opts.forceNew || opts["force new connection"] || false === opts.multiplex || sameNamespace;
  let io;
  if (newConnection) {
    debug11("ignoring socket cache for %s", source);
    io = new Manager(source, opts);
  } else {
    if (!cache[id]) {
      debug11("new io instance for %s", source);
      cache[id] = new Manager(source, opts);
    }
    io = cache[id];
  }
  if (parsed.query && !opts.query) {
    opts.query = parsed.queryKey;
  }
  return io.socket(parsed.path, opts);
}
var import_debug11, debug11, cache;
var init_esm_debug3 = __esm({
  "../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm-debug/index.js"() {
    init_url();
    init_manager();
    init_socket2();
    import_debug11 = __toESM(require_src(), 1);
    init_esm_debug2();
    init_esm_debug();
    debug11 = (0, import_debug11.default)("socket.io-client");
    cache = {};
    Object.assign(lookup, {
      Manager,
      Socket: Socket2,
      io: lookup,
      connect: lookup
    });
  }
});

// dist/terminal-command.js
var terminal_command_exports = {};
__export(terminal_command_exports, {
  loadReconnectToken: () => loadReconnectToken,
  reconnectStorePath: () => reconnectStorePath,
  removeReconnectToken: () => removeReconnectToken,
  runTerminalCommand: () => runTerminalCommand,
  saveReconnectToken: () => saveReconnectToken
});
async function runTerminalCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "new" || subcommand === "shells" || subcommand === "list" || subcommand === "close" || subcommand === void 0) && hasHelp7(argv);
  if (helpRequested) {
    (context.log ?? console.log)(terminalUsage());
    return;
  }
  if (subcommand === "new") {
    await runNew2(argv, context);
    return;
  }
  if (subcommand === "shells") {
    await runShells(argv, context);
    return;
  }
  if (subcommand === "list") {
    await runList2(argv, context);
    return;
  }
  if (subcommand === "close") {
    await runClose(argv, context);
    return;
  }
  if (subcommand === "attach") {
    await runAttach(argv, context);
    return;
  }
  throw new Error(terminalUsage());
}
function hasHelp7(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function terminalUsage() {
  return [
    "Terminal \u547D\u4EE4:",
    "  vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]  # \u521B\u5EFA\u4F1A\u8BDD\uFF0C\u8FD4\u56DE sessionId",
    "  vcpdeck terminal shells <client> [--env=<name>] [--json]",
    "  vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]",
    "  vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]  # \u5199\u64CD\u4F5C\uFF0C\u4F1A\u8BDD\u5C06\u88AB\u7EC8\u6B62",
    "  vcpdeck terminal attach <client> <sessionId> [--env=<name>]  # \u672C\u5730\u7EC8\u7AEF\u76F4\u8FDE\u8FDC\u7AEF PTY\uFF1BCtrl+Q \u9000\u51FA",
    "  # \u4EA4\u4E92\u5F0F PTY \u8F93\u5165\u8F93\u51FA\u7ECF /app \u6570\u636E\u9762\uFF08Bearer \u63E1\u624B\u8BA4\u8BC1\uFF09\uFF0CCLI \u4EC5\u7BA1\u7406\u751F\u547D\u5468\u671F"
  ].join("\n");
}
async function openContext3(context, options) {
  const environment = await resolveEnvironment({
    environment: stringOption(options, "env"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  return { environment, client };
}
async function runShells(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(terminalUsage());
  const { environment, client } = await openContext3(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const shells = await client.terminals.shells(clientId);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(shells, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`\u53EF\u7528 Shell\uFF08${shells.length}\uFF09\uFF1A`);
  log(formatTable3(shells.map((shell) => ({
    id: shell.id,
    label: shell.label,
    kind: shell.kind,
    default: shell.isDefault ? "yes" : "-"
  })), ["id", "label", "kind", "default"]));
}
async function runNew2(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "shell", "cols", "rows"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(terminalUsage());
  const { environment, client } = await openContext3(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const log = context.log ?? console.log;
  const shells = await client.terminals.shells(clientId);
  const shellOption = stringOption(options, "shell");
  const shell = shells.find((item) => item.id === shellOption) ?? shells.find((item) => item.isDefault) ?? shells[0];
  if (!shell) {
    throw new Error("\u76EE\u6807\u673A\u672A\u62A5\u544A\u53EF\u7528 Shell\uFF0C\u65E0\u6CD5\u521B\u5EFA\u7EC8\u7AEF\u4F1A\u8BDD");
  }
  const cols = parseTerminalSize(stringOption(options, "cols"), "--cols", 120);
  const rows = parseTerminalSize(stringOption(options, "rows"), "--rows", 30);
  const created = await client.terminals.create(clientId, {
    shellId: shell.id,
    cols,
    rows
  });
  if (options.json === true) {
    log(JSON.stringify(created, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u5DF2\u521B\u5EFA\u7EC8\u7AEF\u4F1A\u8BDD ${created.sessionId}
\uFF08${created.shellLabel ?? shell.label ?? shell.id}\uFF0C${cols}x${rows}\uFF09`);
  log(`[vcpdeck] \u8FDE\u63A5: vcpdeck terminal attach ${clientFilter} ${created.sessionId}`);
}
function parseTerminalSize(raw, flag, fallback) {
  if (raw === void 0)
    return fallback;
  const value2 = Number(raw);
  if (!Number.isInteger(value2) || value2 < 2 || value2 > 500) {
    throw new Error(`${flag} \u5FC5\u987B\u662F 2-500 \u7684\u6574\u6570`);
  }
  return value2;
}
async function runList2(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "status"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(terminalUsage());
  const { environment, client } = await openContext3(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const result = await client.terminals.list(clientId, { pageSize: 100 });
  const statusFilter = stringOption(options, "status")?.toLowerCase();
  const sessions = statusFilter ? result.data.filter((s) => s.status.toLowerCase() === statusFilter) : result.data;
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(sessions, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  if (sessions.length === 0) {
    log("\u5F53\u524D\u8FC7\u6EE4\u6761\u4EF6\u4E0B\u6CA1\u6709\u7EC8\u7AEF\u4F1A\u8BDD\u3002");
    return;
  }
  log(`\u7EC8\u7AEF\u4F1A\u8BDD\uFF08${sessions.length}\uFF09\uFF1A`);
  log(formatTable3(sessions.map((session) => ({
    sessionId: session.sessionId,
    shell: session.shellLabel,
    status: session.status,
    creator: session.createdByName ?? "-",
    created: session.createdAt,
    endReason: session.endReason ?? "-"
  })), ["sessionId", "shell", "status", "creator", "created", "endReason"]));
}
async function runClose(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  const [clientFilter, sessionId] = positionals;
  if (!clientFilter || !sessionId || positionals.length > 2) {
    throw new Error(terminalUsage());
  }
  const { environment, client } = await openContext3(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const session = await client.terminals.get(clientId, sessionId);
  const log = context.log ?? console.log;
  if (options.json !== true)
    log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u5173\u95ED ${clientFilter} \u7684\u7EC8\u7AEF\u4F1A\u8BDD ${sessionId}${session?.shellLabel ? `\uFF08${session.shellLabel}${session.createdByName ? `\uFF0C\u521B\u5EFA\u8005 ${session.createdByName}` : ""}\uFF09` : ""}`);
  await client.terminals.remove(clientId, sessionId);
  if (options.json === true) {
    log(JSON.stringify({ sessionId, closed: true }, null, 2));
    return;
  }
  log(`[vcpdeck] \u7EC8\u7AEF\u4F1A\u8BDD ${sessionId} \u5DF2\u5173\u95ED`);
}
async function runAttach(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  const [clientFilter, sessionId] = positionals;
  if (!clientFilter || !sessionId || positionals.length > 2) {
    throw new Error(terminalUsage());
  }
  const environment = await resolveEnvironment({
    environment: stringOption(options, "env"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const credentials = environment.credentials;
  if (!credentials || credentials.type !== "bearer") {
    throw new Error("terminal attach \u9700\u8981 Bearer \u73AF\u5883\uFF08env add --token-env=...\uFF09\uFF1B\u5BC6\u7801\u73AF\u5883\u6682\u4E0D\u652F\u6301");
  }
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const info = await client.terminals.get(clientId, sessionId);
  const log = context.log ?? console.log;
  log(`[vcpdeck] attach ${clientFilter} \u4F1A\u8BDD ${sessionId}\uFF08${info?.shellLabel ?? "?"}, status=${info?.status ?? "?"}\uFF09\uFF1BCtrl+Q \u9000\u51FA`);
  const storePath = reconnectStorePath(context);
  const reconnectToken = await loadReconnectToken(storePath, sessionId);
  const stdout = context.stdout ?? process.stdout;
  const stdin = context.input ?? process.stdin;
  const socketFactory = context.socketFactory ?? ((url2, auth) => lookup(url2, { auth, transports: ["websocket"] }));
  const socket = socketFactory(`${environment.server}/app`, {
    token: credentials.token
  });
  let attachmentId = null;
  let closed = false;
  const exitCode = 0;
  const rawStdin = stdin;
  const cleanup = () => {
    if (closed)
      return;
    closed = true;
    rawStdin.setRawMode?.(false);
    stdin.pause();
    socket.disconnect();
  };
  socket.on("connect_error", (payload) => {
    const err = payload;
    cleanup();
    process.exitCode = 1;
    log(`[vcpdeck] \u8FDE\u63A5\u5931\u8D25: ${err.message}`);
  });
  socket.on(import_shared6.Events.TERMINAL_OUTPUT, (payload) => {
    const chunk = payload;
    if (!chunk || typeof chunk.data !== "string")
      return;
    stdout.write(chunk.data);
    socket.emit(import_shared6.Events.TERMINAL_ACK_OUTPUT, {
      sessionId,
      attachmentId,
      seq: chunk.seq
    });
  });
  socket.on(import_shared6.Events.TERMINAL_SNAPSHOT, (payload) => {
    const snapshot = payload;
    if (typeof snapshot?.data === "string")
      stdout.write(snapshot.data);
  });
  socket.on(import_shared6.Events.TERMINAL_EXIT, () => {
    log("\n[vcpdeck] \u4F1A\u8BDD\u5DF2\u7ED3\u675F");
    void removeReconnectToken(storePath, sessionId);
    cleanup();
  });
  socket.on("disconnect", () => {
    if (!closed)
      log("\n[vcpdeck] \u8FDE\u63A5\u5DF2\u65AD\u5F00");
  });
  socket.emit(import_shared6.Events.TERMINAL_ATTACH, reconnectToken ? { sessionId, reconnectToken } : { sessionId }, async (response) => {
    const ack = response;
    if (!ack?.ok) {
      cleanup();
      process.exitCode = 1;
      log(`[vcpdeck] attach \u5931\u8D25: ${ack?.error?.message ?? "\u672A\u77E5\u9519\u8BEF"}`);
      return;
    }
    attachmentId = ack.data?.attachmentId ?? null;
    if (ack.data?.reconnectToken) {
      await saveReconnectToken(storePath, sessionId, ack.data.reconnectToken);
    }
    rawStdin.setRawMode?.(true);
    stdin.resume();
    const sendResize = () => {
      if (closed || !attachmentId)
        return;
      socket.emit(import_shared6.Events.TERMINAL_RESIZE, {
        sessionId,
        attachmentId,
        cols: stdout.columns ?? 80,
        rows: stdout.rows ?? 24
      });
    };
    sendResize();
    stdout.on?.("resize", sendResize);
    stdin.on("data", (buf) => {
      if (closed)
        return;
      if (buf.includes(17)) {
        socket.emit(import_shared6.Events.TERMINAL_DETACH, { sessionId, attachmentId });
        cleanup();
        log("\n[vcpdeck] \u5DF2\u9000\u51FA attach");
        return;
      }
      socket.emit(import_shared6.Events.TERMINAL_INPUT, {
        sessionId,
        attachmentId,
        data: buf.toString("latin1")
      });
    });
  });
}
function reconnectStorePath(context) {
  const globalConfigPath = context.paths?.globalConfigPath ?? (0, import_node_path2.join)((0, import_node_os2.homedir)(), ".vcpdeck", "cli", "config.json");
  return (0, import_node_path2.join)((0, import_node_path2.dirname)(globalConfigPath), "terminal-reconnect.json");
}
async function loadReconnectToken(storePath, sessionId) {
  try {
    const store = JSON.parse(await (0, import_promises5.readFile)(storePath, "utf8"));
    return store[sessionId];
  } catch {
    return void 0;
  }
}
async function saveReconnectToken(storePath, sessionId, token) {
  let store = {};
  try {
    store = JSON.parse(await (0, import_promises5.readFile)(storePath, "utf8"));
  } catch {
  }
  store[sessionId] = token;
  await (0, import_promises5.writeFile)(storePath, JSON.stringify(store, null, 2));
}
async function removeReconnectToken(storePath, sessionId) {
  try {
    const store = JSON.parse(await (0, import_promises5.readFile)(storePath, "utf8"));
    if (!(sessionId in store))
      return;
    delete store[sessionId];
    await (0, import_promises5.writeFile)(storePath, JSON.stringify(store, null, 2));
  } catch {
  }
}
var import_shared6, import_promises5, import_node_os2, import_node_path2;
var init_terminal_command = __esm({
  "dist/terminal-command.js"() {
    "use strict";
    init_esm_debug3();
    import_shared6 = __toESM(require_dist(), 1);
    import_promises5 = require("node:fs/promises");
    import_node_os2 = require("node:os");
    import_node_path2 = require("node:path");
    init_authenticated_client();
    init_arguments();
    init_client_resolver();
    init_environment();
    init_table();
  }
});

// dist/completions-command.js
var completions_command_exports = {};
__export(completions_command_exports, {
  runCompletionsCommand: () => runCompletionsCommand
});
function completionsUsage() {
  return [
    "\u7528\u6CD5:",
    "  vcpdeck completions bash        # \u8F93\u51FA Bash \u8865\u5168\u811A\u672C\uFF08Git Bash\uFF09",
    "  vcpdeck completions powershell  # \u8F93\u51FA PowerShell \u8865\u5168\u811A\u672C",
    "",
    "\u542F\u7528\u65B9\u5F0F\u89C1\u8F93\u51FA\u5934\u90E8\u6CE8\u91CA\uFF1B\u73AF\u5883\u589E\u5220\u540E\u8BF7\u91CD\u65B0\u751F\u6210\u3002"
  ].join("\n");
}
async function resolveEnvironmentNames(paths) {
  try {
    const config = await loadCliConfig(paths.globalConfigPath);
    return Object.keys(config.environments ?? {}).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
function generateBash(envNames) {
  const envList = envNames.join(" ");
  const prefixed = envNames.map((n) => `--env=${n}`).join(" ");
  const caseBranches = Object.entries(COMMAND_TREE).map(([cmd, subs]) => `		${cmd}) subs="${subs.join(" ")}";;`).join("\n");
  return `# vcpdeck Bash \u8865\u5168\uFF08\u7531 vcpdeck completions bash \u751F\u6210\uFF1B\u73AF\u5883\u53D8\u66F4\u540E\u8BF7\u91CD\u65B0\u751F\u6210\uFF09
# \u542F\u7528\uFF1A\u628A\u4E0B\u9762\u6574\u6BB5\u8FFD\u52A0\u5230 ~/.bashrc \u540E source ~/.bashrc\uFF08\u6216\u5F00\u65B0\u7EC8\u7AEF\uFF09
_vcpdeck() {
	local cur cmd subs
	cur="\${COMP_WORDS[COMP_CWORD]}"
	if [ "\${COMP_WORDS[1]}" ] && [ "\${COMP_CWORD}" -ge 2 ]; then :; fi
	cmd="\${COMP_WORDS[1]}"
	case "\${COMP_WORDS[COMP_CWORD-1]}" in
		--env) COMPREPLY=( $(compgen -W "${envList}" -- "$cur") ); return 0 ;;
	esac
	if [[ "$cur" == --env=* ]]; then
		COMPREPLY=( $(compgen -W "${prefixed}" -- "$cur") ); return 0
	fi
	if [[ "$cur" == -* ]]; then
		COMPREPLY=( $(compgen -W "${COMMON_FLAGS.join(" ")}" -- "$cur") ); return 0
	fi
	if [ "$COMP_CWORD" -eq 1 ]; then
		COMPREPLY=( $(compgen -W "${TOP_LEVEL.join(" ")} --version" -- "$cur") ); return 0
	fi
	subs=""
	case "$cmd" in
${caseBranches}
	esac
	COMPREPLY=( $(compgen -W "$subs" -- "$cur") )
}
complete -F _vcpdeck vcpdeck
`;
}
function generatePowerShell(envNames) {
  const envArray = envNames.map((n) => `'${n}'`).join(",");
  const subPairs = Object.entries(COMMAND_TREE).map(([cmd, subs]) => `	'${cmd}' = @('${subs.join("','")}');`).join("\n");
  return `# vcpdeck PowerShell \u8865\u5168\uFF08\u7531 vcpdeck completions powershell \u751F\u6210\uFF1B\u73AF\u5883\u53D8\u66F4\u540E\u8BF7\u91CD\u65B0\u751F\u6210\uFF09
# \u542F\u7528\uFF1A\u628A\u4E0B\u9762\u6574\u6BB5\u8FFD\u52A0\u5230 $PROFILE \u540E\u91CD\u5F00\u7EC8\u7AEF\uFF08. \u6216\u6267\u884C\u8BE5\u6587\u4EF6\u4E00\u6B21\u4EA6\u53EF\uFF09
Register-ArgumentCompleter -CommandName vcpdeck -Native -ScriptBlock {
	param($wordToComplete, $commandAst)
	$envNames = @(${envArray})
	$subCommands = @{
${subPairs}
	}
	$topLevel = @('${TOP_LEVEL.join("','")}')
	$args_ = @($commandAst.CommandElements | Select-Object -Skip 1)
	$candidates = @()
	if ($args_.Count -le 1) {
		$candidates = $topLevel + @('--version')
	} elseif ($subCommands.ContainsKey([string]$args_[0])) {
		$candidates = $subCommands[[string]$args_[0]]
	}
	if ($wordToComplete -like '--env=*') {
		$candidates = @($envNames | ForEach-Object { "--env=$_" })
	} else {
		$candidates += @('${COMMON_FLAGS.join("','")}')
	}
	$candidates |
		Where-Object { $_ -like "$wordToComplete*" } |
		ForEach-Object {
			[System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
		}
}
`;
}
async function runCompletionsCommand(subcommand, context = {}) {
  const log = context.log ?? console.log;
  const paths = context.paths ?? {
    globalConfigPath: (0, import_node_path3.join)((0, import_node_os3.homedir)(), ".vcpdeck", "cli", "config.json"),
    cwd: process.cwd()
  };
  if (subcommand === void 0 || subcommand === "--help" || subcommand === "-h") {
    log(completionsUsage());
    return;
  }
  if (subcommand !== "bash" && subcommand !== "powershell") {
    throw new Error(`\u672A\u77E5\u8865\u5168\u7C7B\u578B: ${subcommand}

${completionsUsage()}`);
  }
  const envNames = await resolveEnvironmentNames(paths);
  log(subcommand === "bash" ? generateBash(envNames) : generatePowerShell(envNames));
}
var import_node_os3, import_node_path3, COMMAND_TREE, TOP_LEVEL, COMMON_FLAGS;
var init_completions_command = __esm({
  "dist/completions-command.js"() {
    "use strict";
    import_node_os3 = require("node:os");
    import_node_path3 = require("node:path");
    init_config();
    COMMAND_TREE = {
      env: ["list", "show", "current", "check", "add", "remove", "use"],
      clients: ["list"],
      jobs: ["list", "get", "run", "cancel"],
      files: [
        "roots",
        "list",
        "stat",
        "read",
        "write",
        "mkdir",
        "delete",
        "move",
        "download",
        "upload"
      ],
      pi: ["models", "sessions", "new", "run", "attach", "abort"],
      terminal: ["shells", "list", "close", "attach"],
      frp: ["instances", "mappings", "mapping"],
      storage: ["status"],
      release: ["status", "wait", "upload"],
      completions: ["bash", "powershell"]
    };
    TOP_LEVEL = [...Object.keys(COMMAND_TREE), "help"];
    COMMON_FLAGS = ["--json", "--env=", "--help"];
  }
});

// dist/index.js
var index_exports = {};
__export(index_exports, {
  helpText: () => helpText,
  run: () => run
});
module.exports = __toCommonJS(index_exports);
var import_shared7 = __toESM(require_dist(), 1);

// dist/env-command.js
init_authenticated_client();
init_config();
init_arguments();
init_environment();
async function runEnvCommand(subcommand, argv, context = {}) {
  const paths = context.paths ?? defaultConfigPaths();
  const log = context.log ?? console.log;
  switch (subcommand) {
    case "list":
      await listEnvironments(argv, paths, log);
      return;
    case "show":
      await showEnvironment(argv, paths, log);
      return;
    case "current":
      await showCurrent(argv, paths, context.processEnv ?? process.env, log);
      return;
    case "check":
      await checkEnvironment(argv, paths, context.processEnv ?? process.env, log);
      return;
    case "add":
      await addEnvironment(argv, paths, log);
      return;
    case "remove":
      await removeEnvironment(argv, paths, log);
      return;
    case "use":
      await useEnvironment(argv, paths, log);
      return;
    default:
      throw new Error(envUsage());
  }
}
function envUsage() {
  return [
    "\u73AF\u5883\u547D\u4EE4:",
    "  vcpdeck env list",
    "  vcpdeck env show <name>",
    "  vcpdeck env current [--env=<name>] [--server=<url>]",
    "  vcpdeck env check [--env=<name>]",
    "  vcpdeck env add <name> --server=<url> --token-env=<VAR>",
    "  \u517C\u5BB9\u5BC6\u7801: ... --auth=password --username=<name> --password-env=<VAR>",
    "  vcpdeck env remove <name>",
    "  vcpdeck env use <name> --global|--local"
  ].join("\n");
}
async function listEnvironments(argv, paths, log) {
  assertNoArgs(argv);
  const config = await loadCliConfig(paths.globalConfigPath);
  const names = Object.keys(config.environments).sort((left, right) => left.localeCompare(right, "en"));
  if (!names.length) {
    log("\u5C1A\u672A\u914D\u7F6E\u73AF\u5883");
    return;
  }
  for (const name of names) {
    const environment = config.environments[name];
    const marker = config.defaultEnvironment === name ? "*" : " ";
    log(`${marker} ${name}	${environment.server}	${authSummary(environment)}`);
  }
}
async function showEnvironment(argv, paths, log) {
  const { positionals } = parseCommandArgs(argv);
  if (positionals.length !== 1)
    throw new Error("\u7528\u6CD5: vcpdeck env show <name>");
  const config = await loadCliConfig(paths.globalConfigPath);
  const name = positionals[0];
  const environment = ownEnvironment(config.environments, name);
  if (!environment)
    throw new Error(`\u73AF\u5883\u4E0D\u5B58\u5728: ${name}`);
  log(`\u73AF\u5883: ${name}`);
  log(`Server: ${environment.server}`);
  log(`\u8BA4\u8BC1: ${authSummary(environment)}`);
  log(`\u5168\u5C40\u9ED8\u8BA4: ${config.defaultEnvironment === name ? "\u662F" : "\u5426"}`);
  log(`\u914D\u7F6E: ${paths.globalConfigPath}`);
}
async function showCurrent(argv, paths, processEnv, log) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "server", "username"]
  });
  if (positionals.length)
    throw new Error("env current \u4E0D\u63A5\u53D7\u4F4D\u7F6E\u53C2\u6570");
  const env = exclusiveAlias(options, "env", "environment");
  const resolved = await resolveEnvironment({
    environment: env,
    server: stringOption(options, "server"),
    username: stringOption(options, "username"),
    requireCredentials: false,
    paths,
    processEnv
  });
  log(formatEnvironmentSummary(resolved));
}
async function checkEnvironment(argv, paths, processEnv, log) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"]
  });
  if (positionals.length)
    throw new Error("env check \u4E0D\u63A5\u53D7\u4F4D\u7F6E\u53C2\u6570");
  const environment = await resolveEnvironment({
    environment: exclusiveAlias(options, "env", "environment"),
    paths,
    processEnv
  });
  log(formatEnvironmentSummary(environment));
  const client = await createAuthenticatedClient(environment);
  const identity = await client.auth.me();
  log(`\u8EAB\u4EFD: ${identity.username} (${identity.displayName})${identity.isAdmin ? " [admin]" : ""}`);
}
async function addEnvironment(argv, paths, log) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["server", "auth", "username", "password-env", "token-env"]
  });
  if (positionals.length !== 1) {
    throw new Error("\u7528\u6CD5: vcpdeck env add <name> --server=... --auth=password|bearer ...");
  }
  const name = positionals[0];
  assertEnvironmentName(name);
  const server = requiredOption(options, "server");
  const auth = stringOption(options, "auth") ?? (stringOption(options, "token-env") ? "bearer" : void 0);
  if (!auth) {
    throw new Error("\u7F3A\u5C11 --token-env\uFF08\u63A8\u8350\uFF09\u6216 --auth=password \u8BA4\u8BC1\u53C2\u6570");
  }
  const environment = buildEnvironment(server, auth, options);
  const config = await loadCliConfig(paths.globalConfigPath);
  if (ownEnvironment(config.environments, name)) {
    throw new Error(`\u73AF\u5883\u5DF2\u5B58\u5728: ${name}`);
  }
  config.environments[name] = environment;
  await saveCliConfig(paths.globalConfigPath, config);
  log(`\u5DF2\u6DFB\u52A0\u73AF\u5883 ${name}`);
  log(`Server: ${environment.server}`);
  log(`\u8BA4\u8BC1: ${authSummary(environment)}`);
  log(`\u914D\u7F6E: ${paths.globalConfigPath}`);
}
async function removeEnvironment(argv, paths, log) {
  const { positionals } = parseCommandArgs(argv);
  if (positionals.length !== 1)
    throw new Error("\u7528\u6CD5: vcpdeck env remove <name>");
  const name = positionals[0];
  const config = await loadCliConfig(paths.globalConfigPath);
  if (!ownEnvironment(config.environments, name)) {
    throw new Error(`\u73AF\u5883\u4E0D\u5B58\u5728: ${name}`);
  }
  const environments = Object.fromEntries(Object.entries(config.environments).filter(([key]) => key !== name));
  await saveCliConfig(paths.globalConfigPath, {
    version: 1,
    environments,
    ...config.defaultEnvironment && config.defaultEnvironment !== name ? { defaultEnvironment: config.defaultEnvironment } : {}
  });
  log(`\u5DF2\u5220\u9664\u73AF\u5883 ${name}`);
}
async function useEnvironment(argv, paths, log) {
  const { positionals, options } = parseCommandArgs(argv, {
    boolean: ["global", "local"]
  });
  if (positionals.length !== 1 || Boolean(options.global) === Boolean(options.local)) {
    throw new Error("\u7528\u6CD5: vcpdeck env use <name> --global|--local");
  }
  const name = positionals[0];
  const config = await loadCliConfig(paths.globalConfigPath);
  if (!ownEnvironment(config.environments, name)) {
    throw new Error(`\u73AF\u5883\u4E0D\u5B58\u5728: ${name}`);
  }
  if (options.global) {
    config.defaultEnvironment = name;
    await saveCliConfig(paths.globalConfigPath, config);
    log(`\u5DF2\u5C06 ${name} \u8BBE\u4E3A\u5168\u5C40\u9ED8\u8BA4\u73AF\u5883`);
    return;
  }
  const target = await localProjectConfigTarget(paths.cwd);
  await saveProjectConfig(target, { version: 1, environment: name });
  log(`\u5DF2\u5C06 ${name} \u8BBE\u4E3A\u9879\u76EE\u9ED8\u8BA4\u73AF\u5883`);
  log(`\u914D\u7F6E: ${target}`);
}
function buildEnvironment(serverValue, authType, options) {
  const server = normalizeServerUrl(serverValue);
  if (authType === "password") {
    if (options["token-env"] !== void 0) {
      throw new Error("password \u8BA4\u8BC1\u4E0D\u63A5\u53D7 --token-env");
    }
    const username = requiredOption(options, "username");
    const passwordEnv = requiredOption(options, "password-env");
    assertEnvironmentVariableName(passwordEnv);
    return {
      server,
      auth: { type: "password", username, passwordEnv }
    };
  }
  if (authType === "bearer") {
    if (options.username !== void 0 || options["password-env"] !== void 0) {
      throw new Error("bearer \u8BA4\u8BC1\u4E0D\u63A5\u53D7 --username/--password-env");
    }
    const tokenEnv = requiredOption(options, "token-env");
    assertEnvironmentVariableName(tokenEnv);
    return {
      server,
      auth: { type: "bearer", tokenEnv }
    };
  }
  throw new Error("--auth \u5FC5\u987B\u4E3A password \u6216 bearer");
}
function ownEnvironment(environments, name) {
  return Object.hasOwn(environments, name) ? environments[name] : void 0;
}
function authSummary(environment) {
  return environment.auth.type === "password" ? `password (${environment.auth.username}, ${environment.auth.passwordEnv})` : `bearer (${environment.auth.tokenEnv})`;
}
function requiredOption(options, name) {
  const value2 = stringOption(options, name);
  if (!value2)
    throw new Error(`\u7F3A\u5C11 --${name}`);
  return value2;
}
function exclusiveAlias(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
function assertNoArgs(argv) {
  if (argv.length)
    throw new Error("\u8BE5\u547D\u4EE4\u4E0D\u63A5\u53D7\u53C2\u6570");
}

// dist/files-command.js
var import_node_fs2 = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_crypto = require("node:crypto");
var import_promises3 = require("node:stream/promises");
var import_node_stream = require("node:stream");
var import_shared4 = __toESM(require_dist(), 1);
init_authenticated_client();
init_arguments();
init_client_resolver();
init_environment();

// dist/jobs-command.js
var import_shared3 = __toESM(require_dist(), 1);
init_dist();
init_authenticated_client();
init_arguments();
init_client_resolver();
init_environment();
var STATUS_FILTERS = /* @__PURE__ */ new Set([...Object.values(import_shared3.JobStatus), "active"]);
var DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
var POLL_INTERVAL_MS = 2e3;
var TERMINAL_STATUSES2 = /* @__PURE__ */ new Set([
  import_shared3.JobStatus.DONE,
  import_shared3.JobStatus.ERROR,
  import_shared3.JobStatus.CANCELLED,
  import_shared3.JobStatus.DISCONNECTED
]);
async function runJobsCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "list" || subcommand === "get" || subcommand === "run" || subcommand === "cancel" || subcommand === void 0) && hasHelp(argv);
  if (helpRequested) {
    (context.log ?? console.log)(jobsUsage());
    return;
  }
  if (subcommand === "list") {
    await runListJobs(argv, context);
    return;
  }
  if (subcommand === "get") {
    await runGetJob(argv, context);
    return;
  }
  if (subcommand === "run") {
    await runExecJob(argv, context);
    return;
  }
  if (subcommand === "cancel") {
    await runCancelJob(argv, context);
    return;
  }
  throw new Error(jobsUsage());
}
function hasHelp(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function jobsUsage() {
  return [
    "Jobs \u547D\u4EE4:",
    "  vcpdeck jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck jobs get <jobId> [--env=<name>] [--json]  # \u542B\u5931\u8D25\u73B0\u573A\uFF08stdout/stderr spool\uFF09",
    "  vcpdeck jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>",
    "  # \u5199\u64CD\u4F5C\uFF1A\u547D\u4EE4 token \u4EE5\u7A7A\u683C\u8FDE\u63A5\u540E\u4EA4\u7531\u76EE\u6807\u673A shell \u6267\u884C\uFF1B\u786E\u8BA4\u95E8\u7531\u8C03\u7528\u65B9\u8D1F\u8D23",
    "  vcpdeck jobs cancel <jobId> [--env=<name>] [--json]"
  ].join("\n");
}
function parseListArgs(argv) {
  return parseCommandArgs(argv, {
    value: ["env", "environment", "client", "status", "page"],
    boolean: ["json"]
  });
}
async function runListJobs(argv, context) {
  const { positionals, options } = parseListArgs(argv);
  if (positionals.length > 0)
    throw new Error(jobsUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias2(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const status = requireValidStatus(stringOption(options, "status"));
  const page = parsePage(stringOption(options, "page"));
  const clientFilter = stringOption(options, "client");
  const log = context.log ?? console.log;
  const client = await createAuthenticatedClient(environment);
  const clientId = clientFilter ? await resolveClientId(clientFilter, context.paths, context.processEnv) : void 0;
  const result = await client.jobs.list({ clientId, status, page });
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(formatJobsList(result));
}
async function runGetJob(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  if (positionals.length !== 1)
    throw new Error(jobsUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias2(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const log = context.log ?? console.log;
  const client = await createAuthenticatedClient(environment);
  const jobId = positionals[0];
  const job = await client.jobs.get(jobId);
  const { output } = await client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`);
  if (options.json === true) {
    log(JSON.stringify({ ...job, output }, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(formatJobDetail(job, output));
}
async function runExecJob(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "cwd", "timeout", "wait-timeout"],
    boolean: ["json", "wait"]
  });
  const [clientFilter, ...commandTokens] = positionals;
  if (!clientFilter || commandTokens.length === 0) {
    throw new Error(jobsUsage());
  }
  const environment = await resolveEnvironment({
    environment: exclusiveAlias2(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const timeout = parsePositiveSeconds(stringOption(options, "timeout"), "--timeout");
  const waitTimeout = parsePositiveSeconds(stringOption(options, "wait-timeout"), "--wait-timeout") ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
  const log = context.log ?? console.log;
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const payload = {
    mode: "command",
    command: commandTokens.join(" ")
  };
  const cwd = stringOption(options, "cwd");
  if (cwd)
    payload.cwd = cwd;
  if (!cwd && commandTokens.some((token) => token.includes(" "))) {
    log("[vcpdeck] \u6CE8\u610F\uFF1A\u542B\u7A7A\u683C\u7684 token \u8FDE\u63A5\u540E\u5F15\u53F7\u8FB9\u754C\u53EF\u80FD\u4E22\u5931\uFF0C\u8BF7\u6838\u5BF9\u547D\u4EE4\u8BED\u4E49");
  }
  if (options.json !== true) {
    log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] \u5728 ${clientFilter} \u4E0A\u6267\u884C: ${payload.command}`);
  }
  const created = await client.jobs.create({
    clientId,
    type: "exec",
    payload,
    timeout
  });
  if (options.wait !== true) {
    if (options.json === true) {
      log(JSON.stringify(created, null, 2));
    } else {
      log(`[vcpdeck] Job \u5DF2\u521B\u5EFA: ${created.jobId}\uFF08${created.status}\uFF09\uFF1B\u7528 jobs get ${created.jobId} \u67E5\u8BE2\u7ED3\u679C\uFF0C\u6216\u52A0 --wait \u76F4\u63A5\u7B49\u5F85\u7EC8\u6001`);
    }
    return;
  }
  const job = await waitForTerminalJob(client, created.jobId, waitTimeout, log, context.pollIntervalMs ?? POLL_INTERVAL_MS);
  const output = await readJobOutputText(client, job.jobId).catch(() => null);
  if (options.json === true) {
    log(JSON.stringify({ ...job, output }, null, 2));
  }
  if (job.status !== import_shared3.JobStatus.DONE) {
    if (options.json !== true)
      log(formatJobDetail(job, output));
    throw new Error(`Job ${job.jobId} \u7EC8\u6001\u4E3A ${job.status}`);
  }
  if (options.json !== true)
    log(formatJobDetail(job, output));
}
async function waitForTerminalJob(client, jobId, timeoutSeconds, log, pollIntervalMs) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const job = await client.jobs.get(jobId);
      if (TERMINAL_STATUSES2.has(job.status))
        return job;
      if (job.status !== lastStatus) {
        log(`[vcpdeck] Job ${jobId} \u72B6\u6001: ${job.status}`);
        lastStatus = job.status;
      }
    } catch (error) {
      if (!isTransientReadError(error))
        throw error;
      log("[vcpdeck] Server \u6682\u65F6\u4E0D\u53EF\u8FBE\uFF0C\u7EE7\u7EED\u7B49\u5F85\u2026");
    }
    await sleep2(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`\u7B49\u5F85 Job ${jobId} \u7EC8\u6001\u8D85\u65F6\uFF08${timeoutSeconds} \u79D2\uFF09\uFF1B\u7528 jobs get ${jobId} \u67E5\u8BE2\u5F53\u524D\u72B6\u6001`);
}
async function readJobOutputText(client, jobId) {
  const { output } = await client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/output`);
  return output;
}
async function runCancelJob(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  if (positionals.length !== 1)
    throw new Error(jobsUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias2(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const log = context.log ?? console.log;
  const client = await createAuthenticatedClient(environment);
  const result = await client.jobs.cancel(positionals[0]);
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] Job ${result.jobId} \u53D6\u6D88\u8BF7\u6C42\u5DF2\u63D0\u4EA4\uFF0C\u5F53\u524D\u72B6\u6001: ${result.status}${result.status === "cancelling" ? "\uFF08\u7B49\u5F85 Client \u786E\u8BA4\uFF0C\u7EC8\u6001\u7528 jobs get \u6838\u5BF9\uFF09" : ""}`);
}
function formatJobsList(result) {
  const sorted = [...result.data].sort((a, b) => {
    const active = (job) => job.status === import_shared3.JobStatus.RUNNING || job.status === import_shared3.JobStatus.PENDING || job.status === import_shared3.JobStatus.WAITING_INPUT ? 0 : 1;
    const byActive = active(a) - active(b);
    if (byActive !== 0)
      return byActive;
    return b.createdAt.localeCompare(a.createdAt);
  });
  const rows = sorted.map((job) => ({
    jobId: job.jobId,
    client: job.clientName ?? job.clientId,
    type: job.type,
    status: job.status,
    error: job.errorCode ?? "-",
    created: job.createdAt
  }));
  const body = rows.length === 0 ? ["\u5F53\u524D\u8FC7\u6EE4\u6761\u4EF6\u4E0B\u6CA1\u6709 Job\u3002"] : [
    formatTable(rows, [
      "jobId",
      "client",
      "type",
      "status",
      "error",
      "created"
    ])
  ];
  return [
    `\u5171 ${result.total} \u6761 \xB7 \u7B2C ${result.page}/${result.totalPages} \u9875`,
    ...body
  ].join("\n");
}
function formatJobDetail(job, output) {
  const lines = [
    `Job: ${job.jobId}`,
    `Client: ${job.clientName ?? job.clientId}`,
    `Type: ${job.type}`,
    `Status: ${job.status}`
  ];
  if (job.errorCode || job.errorMessage) {
    lines.push(`Error: ${job.errorCode ?? "-"}${job.errorMessage ? ` \u2014 ${job.errorMessage}` : ""}`);
  }
  lines.push(`Created: ${job.createdAt}`);
  if (job.startedAt)
    lines.push(`Started: ${job.startedAt}`);
  if (job.finishedAt)
    lines.push(`Finished: ${job.finishedAt}`);
  if (job.createdByName || job.createdVia) {
    lines.push(`Creator: ${job.createdByName ?? "-"} (${job.createdVia ?? "-"})`);
  }
  if (job.result && Object.keys(job.result).length > 0) {
    lines.push(`Result: ${JSON.stringify(job.result)}`);
  }
  if (output === null) {
    lines.push("\uFF08\u65E0\u843D\u76D8\u8F93\u51FA\uFF09");
  } else {
    lines.push("\u2500\u2500 \u8F93\u51FA\uFF08stdout/stderr\uFF09\u2500\u2500", output.trimEnd());
  }
  return lines.join("\n");
}
function exclusiveAlias2(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
function requireValidStatus(raw) {
  if (raw === void 0)
    return void 0;
  if (!STATUS_FILTERS.has(raw)) {
    throw new Error(`--status \u5FC5\u987B\u662F ${[...STATUS_FILTERS].join("/")} \u4E4B\u4E00`);
  }
  return raw;
}
function parsePage(raw) {
  if (raw === void 0)
    return void 0;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("--page \u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570");
  }
  return page;
}
function parsePositiveSeconds(raw, flag) {
  if (raw === void 0)
    return void 0;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`${flag} \u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570\u79D2`);
  }
  return seconds;
}
function isTransientReadError(error) {
  if (error instanceof VcpDeckApiError) {
    return error.status === 0 || [502, 503, 504].includes(error.status);
  }
  return error instanceof Error && error.name === "AbortError";
}
function sleep2(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function formatTable(rows, columns) {
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(columns.map((column) => column.toUpperCase())),
    ...rows.map((row) => line(columns.map((column) => row[column])))
  ].join("\n");
}

// dist/files-command.js
var DEFAULT_WAIT_TIMEOUT_SECONDS2 = 120;
var POLL_INTERVAL_MS2 = 1e3;
async function runFilesCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "roots" || subcommand === "list" || subcommand === "stat" || subcommand === "read" || subcommand === "write" || subcommand === "mkdir" || subcommand === "delete" || subcommand === "move" || subcommand === "download" || subcommand === "upload" || subcommand === void 0) && hasHelp2(argv);
  if (helpRequested) {
    (context.log ?? console.log)(filesUsage());
    return;
  }
  if (subcommand === "roots") {
    await runRoots(argv, context);
    return;
  }
  if (subcommand === "list") {
    await runList(argv, context);
    return;
  }
  if (subcommand === "stat") {
    await runStat(argv, context);
    return;
  }
  if (subcommand === "read") {
    await runRead(argv, context);
    return;
  }
  if (subcommand === "write") {
    await runWrite(argv, context);
    return;
  }
  if (subcommand === "mkdir") {
    await runMkdir(argv, context);
    return;
  }
  if (subcommand === "delete") {
    await runDelete(argv, context);
    return;
  }
  if (subcommand === "move") {
    await runMove(argv, context);
    return;
  }
  if (subcommand === "download") {
    await runDownload(argv, context);
    return;
  }
  if (subcommand === "upload") {
    await runUpload(argv, context);
    return;
  }
  throw new Error(filesUsage());
}
function hasHelp2(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function filesUsage() {
  return [
    "Files \u547D\u4EE4:",
    "  \u53EA\u8BFB:",
    "  vcpdeck files roots <client> [--env=<name>] [--json]",
    "  vcpdeck files list <client> <path> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]",
    "  # \u7F3A\u7701 --root \u65F6\u81EA\u52A8\u63A2\u6D4B\uFF1A\u552F\u4E00\u6839\u76F4\u63A5\u4F7F\u7528\uFF0C\u591A\u6839\u8981\u6C42\u663E\u5F0F\u6307\u5B9A",
    "  \u5199\u64CD\u4F5C\uFF08\u8C03\u7528\u65B9\u987B\u5148\u53D6\u5F97\u7528\u6237\u786E\u8BA4\uFF09:",
    "  vcpdeck files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]  # \u8986\u76D6\u5199\uFF1B\u7F3A\u7701 --input \u65F6\u8BFB stdin",
    "  vcpdeck files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]  # \u9012\u5F52\u521B\u5EFA",
    "  vcpdeck files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]  # \u4E0D\u53EF\u6062\u590D",
    "  vcpdeck files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
    "  \u4F20\u8F93\uFF08\u8C03\u7528\u65B9\u987B\u5148\u53D6\u5F97\u7528\u6237\u786E\u8BA4\uFF1B\u5B57\u8282\u6D41\u8D70 Storage Provider \u76F4\u4F20\uFF0C\u4E0D\u7ECF Server \u4E2D\u8F6C\uFF09:",
    "  vcpdeck files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]"
  ].join("\n");
}
async function runFileJob(client, clientId, type, payload, context) {
  const created = await client.jobs.create({ clientId, type, payload });
  const job = await waitForTerminalJob(client, created.jobId, DEFAULT_WAIT_TIMEOUT_SECONDS2, () => {
  }, context.pollIntervalMs ?? POLL_INTERVAL_MS2);
  if (job.status !== import_shared4.JobStatus.DONE)
    throw formatFileJobFailure(job);
  return job.result;
}
function formatFileJobFailure(job) {
  const result = job.result ?? {};
  const code = job.errorCode ?? (typeof result.errorCode === "string" ? result.errorCode : null);
  const message = job.errorMessage ?? (typeof result.errorMessage === "string" ? result.errorMessage : null);
  return new Error(`\u6587\u4EF6\u64CD\u4F5C\u5931\u8D25\uFF08${job.status}${code ? `/${code}` : ""}\uFF09${message ? `\uFF1A${message}` : ""}`);
}
async function resolveRootDir(client, clientId, explicitRoot, context) {
  if (explicitRoot)
    return explicitRoot;
  const roots = await fetchRoots(client, clientId, context);
  if (roots.length === 1)
    return roots[0];
  if (roots.length === 0)
    throw new Error("\u76EE\u6807\u673A\u672A\u62A5\u544A\u53EF\u7528\u6839\u76EE\u5F55");
  throw new Error(`\u76EE\u6807\u673A\u6709\u591A\u4E2A\u53EF\u7528\u6839\uFF08${roots.join("\u3001")}\uFF09\uFF1B\u8BF7\u7528 --root=<dir> \u6307\u5B9A\u6388\u6743\u6839`);
}
async function fetchRoots(client, clientId, context) {
  const result = await runFileJob(client, clientId, "file.roots", {}, context);
  return Array.isArray(result?.roots) ? result.roots : [];
}
function parseMaxBytes(raw) {
  if (raw === void 0)
    return void 0;
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error("--max-bytes \u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570");
  }
  return bytes;
}
function parseFileArgs(argv, extraValueOptions = [], booleanOptions = [], requirePath = false) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", ...extraValueOptions],
    boolean: ["json", ...booleanOptions]
  });
  const [clientFilter, path] = positionals;
  if (!clientFilter || requirePath && !path)
    throw new Error(filesUsage());
  return { clientFilter, path, options };
}
async function openContext(context, options) {
  const environment = await resolveEnvironment({
    environment: exclusiveAlias3(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  return { environment, client };
}
async function runRoots(argv, context) {
  const { clientFilter, options } = parseFileArgs(argv, [], [], false);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const roots = await fetchRoots(client, clientId, context);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(roots, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`\u53EF\u7528\u6839\u76EE\u5F55\uFF08${roots.length}\uFF09\uFF1A`);
  for (const root of roots)
    log(`  ${root}`);
}
async function runList(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const entries = await runFileJob(client, clientId, "file.list", { rootDir, path }, context);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(entries, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(formatListing(rootDir, path, entries.entries));
}
function formatListing(rootDir, path, entries) {
  if (entries.length === 0)
    return `${joinDisplayPath(rootDir, path)}\uFF1A\u7A7A\u76EE\u5F55`;
  const sorted = [...entries].sort((a, b) => {
    if (a.kind !== b.kind)
      return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const dirCount = sorted.filter((entry) => entry.kind === "dir").length;
  const lines = sorted.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    size: entry.kind === "dir" ? "-" : String(entry.size),
    mtime: entry.mtime
  }));
  return [
    `${joinDisplayPath(rootDir, path)}\uFF1A\u5171 ${sorted.length} \u9879 \xB7 \u76EE\u5F55 ${dirCount} \xB7 \u6587\u4EF6 ${sorted.length - dirCount}`,
    formatTable2(lines, ["name", "kind", "size", "mtime"])
  ].join("\n");
}
function joinDisplayPath(rootDir, path) {
  return `${rootDir.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}
async function runStat(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const stat3 = await runFileJob(client, clientId, "file.stat", { rootDir, path }, context);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(stat3, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log([
    `Path: ${joinDisplayPath(rootDir, path)}`,
    `Kind: ${stat3.kind}`,
    `Size: ${stat3.size}`,
    `Mtime: ${stat3.mtime}`
  ].join("\n"));
}
async function runRead(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, ["max-bytes"], [], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const maxBytes = parseMaxBytes(stringOption(options, "max-bytes"));
  const result = await runFileJob(client, clientId, "file.readText", { rootDir, path, ...maxBytes === void 0 ? {} : { maxBytes } }, context);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(result, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`\u2500\u2500 ${joinDisplayPath(rootDir, path)}\uFF08${result.size} bytes\uFF09\u2500\u2500`);
  log(result.content.trimEnd());
}
function logChangeResult(log, action, displayPath, result, xtra) {
  log(`[vcpdeck] \u5DF2${action}: ${result.path ?? displayPath}${xtra ? `\uFF08${xtra}\uFF09` : ""}`);
}
async function readWriteContent(options) {
  const input = stringOption(options, "input");
  if (input)
    return (0, import_promises2.readFile)(input, "utf8");
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function runWrite(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, ["input"], [], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const content = await readWriteContent(options);
  const bytes = Buffer.byteLength(content, "utf8");
  const log = context.log ?? console.log;
  if (options.json !== true) {
    log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] \u5199\u5165 ${clientFilter}:${joinDisplayPath(rootDir, path)}\uFF08${bytes} bytes\uFF0C\u8986\u76D6\u5DF2\u6709\u6587\u4EF6\uFF09`);
  }
  const result = await runFileJob(client, clientId, "file.writeText", { rootDir, path, content }, context);
  if (options.json === true) {
    log(JSON.stringify({ ...result, bytes }, null, 2));
    return;
  }
  logChangeResult(log, "\u5199\u5165", joinDisplayPath(rootDir, path), result, `${bytes} bytes`);
}
async function runMkdir(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, [], [], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const log = context.log ?? console.log;
  if (options.json !== true)
    log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u521B\u5EFA\u76EE\u5F55 ${clientFilter}:${joinDisplayPath(rootDir, path)}\uFF08\u9012\u5F52\uFF09`);
  const result = await runFileJob(client, clientId, "file.mkdir", { rootDir, path }, context);
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  logChangeResult(log, "\u521B\u5EFA\u76EE\u5F55", joinDisplayPath(rootDir, path), result);
}
async function runDelete(argv, context) {
  const { clientFilter, path, options } = parseFileArgs(argv, [], ["recursive"], true);
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const recursive = options.recursive === true;
  const payload = { rootDir, path };
  if (recursive)
    payload.recursive = true;
  const log = context.log ?? console.log;
  if (options.json !== true)
    log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u5220\u9664 ${clientFilter}:${joinDisplayPath(rootDir, path)}${recursive ? "\uFF08\u9012\u5F52\u5220\u9664\u6574\u4E2A\u76EE\u5F55\u6811\uFF0C\u4E0D\u53EF\u6062\u590D\uFF09" : "\uFF08\u4E0D\u53EF\u6062\u590D\uFF09"}`);
  const result = await runFileJob(client, clientId, "file.delete", payload, context);
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  logChangeResult(log, "\u5220\u9664", joinDisplayPath(rootDir, path), result);
}
async function runMove(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root"],
    boolean: ["json", "overwrite"]
  });
  const [clientFilter, source, destination] = positionals;
  if (!clientFilter || !source || !destination)
    throw new Error(filesUsage());
  const { environment, client } = await openContext(context, options);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const overwrite = options.overwrite === true;
  const payload = { rootDir, source, destination };
  if (overwrite)
    payload.overwrite = true;
  const log = context.log ?? console.log;
  if (options.json !== true)
    log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u79FB\u52A8 ${clientFilter}:${joinDisplayPath(rootDir, source)} \u2192 ${joinDisplayPath(rootDir, destination)}${overwrite ? "\uFF08\u8986\u76D6\u76EE\u6807\uFF09" : ""}`);
  const result = await runFileJob(client, clientId, "file.move", payload, context);
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  logChangeResult(log, "\u79FB\u52A8", joinDisplayPath(rootDir, source), result);
}
async function runDownload(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root"],
    boolean: ["json"]
  });
  const [clientFilter, remotePath, localPath] = positionals;
  if (!clientFilter || !remotePath || !localPath) {
    throw new Error(filesUsage());
  }
  const environment = await resolveEnvironment({
    environment: exclusiveAlias3(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const log = context.log ?? console.log;
  if (options.json !== true) {
    log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] \u5BFC\u51FA ${clientFilter}:${joinDisplayPath(rootDir, remotePath)} \u2192 ${localPath}\uFF08Storage \u76F4\u4F20\u94FE\u8DEF\uFF09`);
  }
  const transfer = await runFileJob(client, clientId, "file.export", { rootDir, path: remotePath }, context);
  const token = await client.storage.createDownloadToken({ key: transfer.key });
  const actualSha256 = await fetchToFile(resolveServerUrl(environment.server, token.url), localPath, context);
  if (actualSha256 !== transfer.sha256) {
    await (0, import_promises2.unlink)(localPath).catch(() => {
    });
    throw new Error(`\u4E0B\u8F7D\u6587\u4EF6 SHA-256 \u4E0D\u4E00\u81F4\uFF08\u671F\u671B ${transfer.sha256}\uFF0C\u5B9E\u9645 ${actualSha256}\uFF09\uFF0C\u5DF2\u5220\u9664\u672C\u5730\u534A\u6210\u54C1`);
  }
  if (options.json === true) {
    log(JSON.stringify({ ...transfer, localPath }, null, 2));
    return;
  }
  log(`[vcpdeck] \u5DF2\u4E0B\u8F7D ${localPath}\uFF08${transfer.size} bytes\uFF0Csha256 \u6821\u9A8C\u901A\u8FC7\uFF09`);
}
async function fetchToFile(url2, localPath, context) {
  const fetcher = context.directFetch ?? globalThis.fetch;
  const response = await fetcher(url2);
  if (!response.ok || !response.body) {
    throw new Error(`\u6587\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF1AHTTP ${response.status}`);
  }
  const hash = (0, import_node_crypto.createHash)("sha256");
  await (0, import_promises3.pipeline)(import_node_stream.Readable.fromWeb(response.body), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk);
      yield chunk;
    }
  }, (0, import_node_fs2.createWriteStream)(localPath));
  return hash.digest("hex");
}
async function runUpload(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root"],
    boolean: ["json", "overwrite"]
  });
  const [clientFilter, localPath, remotePath] = positionals;
  if (!clientFilter || !localPath || !remotePath) {
    throw new Error(filesUsage());
  }
  const fileStat = await (0, import_promises2.stat)(localPath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(`\u672C\u5730\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u666E\u901A\u6587\u4EF6: ${localPath}`);
  }
  const size = fileStat.size;
  const filename = localPath.split(/[\\/]/).pop() ?? "upload.bin";
  const environment = await resolveEnvironment({
    environment: exclusiveAlias3(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientId(clientFilter, context.paths, context.processEnv);
  const rootDir = await resolveRootDir(client, clientId, stringOption(options, "root"), context);
  const overwrite = options.overwrite === true;
  const log = context.log ?? console.log;
  const progressLog = options.json === true ? () => {
  } : log;
  if (options.json !== true) {
    log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] \u4E0A\u4F20 ${localPath} \u2192 ${clientFilter}:${joinDisplayPath(rootDir, remotePath)}\uFF08${size} bytes\uFF0CStorage \u76F4\u4F20\u94FE\u8DEF\uFF09`);
  }
  const session = await client.files.createUploadSession({
    clientId,
    rootDir,
    targetPath: remotePath,
    filename,
    size,
    ...overwrite ? { overwrite: true } : {}
  });
  progressLog(`[vcpdeck] \u4E0A\u4F20\u6A21\u5F0F: ${session.upload.kind}`);
  await uploadToTarget(client, localPath, size, session.upload, environment.server, session.jobId, progressLog, context);
  const created = await client.files.completeUpload(session.jobId, {
    uploadedBytes: size
  });
  progressLog(`[vcpdeck] \u5BFC\u5165 Job: ${created.jobId}\uFF08${created.status}\uFF09\uFF0C\u7B49\u5F85\u76EE\u6807\u673A\u62C9\u53D6\u2026`);
  const job = await waitForTerminalJob(client, created.jobId, DEFAULT_WAIT_TIMEOUT_SECONDS2, () => {
  }, context.pollIntervalMs ?? POLL_INTERVAL_MS2);
  if (job.status !== import_shared4.JobStatus.DONE)
    throw formatFileJobFailure(job);
  const imported = job.result;
  if (options.json === true) {
    log(JSON.stringify({ fileId: session.fileId, jobId: created.jobId, ...imported, localPath }, null, 2));
    return;
  }
  log(`[vcpdeck] \u5DF2\u4E0A\u4F20 ${localPath} \u2192 ${imported.path ?? remotePath}\uFF08${imported.size} bytes\uFF0Csha256=${imported.sha256.slice(0, 12)}\u2026\uFF09`);
}
async function uploadToTarget(client, localPath, size, upload, baseUrl, jobId, progressLog, context) {
  if (upload.kind === "proxy") {
    const fetcher = context.directFetch ?? globalThis.fetch;
    const response = await fetcher(resolveServerUrl(baseUrl, upload.url), {
      method: "PUT",
      headers: { "Content-Length": String(size) },
      body: (0, import_node_fs2.createReadStream)(localPath),
      duplex: "half"
    });
    if (!response.ok)
      throw new Error(`\u6587\u4EF6\u4E0A\u4F20\u5931\u8D25\uFF1AHTTP ${response.status}`);
    return;
  }
  if (upload.kind !== "direct")
    throw new Error("Server \u8FD4\u56DE\u672A\u77E5\u4E0A\u4F20\u6A21\u5F0F");
  const parts2 = [...upload.parts].sort((a, b) => a.partNumber - b.partNumber);
  const expectedParts = Math.ceil(size / upload.partSize);
  if (upload.partSize < 1 || parts2.length !== expectedParts || parts2.some((part, index) => part.partNumber !== index + 1)) {
    throw new Error("Server \u8FD4\u56DE\u7684\u4E0A\u4F20\u5206\u7247\u4E0D\u5B8C\u6574");
  }
  const handle = await (0, import_promises2.open)(localPath, "r");
  try {
    for (const part of parts2) {
      const start = (part.partNumber - 1) * upload.partSize;
      const length = Math.min(upload.partSize, size - start);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      if (bytesRead !== length) {
        throw new Error(`\u8BFB\u53D6\u5206\u7247 ${part.partNumber} \u4E0D\u5B8C\u6574`);
      }
      await putFilePart(client, jobId, part.partNumber, part.url, bytes, context);
      progressLog(`[vcpdeck] \u76F4\u4F20\u8FDB\u5EA6 ${Math.min(100, (start + length) / size * 100).toFixed(1)}%`);
    }
  } finally {
    await handle.close();
  }
}
function resolveServerUrl(baseUrl, url2) {
  try {
    new URL(url2);
    return url2;
  } catch {
    return `${baseUrl.replace(/\/+$/, "")}/${url2.replace(/^\/+/, "")}`;
  }
}
function sleep3(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
async function putFilePart(client, jobId, partNumber, initialUrl, bytes, context) {
  const fetcher = context.directFetch ?? globalThis.fetch;
  let url2 = initialUrl;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url2, {
        method: "PUT",
        headers: {
          "Content-Type": "",
          "Content-Length": String(bytes.length)
        },
        body: bytes
      });
      if (response.ok)
        return;
      if (response.status === 403 && attempt < 2) {
        const refreshed = await client.files.refreshUploadPartUrls(jobId, [
          partNumber
        ]);
        url2 = refreshed.find((part) => part.partNumber === partNumber)?.url ?? "";
        if (!url2)
          throw new Error(`\u5206\u7247 ${partNumber} URL \u5237\u65B0\u5931\u8D25`);
        continue;
      }
      lastError = new Error(`\u5206\u7247 ${partNumber} \u4E0A\u4F20\u5931\u8D25\uFF1AHTTP ${response.status}`);
      if (response.status < 500)
        break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2)
      await sleep3(500 * (attempt + 1));
  }
  throw lastError ?? new Error(`\u5206\u7247 ${partNumber} \u4E0A\u4F20\u5931\u8D25`);
}
function exclusiveAlias3(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
function formatTable2(rows, columns) {
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(columns.map((column) => column.toUpperCase())),
    ...rows.map((row) => line(columns.map((column) => row[column])))
  ].join("\n");
}

// dist/pi-command.js
var import_node_crypto2 = require("node:crypto");
var import_node_readline = require("node:readline");
var import_node_process = require("node:process");
init_authenticated_client();
init_arguments();
init_client_resolver();
init_environment();
var DEFAULT_RUN_TIMEOUT_SECONDS = 600;
var POLL_INTERVAL_MS3 = 3e3;
async function runPiCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "models" || subcommand === "sessions" || subcommand === "new" || subcommand === "run" || subcommand === "attach" || subcommand === "abort" || subcommand === void 0) && hasHelp3(argv);
  if (helpRequested) {
    (context.log ?? console.log)(piUsage());
    return;
  }
  if (subcommand === "models") {
    await runModels(argv, context);
    return;
  }
  if (subcommand === "sessions") {
    await runSessions(argv, context);
    return;
  }
  if (subcommand === "new") {
    await runNew(argv, context);
    return;
  }
  if (subcommand === "run") {
    await runRun(argv, context);
    return;
  }
  if (subcommand === "attach") {
    await runAttachRepl(argv, context);
    return;
  }
  if (subcommand === "abort") {
    await runAbort(argv, context);
    return;
  }
  throw new Error(piUsage());
}
function hasHelp3(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function piUsage() {
  return [
    "Pi \u547D\u4EE4:",
    "  vcpdeck pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]",
    '  vcpdeck pi run <client> "\u63D0\u793A\u8BCD" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]',
    "  # \u5199\u64CD\u4F5C\uFF1A\u5728\u76EE\u6807\u673A\u9A71\u52A8 AI Agent \u6267\u884C\u4EFB\u52A1\uFF1B\u8C03\u7528\u65B9\u987B\u5148\u53D6\u5F97\u7528\u6237\u660E\u786E\u786E\u8BA4",
    "  vcpdeck pi attach <client> [--cwd=<path>] [--session=<id>] [--root=<dir>] [--env=<name>]  # \u4EA4\u4E92\u5F0F\u5BF9\u8BDD\uFF1B/exit \u9000\u51FA",
    "  vcpdeck pi abort <client> --session=<id> [--env=<name>] [--json]",
    "  # \u7F3A\u7701 --root \u65F6\u81EA\u52A8\u63A2\u6D4B\uFF1A\u552F\u4E00\u6839\u76F4\u63A5\u4F7F\u7528\uFF0C\u591A\u6839\u8981\u6C42\u663E\u5F0F\u6307\u5B9A"
  ].join("\n");
}
function exclusiveAlias4(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
async function openContext2(context, options) {
  const environment = await resolveEnvironment({
    environment: exclusiveAlias4(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  return { environment, client };
}
async function resolveClientIdOrThrow(clientFilter, context) {
  return resolveClientId(clientFilter, context.paths, context.processEnv);
}
async function resolveCwdRef(client, clientId, options) {
  const explicitRoot = stringOption(options, "root");
  let rootDir = explicitRoot;
  if (!rootDir) {
    const roots = await fetchClientRoots(client, clientId);
    if (roots.length === 1)
      rootDir = roots[0];
    else if (roots.length === 0)
      throw new Error("\u76EE\u6807\u673A\u672A\u62A5\u544A\u53EF\u7528\u6839\u76EE\u5F55\uFF08\u6216 Pi capability \u7F3A\u5931\uFF09");
    else
      throw new Error(`\u76EE\u6807\u673A\u6709\u591A\u4E2A\u53EF\u7528\u6839\uFF08${roots.join("\u3001")}\uFF09\uFF1B\u8BF7\u7528 --root=<dir> \u6307\u5B9A\u6388\u6743\u6839`);
  }
  return { rootDir, relativePath: stringOption(options, "cwd") ?? "." };
}
async function runModels(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", "cwd"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(piUsage());
  const { environment, client } = await openContext2(context, options);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const cwdRef = await resolveCwdRef(client, clientId, options);
  const models = await client.pi.models(clientId, cwdRef);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(models, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`\u53EF\u7528\u6A21\u578B\uFF08${models.length}\uFF09\uFF1A`);
  for (const model of models)
    log(`  ${model.provider}/${model.modelId}`);
}
async function runSessions(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", "cwd"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(piUsage());
  const { environment, client } = await openContext2(context, options);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const cwdRef = await resolveCwdRef(client, clientId, options);
  const sessions = await client.pi.sessions.list(clientId, cwdRef);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(sessions, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  if (!Array.isArray(sessions)) {
    log(JSON.stringify(sessions, null, 2));
    return;
  }
  log(`\u4F1A\u8BDD\uFF08${sessions.length}\uFF09\uFF1A`);
  for (const item of sessions) {
    log(`  ${item.sessionId ?? "?"}  ${item.name ?? ""}`);
  }
}
async function runNew(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", "cwd"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(piUsage());
  const { environment, client } = await openContext2(context, options);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const cwdRef = await resolveCwdRef(client, clientId, options);
  const created = await client.pi.agent.newSession(clientId, cwdRef);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(created, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u65B0\u4F1A\u8BDD\u5DF2\u521B\u5EFA: ${created.sessionId}`);
}
function extractLastAssistantText(page) {
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant")
      continue;
    const text = (message.content ?? []).filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n").trim();
    return text.length > 0 ? text : null;
  }
  return null;
}
async function runRun(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", "cwd", "session", "timeout"],
    boolean: ["json"]
  });
  const [clientFilter, ...promptTokens] = positionals;
  const prompt = promptTokens.join(" ");
  if (!clientFilter || !prompt)
    throw new Error(piUsage());
  const timeout = parsePositiveSeconds2(stringOption(options, "timeout"), "--timeout");
  const waitTimeout = timeout ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  const environment = await resolveEnvironment({
    environment: exclusiveAlias4(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const cwdRef = await resolveCwdRef(client, clientId, options);
  const log = context.log ?? console.log;
  const progressLog = options.json === true ? () => {
  } : log;
  if (options.json !== true) {
    log(formatEnvironmentSummary(environment));
    log(`[vcpdeck] Pi \u5B50\u4EFB\u52A1 \u2192 ${clientFilter}:${cwdRef.relativePath}\uFF08${waitTimeout}s \u8D85\u65F6\uFF09`);
    log(`[vcpdeck] \u63D0\u793A\u8BCD: ${prompt}`);
  }
  const existingSession = stringOption(options, "session");
  let sessionId;
  if (existingSession) {
    sessionId = existingSession;
    await client.pi.agent.open(clientId, sessionId, cwdRef);
    progressLog(`[vcpdeck] \u5DF2\u6253\u5F00\u65E2\u6709\u4F1A\u8BDD ${sessionId}`);
  } else {
    const created = await client.pi.agent.newSession(clientId, cwdRef);
    sessionId = created.sessionId;
    progressLog(`[vcpdeck] \u5DF2\u521B\u5EFA\u65B0\u4F1A\u8BDD ${sessionId}`);
  }
  await client.pi.agent.prompt(clientId, sessionId, cwdRef, {
    submissionId: (0, import_node_crypto2.randomUUID)(),
    prompt
  });
  progressLog("[vcpdeck] \u63D0\u793A\u8BCD\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85 Pi \u5B8C\u6210\u2026");
  await waitUntilIdle(client, clientId, sessionId, cwdRef, waitTimeout, (s) => progressLog(`[vcpdeck] Pi \u72B6\u6001: ${s}`), context.pollIntervalMs ?? POLL_INTERVAL_MS3);
  const page = await client.pi.sessions.context(clientId, sessionId, cwdRef);
  const reply = extractLastAssistantText(page);
  if (options.json === true) {
    log(JSON.stringify({ sessionId, prompt, reply, messages: page?.messages ?? [] }, null, 2));
  } else if (reply !== null) {
    log(`\u2500\u2500 Pi \u56DE\u590D \u2500\u2500
${reply}`);
  } else {
    log("\uFF08\u672A\u53D6\u5230\u52A9\u624B\u6587\u672C\u56DE\u590D\uFF1B\u7528 --json \u67E5\u770B\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF09");
  }
}
async function runAbort(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "session"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  const sessionId = stringOption(options, "session");
  if (!clientFilter || !sessionId)
    throw new Error(piUsage());
  const { environment, client } = await openContext2(context, options);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const result = await client.pi.agent.abort(clientId, sessionId, sessionId);
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(result, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`[vcpdeck] \u4F1A\u8BDD ${sessionId} \u4E2D\u6B62\u8BF7\u6C42\u5DF2\u63D0\u4EA4`);
}
function parsePositiveSeconds2(raw, flag) {
  if (raw === void 0)
    return void 0;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`${flag} \u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570\u79D2`);
  }
  return seconds;
}
function sleep4(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
async function waitUntilIdle(client, clientId, sessionId, cwdRef, timeoutSeconds, onStatus, pollIntervalMs) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  let lastStatus;
  while (Date.now() < deadline) {
    const state = await client.pi.agent.state(clientId, sessionId, cwdRef);
    const status = typeof state?.status === "string" ? state.status : "unknown";
    if (status === "idle")
      return;
    if (status !== lastStatus) {
      onStatus?.(status);
      lastStatus = status;
    }
    if (status === "waiting_for_extension_input") {
      throw new Error(`Pi \u6B63\u5728\u7B49\u5F85\u6269\u5C55\u8F93\u5165\uFF08\u4F1A\u8BDD ${sessionId}\uFF09\uFF1B\u8BF7\u5728 Frontend \u5904\u7406\u540E\u91CD\u8BD5\uFF0C\u6216\u7528 pi abort \u4E2D\u6B62`);
    }
    await sleep4(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`\u7B49\u5F85 Pi \u5B8C\u6210\u8D85\u65F6\uFF08${timeoutSeconds} \u79D2\uFF09`);
}
async function runAttachRepl(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "root", "cwd", "session", "timeout"],
    boolean: ["json"]
  });
  const [clientFilter] = positionals;
  if (!clientFilter || positionals.length > 1)
    throw new Error(piUsage());
  if (options.json === true)
    throw new Error("pi attach \u4E0D\u652F\u6301 --json\uFF08\u4EA4\u4E92\u5F0F\u8F93\u51FA\uFF09");
  const perPromptTimeout = parsePositiveSeconds2(stringOption(options, "timeout"), "--timeout") ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  const environment = await resolveEnvironment({
    environment: exclusiveAlias4(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientIdOrThrow(clientFilter, context);
  const cwdRef = await resolveCwdRef(client, clientId, options);
  const output = context.output ?? import_node_process.stdout;
  const input = context.input ?? import_node_process.stdin;
  const pollIntervalMs = context.pollIntervalMs ?? POLL_INTERVAL_MS3;
  const LF = String.fromCharCode(10);
  output.write(formatEnvironmentSummary(environment) + LF);
  const existingSession = stringOption(options, "session");
  let sessionId;
  if (existingSession) {
    sessionId = existingSession;
    await client.pi.agent.open(clientId, sessionId, cwdRef);
  } else {
    const created = await client.pi.agent.newSession(clientId, cwdRef);
    sessionId = created.sessionId;
  }
  output.write("\u2500\u2500 Pi \u4EA4\u4E92\u4F1A\u8BDD \u2500\u2500" + LF + "\u673A\u5668: " + clientFilter + LF + "cwd: " + cwdRef.rootDir + (cwdRef.relativePath === "." ? "" : "/" + cwdRef.relativePath) + LF + "\u4F1A\u8BDD: " + sessionId + LF + "\u5185\u5EFA\u547D\u4EE4: /abort \u4E2D\u6B62\u5F53\u524D\u8FD0\u884C \xB7 /state \u67E5\u770B\u72B6\u6001 \xB7 /exit \u6216 Ctrl+D \u9000\u51FA" + LF + LF);
  const rl = (0, import_node_readline.createInterface)({
    input,
    output,
    terminal: input === import_node_process.stdin && output === import_node_process.stdout
  });
  const pendingLines = [];
  let waiter = null;
  let inputClosed = false;
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (waiter) {
      const resolveLine = waiter;
      waiter = null;
      resolveLine(trimmed);
    } else {
      pendingLines.push(trimmed);
    }
  });
  rl.on("close", () => {
    inputClosed = true;
    waiter?.("");
  });
  const askLine = () => {
    const buffered = pendingLines.shift();
    if (buffered !== void 0)
      return Promise.resolve(buffered);
    if (inputClosed)
      return Promise.resolve("");
    return new Promise((resolve2) => {
      waiter = resolve2;
    });
  };
  try {
    for (; ; ) {
      const raw = await askLine();
      const line = raw.trim();
      if (!line) {
        if (inputClosed && pendingLines.length === 0)
          break;
        continue;
      }
      if (line === "/exit" || line === "/quit")
        break;
      if (line === "/state") {
        const state = await client.pi.agent.state(clientId, sessionId, cwdRef);
        output.write("[Pi \u72B6\u6001] " + (state?.status ?? "\u672A\u77E5") + LF);
        continue;
      }
      if (line === "/abort") {
        await client.pi.agent.abort(clientId, sessionId, sessionId);
        output.write("[\u5DF2\u63D0\u4EA4\u4E2D\u6B62\u8BF7\u6C42]" + LF);
        continue;
      }
      try {
        await client.pi.agent.prompt(clientId, sessionId, cwdRef, {
          submissionId: (0, import_node_crypto2.randomUUID)(),
          prompt: line
        });
        await waitUntilIdle(client, clientId, sessionId, cwdRef, perPromptTimeout, (s) => output.write("[Pi " + s + "\u2026" + LF), pollIntervalMs);
        const page = await client.pi.sessions.context(clientId, sessionId, cwdRef);
        const reply = extractLastAssistantText(page);
        output.write(reply ? LF + reply + LF + LF : LF + "(\u65E0\u6587\u672C\u56DE\u590D)" + LF + LF);
      } catch (error) {
        output.write("[\u9519\u8BEF] " + (error instanceof Error ? error.message : String(error)) + LF);
      }
      if (inputClosed && pendingLines.length === 0)
        break;
    }
  } finally {
    rl.close();
  }
}

// dist/frp-command.js
init_authenticated_client();
init_arguments();
init_client_resolver();
init_environment();
init_table();
function safeInstance(instance) {
  return {
    name: instance.name,
    server: `${instance.serverAddr}:${instance.serverPort}`,
    dashboard: instance.dashboardHost !== null ? `${instance.dashboardScheme}://${instance.dashboardHost}:${instance.dashboardPort}` : "-",
    default: instance.isDefault ? "yes" : "-"
  };
}
async function runFrpCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "instances" || subcommand === "mappings" || subcommand === "mapping" || subcommand === void 0) && hasHelp4(argv);
  if (helpRequested) {
    (context.log ?? console.log)(frpUsage());
    return;
  }
  if (subcommand === "instances") {
    await runInstances(argv, context);
    return;
  }
  if (subcommand === "mappings") {
    await runMappings(argv, context);
    return;
  }
  if (subcommand === "mapping") {
    await runMapping(argv, context);
    return;
  }
  throw new Error(frpUsage());
}
function hasHelp4(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function frpUsage() {
  return [
    "FRP \u547D\u4EE4:",
    "  vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--local-ip=<host>] [--remote-port=<port>] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]",
    "  vcpdeck frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]"
  ].join("\n");
}
async function runInstances(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "page"],
    boolean: ["json"]
  });
  if (positionals.length > 0)
    throw new Error(frpUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias5(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const result = await client.frp.instances.list({
    page: parsePage2(stringOption(options, "page"))
  });
  if (options.json === true) {
    const safe = result.data.map(safeInstance);
    (context.log ?? console.log)(JSON.stringify({ ...result, data: safe }, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  log(`FRP \u670D\u52A1\u5B9E\u4F8B\uFF08${result.total}\uFF09\uFF1A`);
  log(formatTable3(result.data.map(safeInstance), ["name", "server", "dashboard", "default"]));
}
async function runMapping(argv, context) {
  const [action, ...rest] = argv;
  if (action === "create") {
    await runCreateMapping(rest, context);
    return;
  }
  if (action === "delete") {
    await runDeleteMapping(rest, context);
    return;
  }
  throw new Error(frpUsage());
}
async function runCreateMapping(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: [
      "env",
      "environment",
      "type",
      "local-ip",
      "local-port",
      "remote-port",
      "domain",
      "name",
      "instance",
      "timeout"
    ],
    boolean: ["json"]
  });
  if (positionals.length !== 1)
    throw new Error(frpUsage());
  const localPort = parsePort(stringOption(options, "local-port"), "--local-port");
  const proxyType = stringOption(options, "type") ?? "tcp";
  if (!(/* @__PURE__ */ new Set(["tcp", "http", "https"])).has(proxyType)) {
    throw new Error("--type \u5FC5\u987B\u662F tcp\u3001http \u6216 https");
  }
  const remotePort = parseOptionalPort(stringOption(options, "remote-port"), "--remote-port");
  const customDomain = stringOption(options, "domain");
  if (proxyType === "tcp" && customDomain) {
    throw new Error("TCP \u6620\u5C04\u4E0D\u63A5\u53D7 --domain");
  }
  if (proxyType !== "tcp" && !customDomain) {
    throw new Error("HTTP/HTTPS \u6620\u5C04\u5FC5\u987B\u63D0\u4F9B --domain");
  }
  if (proxyType !== "tcp" && remotePort !== void 0) {
    throw new Error("HTTP/HTTPS \u6620\u5C04\u4E0D\u63A5\u53D7 --remote-port");
  }
  const timeoutSeconds = parseTimeout(stringOption(options, "timeout"));
  const environment = await resolveEnvironment({
    environment: exclusiveAlias5(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientId = await resolveClientId(positionals[0], context.paths, context.processEnv, client);
  const mapping = await client.frp.createAndWait({
    clientId,
    proxyType,
    localIp: stringOption(options, "local-ip") ?? "127.0.0.1",
    localPort,
    ...remotePort === void 0 ? {} : { remotePort },
    ...customDomain ? { customDomain } : {},
    ...stringOption(options, "name") ? { name: stringOption(options, "name") } : {},
    ...stringOption(options, "instance") ? { frpsInstanceId: stringOption(options, "instance") } : {},
    timeoutSeconds
  }, { delays: [context.pollIntervalMs ?? 1e3] });
  const log = context.log ?? console.log;
  if (options.json === true) {
    log(JSON.stringify(mapping, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(`FRP \u6620\u5C04\u5DF2\u5EFA\u7ACB\uFF1A${mapping.name} (${mapping.publicUrl ?? mapping.id})`);
}
async function runDeleteMapping(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "timeout"],
    boolean: ["json"]
  });
  if (positionals.length !== 1)
    throw new Error(frpUsage());
  const timeoutSeconds = parseTimeout(stringOption(options, "timeout"));
  const environment = await resolveEnvironment({
    environment: exclusiveAlias5(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const result = await client.frp.deleteAndWait(positionals[0], {
    timeoutSeconds,
    delays: [context.pollIntervalMs ?? 1e3]
  });
  const log = context.log ?? console.log;
  if (options.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  log(`FRP \u6620\u5C04\u5DF2\u5220\u9664\uFF1A${result.id}`);
}
async function runMappings(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "client", "page"],
    boolean: ["json"]
  });
  if (positionals.length > 0)
    throw new Error(frpUsage());
  const environment = await resolveEnvironment({
    environment: exclusiveAlias5(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const client = await createAuthenticatedClient(environment);
  const clientFilter = stringOption(options, "client");
  const clientId = clientFilter ? await resolveClientId(clientFilter, context.paths, context.processEnv, client) : void 0;
  const result = await client.frp.list({
    clientId,
    page: parsePage2(stringOption(options, "page"))
  });
  if (options.json === true) {
    (context.log ?? console.log)(JSON.stringify(result, null, 2));
    return;
  }
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  if (result.data.length === 0) {
    log("\u5F53\u524D\u8FC7\u6EE4\u6761\u4EF6\u4E0B\u6CA1\u6709\u6620\u5C04\u3002");
    return;
  }
  log(`FRP \u6620\u5C04\uFF08\u5171 ${result.total} \xB7 \u7B2C ${result.page}/${result.totalPages} \u9875\uFF09\uFF1A`);
  log(formatTable3(result.data.map((mapping) => ({
    name: mapping.name,
    client: mapping.clientId,
    type: mapping.proxyType,
    local: `${mapping.localIp}:${mapping.localPort}`,
    remote: mapping.remotePort === null ? "-" : String(mapping.remotePort),
    status: mapping.status,
    url: mapping.publicUrl ?? "-"
  })), ["name", "client", "type", "local", "remote", "status", "url"]));
}
function exclusiveAlias5(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
function parsePage2(raw) {
  if (raw === void 0)
    return void 0;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) {
    throw new Error("--page \u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 1 \u7684\u6574\u6570");
  }
  return page;
}
function parsePort(raw, option) {
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${option} \u5FC5\u987B\u662F 1\u201365535 \u7684\u6574\u6570`);
  }
  return port;
}
function parseOptionalPort(raw, option) {
  return raw === void 0 ? void 0 : parsePort(raw, option);
}
function parseTimeout(raw) {
  const timeout = raw === void 0 ? 30 : Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("--timeout \u5FC5\u987B\u662F 1\u2013300 \u7684\u6574\u6570");
  }
  return timeout;
}

// dist/clients-command.js
init_authenticated_client();
init_arguments();
init_environment();
async function runClientsCommand(subcommand, argv, context = {}) {
  const helpRequested = subcommand === "--help" || subcommand === "-h" || (subcommand === "list" || subcommand === void 0) && hasHelp5(argv);
  if (helpRequested) {
    (context.log ?? console.log)(clientsUsage());
    return;
  }
  if (subcommand === "list") {
    await runListClients(argv, context);
    return;
  }
  throw new Error(clientsUsage());
}
function hasHelp5(argv) {
  return argv.includes("--help") || argv.includes("-h");
}
function clientsUsage() {
  return [
    "Clients \u547D\u4EE4:",
    "  vcpdeck clients list [--env=<name>] [--json]"
  ].join("\n");
}
async function runListClients(argv, context) {
  const { options } = parseCommandArgs(argv, {
    value: ["env", "environment"],
    boolean: ["json"]
  });
  const environment = await resolveEnvironment({
    environment: exclusiveAlias6(options, "env", "environment"),
    paths: context.paths,
    processEnv: context.processEnv
  });
  const log = context.log ?? console.log;
  if (options.json === true) {
    const client2 = await createAuthenticatedClient(environment);
    const clients2 = await client2.clients.list();
    log(JSON.stringify(clients2, null, 2));
    return;
  }
  log(formatEnvironmentSummary(environment));
  const client = await createAuthenticatedClient(environment);
  const clients = await client.clients.list();
  log(formatClientsSummary(clients));
}
function formatClientsSummary(clients) {
  if (clients.length === 0)
    return "\u6CA1\u6709\u5DF2\u6CE8\u518C\u7684 Client\u3002";
  const sorted = [...clients].sort((a, b) => {
    if (a.online !== b.online)
      return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rows = sorted.map((client) => ({
    name: client.name,
    hostname: client.hostname,
    os: client.os,
    state: client.online ? "online" : "offline",
    cpu: formatPercent(client.cpuPercent),
    mem: formatPercent(client.memPercent),
    version: client.clientVersion
  }));
  const onlineCount = clients.filter((client) => client.online).length;
  return [
    `\u5171 ${clients.length} \u53F0 \xB7 \u5728\u7EBF ${onlineCount} \xB7 \u79BB\u7EBF ${clients.length - onlineCount}`,
    formatTable4(rows, [
      "name",
      "hostname",
      "os",
      "state",
      "cpu",
      "mem",
      "version"
    ])
  ].join("\n");
}
function exclusiveAlias6(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}
function formatPercent(value2) {
  return value2 === null ? "-" : `${value2.toFixed(0)}%`;
}
function formatTable4(rows, columns) {
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd();
  return [
    line(columns.map((column) => column.toUpperCase())),
    ...rows.map((row) => line(columns.map((column) => row[column])))
  ].join("\n");
}

// dist/release-command.js
var import_node_crypto3 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_promises4 = require("node:fs/promises");
init_dist();
var import_shared5 = __toESM(require_dist(), 1);
init_authenticated_client();
init_arguments();
init_environment();
var VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;
var VERSION_INPUT_RE = /^\d+\.\d+\.\d+$/;
var DEFAULT_WAIT_TIMEOUT_SECONDS3 = 1800;
var DEFAULT_POLL_INTERVAL_MS = 5e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 15e3;
async function runReleaseCommand(subcommand, argv, context = {}) {
  if (subcommand === "upload") {
    await runUploadCommand(argv, context);
    return;
  }
  if (subcommand === "status" || subcommand === "wait") {
    await runInspectCommand(subcommand, argv, context);
    return;
  }
  throw new Error(releaseUsage());
}
function releaseUsage() {
  return [
    "Release \u547D\u4EE4:",
    "  vcpdeck release status <version> [--env=<name>]",
    "  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
    "  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
    "  \u517C\u5BB9\u76F4\u8FDE: \u6DFB\u52A0 --server=<url> [--username=<name> --password=<value>]"
  ].join("\n");
}
async function runUploadCommand(argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: ["env", "environment", "server", "username", "password", "timeout"],
    boolean: ["wait"]
  });
  if (positionals.length !== 2)
    throw new Error(releaseUsage());
  validateArchives(positionals);
  if (!options.wait && options.timeout !== void 0) {
    throw new Error("--timeout \u4EC5\u4E0E --wait \u4E00\u8D77\u4F7F\u7528");
  }
  const environment = await resolveCommandEnvironment(options, context);
  const log = context.log ?? console.log;
  const client = await uploadRelease(positionals, environment, log, context);
  if (options.wait) {
    await waitForRelease(client, platformOfFile(positionals[0]).version, parseTimeoutSeconds(options), log, context);
  } else {
    log("[vcpdeck] \u4E0A\u4F20\u6210\u529F\u4E0D\u4EE3\u8868\u66F4\u65B0\u5B8C\u6210\uFF1B\u4F7F\u7528 release wait <version> \u6216\u4E0A\u4F20\u65F6\u6DFB\u52A0 --wait \u9A8C\u6536\u7EC8\u6001");
  }
}
async function runInspectCommand(subcommand, argv, context) {
  const { positionals, options } = parseCommandArgs(argv, {
    value: [
      "env",
      "environment",
      "server",
      "username",
      "password",
      ...subcommand === "wait" ? ["timeout"] : []
    ]
  });
  if (positionals.length !== 1 || !VERSION_INPUT_RE.test(positionals[0])) {
    throw new Error(releaseUsage());
  }
  const environment = await resolveCommandEnvironment(options, context);
  const log = context.log ?? console.log;
  log(formatEnvironmentSummary(environment));
  const client = await createAuthenticatedClient(environment);
  if (subcommand === "wait") {
    await waitForRelease(client, positionals[0], parseTimeoutSeconds(options), log, context);
    return;
  }
  const snapshot = await readReleaseSnapshot(client, positionals[0], context.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  if (!snapshot.release)
    throw new Error(`Release \u4E0D\u5B58\u5728: ${positionals[0]}`);
  log(formatReleaseSummary(snapshot.release, snapshot.serverVersion));
}
async function resolveCommandEnvironment(options, context) {
  const environment = exclusiveAlias7(options, "env", "environment");
  const server = stringOption(options, "server");
  const username = stringOption(options, "username");
  const password = stringOption(options, "password");
  if (!server && (username || password)) {
    throw new Error("--username/--password \u53EA\u7528\u4E8E --server \u76F4\u8FDE\u6A21\u5F0F");
  }
  return resolveEnvironment({
    environment,
    server,
    username,
    password,
    paths: context.paths,
    processEnv: context.processEnv
  });
}
async function uploadRelease(zipPaths, environment, log, context) {
  log(formatEnvironmentSummary(environment));
  const client = await createAuthenticatedClient(environment);
  for (const zipPath of zipPaths) {
    await uploadOne(client, zipPath, log, context);
  }
  log("[vcpdeck] \u4E0A\u4F20\u5B8C\u6210\uFF08\u4E24\u4E2A\u5E73\u53F0\u6784\u4EF6\u9F50\u5907\u540E\u670D\u52A1\u7AEF\u81EA\u52A8\u5F00\u59CB\u66F4\u65B0\uFF09");
  return client;
}
async function waitForRelease(client, version, timeoutSeconds, log, context) {
  const deadline = Date.now() + timeoutSeconds * 1e3;
  const pollInterval = context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeout = context.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let lastSummary;
  let waitingForServer = false;
  while (Date.now() < deadline) {
    try {
      const snapshot = await readReleaseSnapshot(client, version, requestTimeout);
      waitingForServer = false;
      if (!snapshot.release)
        throw new Error(`Release \u4E0D\u5B58\u5728: ${version}`);
      const summary = formatReleaseSummary(snapshot.release, snapshot.serverVersion);
      if (summary !== lastSummary) {
        log(summary);
        lastSummary = summary;
      }
      assertReleaseNotFailed(snapshot.release);
      if (snapshot.release.status === import_shared5.ReleaseStatus.DONE) {
        assertReleaseCompleted(snapshot.release, snapshot.serverVersion);
        log(`[vcpdeck] \u53D1\u7248 ${version} \u9A8C\u6536\u5B8C\u6210`);
        return;
      }
    } catch (error) {
      if (!isTransientReadError2(error))
        throw error;
      if (!waitingForServer) {
        log("[vcpdeck] Server \u6682\u65F6\u4E0D\u53EF\u8FBE\uFF0C\u7B49\u5F85\u91CD\u542F\u5B8C\u6210\u2026");
        waitingForServer = true;
      }
    }
    await sleep5(Math.min(pollInterval, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`\u7B49\u5F85\u53D1\u7248 ${version} \u8D85\u65F6\uFF08${timeoutSeconds} \u79D2\uFF09`);
}
async function readReleaseSnapshot(client, version, requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const [release, status] = await Promise.all([
      findRelease(client, version, controller.signal),
      client.releases.status(controller.signal)
    ]);
    return { release, serverVersion: status.serverVersion };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function findRelease(client, version, signal) {
  for (let page = 1; ; page++) {
    const result = await client.releases.list({ page, pageSize: 100 }, signal);
    const found = result.data.find((release) => release.version === version);
    if (found)
      return found;
    if (page >= result.totalPages)
      return void 0;
  }
}
function formatReleaseSummary(release, serverVersion) {
  const counts = countClientStates(release);
  return [
    `\u7248\u672C: ${release.version}`,
    `Server: ${serverVersion}`,
    `Release: ${release.status}`,
    `\u5BA2\u6237\u7AEF: \u6210\u529F ${counts.done} \xB7 \u5931\u8D25 ${counts.failed} \xB7 \u8FDB\u884C\u4E2D ${counts.updating} \xB7 \u5F85\u66F4\u65B0 ${counts.pending}`
  ].join("\n");
}
function countClientStates(release) {
  const counts = {
    done: 0,
    failed: 0,
    updating: 0,
    pending: 0
  };
  for (const entry of Object.values(release.clientStates)) {
    if (entry.state === import_shared5.ReleaseClientState.DONE)
      counts.done++;
    else if (entry.state === import_shared5.ReleaseClientState.FAILED)
      counts.failed++;
    else if (entry.state === import_shared5.ReleaseClientState.UPDATING)
      counts.updating++;
    else
      counts.pending++;
  }
  return counts;
}
function assertReleaseNotFailed(release) {
  if (release.status === import_shared5.ReleaseStatus.FAILED) {
    throw new Error(`\u53D1\u7248 ${release.version} \u5931\u8D25${release.errorMessage ? `: ${release.errorMessage}` : ""}`);
  }
}
function assertReleaseCompleted(release, serverVersion) {
  const counts = countClientStates(release);
  if (serverVersion !== release.version) {
    throw new Error(`\u53D1\u7248 ${release.version} \u5DF2\u7ED3\u675F\uFF0C\u4F46 Server \u7248\u672C\u4E3A ${serverVersion}`);
  }
  if (counts.failed > 0) {
    throw new Error(`\u53D1\u7248 ${release.version} \u5DF2\u7ED3\u675F\uFF0C\u4F46\u6709 ${counts.failed} \u4E2A Client \u66F4\u65B0\u5931\u8D25`);
  }
  if (counts.updating > 0 || counts.pending > 0) {
    throw new Error(`\u53D1\u7248 ${release.version} \u5DF2\u7ED3\u675F\uFF0C\u4F46\u4ECD\u6709\u672A\u5B8C\u6210\u7684 Client`);
  }
}
function isTransientReadError2(error) {
  if (error instanceof VcpDeckApiError) {
    return error.status === 0 || [502, 503, 504].includes(error.status);
  }
  return error instanceof Error && error.name === "AbortError";
}
function parseTimeoutSeconds(options) {
  const raw = stringOption(options, "timeout");
  if (!raw)
    return DEFAULT_WAIT_TIMEOUT_SECONDS3;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error("--timeout \u5FC5\u987B\u662F 1\u201386400 \u79D2\u7684\u6574\u6570");
  }
  return seconds;
}
function sleep5(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
function validateArchives(zipPaths) {
  const archives = zipPaths.map(platformOfFile);
  if (new Set(archives.map((archive) => archive.version)).size !== 1) {
    throw new Error("\u4E24\u4E2A\u5E73\u53F0\u6784\u4EF6\u5FC5\u987B\u4F7F\u7528\u76F8\u540C\u7248\u672C\u53F7");
  }
  if (new Set(archives.map((archive) => archive.platform)).size !== 2) {
    throw new Error("\u5FC5\u987B\u5404\u63D0\u4F9B\u4E00\u4E2A win-x64 \u4E0E linux-x64 \u6784\u4EF6");
  }
}
function platformOfFile(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const match = VERSION_RE.exec(name);
  if (!match) {
    throw new Error(`\u6587\u4EF6\u540D\u5E94\u5F62\u5982 vcpdeck-<x.y.z>-win-x64.zip / vcpdeck-<x.y.z>-linux-x64.zip: ${name}`);
  }
  return { version: match[1], platform: match[2] };
}
function sha256File(path) {
  return new Promise((resolve2, reject) => {
    const hash = (0, import_node_crypto3.createHash)("sha256");
    (0, import_node_fs3.createReadStream)(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve2(hash.digest("hex")));
  });
}
async function uploadOne(client, zipPath, log, context) {
  const { version, platform } = platformOfFile(zipPath);
  const sha256 = await sha256File(zipPath);
  const { size } = await (0, import_promises4.stat)(zipPath);
  log(`[vcpdeck] \u4E0A\u4F20 ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MB, ${platform}, sha256=${sha256.slice(0, 12)}\u2026)`);
  let session;
  try {
    session = await client.releases.createUploadSession({
      version,
      platform,
      sha256,
      size
    });
  } catch (error) {
    if (!(error instanceof VcpDeckApiError) || error.status !== 404)
      throw error;
    log("[vcpdeck] \u65E7 Server \u4E0D\u652F\u6301\u76F4\u4F20\u4F1A\u8BDD\uFF0C\u4F7F\u7528 legacy \u5F15\u5BFC\u4E0A\u4F20");
    return legacyUpload(client, zipPath, version, platform, sha256);
  }
  if (session.mode === "existing") {
    log(`[vcpdeck] ${platform} \u76F8\u540C\u6784\u4EF6\u5DF2\u767B\u8BB0\uFF0C\u8DF3\u8FC7\u4E0A\u4F20`);
    return session.release;
  }
  if (session.mode === "server") {
    return legacyUpload(client, zipPath, version, platform, sha256);
  }
  if (session.mode !== "direct") {
    throw new Error("Server \u8FD4\u56DE\u672A\u77E5 Release \u4E0A\u4F20\u6A21\u5F0F");
  }
  await uploadDirectArchive(client, zipPath, platform, size, sha256, session, log, context);
  const { release } = await client.releases.completeUploadSession(session.sessionId, size);
  return release;
}
async function legacyUpload(client, zipPath, version, platform, sha256) {
  const { release } = await client.releases.upload({
    version,
    platform,
    sha256,
    archive: (0, import_node_fs3.createReadStream)(zipPath),
    duplex: "half"
  });
  return release;
}
async function uploadDirectArchive(client, zipPath, platform, size, expectedSha256, session, log, context) {
  const expectedParts = Math.ceil(size / session.partSize);
  const parts2 = [...session.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (session.partSize < 1 || parts2.length !== expectedParts || parts2.some((part, index) => part.partNumber !== index + 1 || !isSafeDirectUploadUrl(part.url))) {
    throw new Error("Server \u8FD4\u56DE\u7684 Release \u76F4\u4F20\u5206\u7247\u4E0D\u5B8C\u6574\u6216 URL \u4E0D\u5B89\u5168");
  }
  const handle = await (0, import_promises4.open)(zipPath, "r");
  const uploadedHash = (0, import_node_crypto3.createHash)("sha256");
  try {
    for (const part of parts2) {
      const start = (part.partNumber - 1) * session.partSize;
      const length = Math.min(session.partSize, size - start);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      if (bytesRead !== length)
        throw new Error(`\u8BFB\u53D6\u5206\u7247 ${part.partNumber} \u4E0D\u5B8C\u6574`);
      uploadedHash.update(bytes);
      await putDirectPart(client, session.sessionId, part.partNumber, part.url, bytes, context);
      log(`[vcpdeck] ${platform} \u76F4\u4F20\u8FDB\u5EA6 ${Math.min(100, (start + length) / size * 100).toFixed(1)}%`);
    }
  } finally {
    await handle.close();
  }
  if (uploadedHash.digest("hex") !== expectedSha256) {
    throw new Error("\u6784\u4EF6\u5728\u8BA1\u7B97 SHA-256 \u540E\u53D1\u751F\u53D8\u5316\uFF0C\u62D2\u7EDD\u5B8C\u6210\u4E0A\u4F20");
  }
}
async function putDirectPart(client, sessionId, partNumber, initialUrl, bytes, context) {
  const fetcher = context.directFetch ?? globalThis.fetch;
  const retryDelay = context.directRetryDelayMs ?? 500;
  let url2 = initialUrl;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url2, {
        method: "PUT",
        headers: {
          "Content-Type": "",
          "Content-Length": String(bytes.length)
        },
        body: bytes
      });
      if (response.ok)
        return;
      if (response.status === 403 && attempt < 2) {
        const refreshed = await client.releases.refreshUploadParts(sessionId, [
          partNumber
        ]);
        url2 = refreshed.parts.find((part) => part.partNumber === partNumber)?.url ?? "";
        if (!isSafeDirectUploadUrl(url2)) {
          throw new Error(`\u5206\u7247 ${partNumber} URL \u5237\u65B0\u5931\u8D25\u6216\u4E0D\u5B89\u5168`);
        }
        continue;
      }
      lastError = new Error(`\u5206\u7247 ${partNumber} \u4E0A\u4F20\u5931\u8D25\uFF1AHTTP ${response.status}`);
      if (response.status < 500)
        break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < 2)
      await sleep5(retryDelay * (attempt + 1));
  }
  throw lastError ?? new Error(`\u5206\u7247 ${partNumber} \u4E0A\u4F20\u5931\u8D25`);
}
function isSafeDirectUploadUrl(value2) {
  try {
    const url2 = new URL(value2);
    return url2.protocol === "https:" && !url2.username && !url2.password;
  } catch {
    return false;
  }
}
function exclusiveAlias7(options, first, second) {
  const firstValue = stringOption(options, first);
  const secondValue = stringOption(options, second);
  if (firstValue && secondValue) {
    throw new Error(`--${first} \u4E0E --${second} \u4E0D\u80FD\u540C\u65F6\u4F7F\u7528`);
  }
  return firstValue ?? secondValue;
}

// dist/index.js
async function run(argv, context = {}) {
  const log = context.log ?? console.log;
  const error = context.error ?? console.error;
  const [command, subcommand, ...rest] = argv;
  try {
    if (command === "version" || command === "--version" || command === "-v") {
      log(import_shared7.VERSION);
      return 0;
    }
    if (command === "env") {
      await runEnvCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "pi") {
      await runPiCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "frp") {
      await runFrpCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "storage") {
      const { runStorageCommand: runStorageCommand2 } = await Promise.resolve().then(() => (init_storage_command(), storage_command_exports));
      await runStorageCommand2(subcommand, rest, { log });
      return 0;
    }
    if (command === "terminal") {
      const { runTerminalCommand: runTerminalCommand2 } = await Promise.resolve().then(() => (init_terminal_command(), terminal_command_exports));
      await runTerminalCommand2(subcommand, rest, { log });
      return 0;
    }
    if (command === "completions") {
      const { runCompletionsCommand: runCompletionsCommand2 } = await Promise.resolve().then(() => (init_completions_command(), completions_command_exports));
      await runCompletionsCommand2(subcommand, { log });
      return 0;
    }
    if (command === "files") {
      await runFilesCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "jobs") {
      await runJobsCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "clients") {
      await runClientsCommand(subcommand, rest, { log });
      return 0;
    }
    if (command === "release") {
      await runReleaseCommand(subcommand, rest, { log });
      return 0;
    }
    if (!command || command === "help" || command === "--help" || command === "-h") {
      log(helpText());
      return 0;
    }
    throw new Error(`\u672A\u77E5\u547D\u4EE4: ${command}

${helpText()}`);
  } catch (cause) {
    error(`[vcpdeck] ${messageOf(cause)}`);
    return 1;
  }
}
function helpText() {
  return [
    "vcpdeck",
    "  vcpdeck --version",
    "",
    "\u73AF\u5883\u914D\u7F6E:",
    "  vcpdeck env list",
    "  vcpdeck env show <name>",
    "  vcpdeck env current [--env=<name>]",
    "  vcpdeck env check [--env=<name>]",
    "  vcpdeck env add <name> --server=<url> --token-env=<VAR>",
    "  \u517C\u5BB9\u5BC6\u7801: ... --auth=password --username=<name> --password-env=<VAR>",
    "  vcpdeck env remove <name>",
    "  vcpdeck env use <name> --global|--local",
    "",
    "Clients:",
    "  vcpdeck clients list [--env=<name>] [--json]",
    "",
    "Jobs:",
    "  vcpdeck jobs list [--client=<name|id>] [--status=<status>] [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck jobs get <jobId> [--env=<name>] [--json]",
    "  vcpdeck jobs run <client> [--cwd=<dir>] [--timeout=<seconds>] [--wait] [--wait-timeout=<seconds>] [--env=<name>] [--json] -- <command...>",
    "  vcpdeck jobs cancel <jobId> [--env=<name>] [--json]",
    "",
    "Files:",
    "  vcpdeck files roots <client> [--env=<name>] [--json]",
    "  vcpdeck files list <client> <path> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files stat <client> <path> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files read <client> <path> [--root=<dir>] [--max-bytes=<n>] [--env=<name>] [--json]",
    "  vcpdeck files write <client> <path> [--root=<dir>] [--input=<file>] [--env=<name>] [--json]",
    "  vcpdeck files mkdir <client> <path> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files delete <client> <path> [--root=<dir>] [--recursive] [--env=<name>] [--json]",
    "  vcpdeck files move <client> <source> <destination> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
    "  vcpdeck files download <client> <remotePath> <localPath> [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck files upload <client> <localPath> <remotePath> [--root=<dir>] [--overwrite] [--env=<name>] [--json]",
    "",
    "Pi:",
    "  vcpdeck pi models <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck pi sessions <client> [--cwd=<path>] [--root=<dir>] [--env=<name>] [--json]",
    "  vcpdeck pi new <client> --cwd=<path> [--root=<dir>] [--env=<name>] [--json]",
    '  vcpdeck pi run <client> "\u63D0\u793A\u8BCD" --cwd=<path> [--session=<id>] [--root=<dir>] [--timeout=<seconds>] [--env=<name>] [--json]',
    "  vcpdeck pi abort <client> --session=<id> [--env=<name>] [--json]",
    "",
    "FRP:",
    "  vcpdeck frp instances [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck frp mappings [--client=<name|id>] [--page=<n>] [--env=<name>] [--json]",
    "  vcpdeck frp mapping create <client> --local-port=<port> [--type=tcp|http|https] [--domain=<domain>] [--name=<name>] [--instance=<id>] [--timeout=<seconds>] [--env=<name>] [--json]",
    "  vcpdeck frp mapping delete <mappingId> [--timeout=<seconds>] [--env=<name>] [--json]",
    "",
    "Storage:",
    "  vcpdeck storage status [--env=<name>] [--json]",
    "",
    "Terminal:",
    "  vcpdeck terminal new <client> [--shell=<id>] [--cols=<n>] [--rows=<n>] [--env=<name>] [--json]",
    "  vcpdeck terminal shells <client> [--env=<name>] [--json]",
    "  vcpdeck terminal list <client> [--status=<status>] [--env=<name>] [--json]",
    "  vcpdeck terminal close <client> <sessionId> [--env=<name>] [--json]  # \u5199\u64CD\u4F5C\u9700\u786E\u8BA4",
    "  vcpdeck terminal attach <client> <sessionId> [--env=<name>]  # \u672C\u5730\u7EC8\u7AEF\u76F4\u8FDE\u8FDC\u7AEF PTY\uFF1BCtrl+Q \u9000\u51FA",
    "",
    "Release:",
    "  vcpdeck release status <version> [--env=<name>]",
    "  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
    "  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
    "  \u517C\u5BB9\u76F4\u8FDE: \u6DFB\u52A0 --server=<url> [--username=<name> --password=<value>]",
    "",
    "Shell \u8865\u5168:",
    "  vcpdeck completions bash        # \u8F93\u51FA Bash \u8865\u5168\u811A\u672C\uFF08Git Bash\uFF0C\u8FFD\u52A0\u5230 ~/.bashrc\uFF09",
    "  vcpdeck completions powershell  # \u8F93\u51FA PowerShell \u8865\u5168\u811A\u672C\uFF08\u8FFD\u52A0\u5230 $PROFILE\uFF09",
    "  \u73AF\u5883\u589E\u5220\u540E\u8BF7\u91CD\u65B0\u751F\u6210\u4EE5\u5237\u65B0 --env= \u5019\u9009"
  ].join("\n");
}
function messageOf(cause) {
  if (!(cause instanceof Error))
    return "\u672A\u77E5\u9519\u8BEF";
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : void 0;
  return `${cause.message}${code ? ` (${code})` : ""}`;
}
void run(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  helpText,
  run
});
/*! Bundled license information:

xmlhttprequest-ssl/lib/XMLHttpRequest.js:
  (**
   * Wrapper for built-in http.js to emulate the browser XMLHttpRequest object.
   *
   * This can be used with JS designed for browsers to improve reuse of code and
   * allow the use of existing libraries.
   *
   * Usage: include("XMLHttpRequest.js") and use XMLHttpRequest per W3C specs.
   *
   * @author Dan DeFelippi <dan@driverdan.com>
   * @contributor David Ellis <d.f.ellis@ieee.org>
   * @license MIT
   *)
*/
