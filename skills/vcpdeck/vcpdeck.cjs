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
    exports2.VERSION = "0.2.2";
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
    exports2.FrpJobType = exports2.StorageProviderKind = exports2.AuthErrorCode = exports2.FileErrorCode = exports2.JobStatus = exports2.JobType = exports2.Events = exports2.safePiErrorMessage = exports2.parsePiAgentState = exports2.isPiThinkingLevel = exports2.isPiAgentIdle = exports2.PI_THINKING_LEVELS = exports2.PI_SESSION_JOB_PROTOCOL_VERSION = exports2.PI_ERROR_CODES = exports2.platformFromOs = exports2.parseReleaseUploadPartRefresh = exports2.parseReleaseUploadCreateInput = exports2.parseReleaseUploadComplete = exports2.ReleaseUploadErrorCode = exports2.ReleaseStatus = exports2.ReleaseClientState = exports2.parseClientInstallerPlatform = exports2.parseClientInstallerNameUpdate = exports2.parseClientInstallerConfigUpdate = exports2.ClientInstallerErrorCode = exports2.VERSION = void 0;
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
    var JobStatus;
    (function(JobStatus2) {
      JobStatus2["IDLE"] = "idle";
      JobStatus2["PENDING"] = "pending";
      JobStatus2["RUNNING"] = "running";
      JobStatus2["WAITING_INPUT"] = "waiting_input";
      JobStatus2["DONE"] = "done";
      JobStatus2["ERROR"] = "error";
      JobStatus2["DISCONNECTED"] = "disconnected";
      JobStatus2["CANCELLED"] = "cancelled";
    })(JobStatus || (exports2.JobStatus = JobStatus = {}));
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
    exports2.FrpJobType = {
      FRP_CREATE: "frp.create",
      FRP_DELETE: "frp.delete",
      FRP_LIST: "frp.list"
    };
  }
});

// dist/index.js
var index_exports = {};
__export(index_exports, {
  helpText: () => helpText,
  run: () => run
});
module.exports = __toCommonJS(index_exports);
var import_shared3 = __toESM(require_dist(), 1);

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

// ../sdk/dist/frp.js
function createFrpApi(client) {
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
    delete: (id, signal) => client.request("DELETE", `/api/frp/mappings/${encodeURIComponent(id)}`, void 0, signal),
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

// ../sdk/dist/pi.js
var import_shared = __toESM(require_dist(), 1);
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
      state: async (clientId, sessionId, cwdRef, signal) => (0, import_shared.parsePiAgentState)(await client.request("GET", `/api/clients/${enc(clientId)}/pi/agent/${enc(sessionId)}?${cwdQuery(cwdRef)}`, void 0, signal)),
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
    this.frp = createFrpApi(this);
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

// dist/config.js
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var CLI_CONFIG_VERSION = 1;
var PROJECT_CONFIG_FILE = ".vcpdeck.json";
var ENVIRONMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var ENVIRONMENT_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function defaultConfigPaths(cwd = process.cwd()) {
  return {
    globalConfigPath: (0, import_node_path.join)((0, import_node_os.homedir)(), ".vcpdeck", "cli", "config.json"),
    cwd: (0, import_node_path.resolve)(cwd)
  };
}
function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Server URL \u65E0\u6548: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" || !url.hostname) {
    throw new Error("Server URL \u5FC5\u987B\u662F\u5E26\u4E3B\u673A\u540D\u7684 http/https \u5730\u5740");
  }
  if (url.username || url.password) {
    throw new Error("Server URL \u4E0D\u5F97\u5185\u5D4C\u7528\u6237\u540D\u6216\u5BC6\u7801");
  }
  if (url.search || url.hash) {
    throw new Error("Server URL \u4E0D\u5F97\u5305\u542B query \u6216 fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Server URL \u5FC5\u987B\u662F origin\uFF0C\u4E0D\u5F97\u5305\u542B\u4E1A\u52A1\u8DEF\u5F84");
  }
  return url.origin;
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
function parseCliConfig(value) {
  const root = requireRecord(value, "CLI \u914D\u7F6E");
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
function parseProjectConfig(value) {
  const root = requireRecord(value, "\u9879\u76EE\u914D\u7F6E");
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
  const value = await readJson(path, options.required ?? false);
  return value === void 0 ? { version: CLI_CONFIG_VERSION, environments: {} } : parseCliConfig(value);
}
async function loadProjectConfig(path) {
  const value = await readJson(path, true);
  return parseProjectConfig(value);
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
function parseEnvironment(value, name) {
  const root = requireRecord(value, `\u73AF\u5883 ${name}`);
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
function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} \u5FC5\u987B\u662F\u5BF9\u8C61`);
  }
  return value;
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
async function writeJsonAtomic(path, value, privateFile) {
  const directory = (0, import_node_path.dirname)(path);
  await (0, import_promises.mkdir)(directory, { recursive: true, mode: privateFile ? 448 : 493 });
  if (privateFile && process.platform !== "win32")
    await (0, import_promises.chmod)(directory, 448);
  const tempPath = (0, import_node_path.join)(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    await (0, import_promises.writeFile)(tempPath, `${JSON.stringify(value, null, 2)}
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

// dist/arguments.js
function parseCommandArgs(argv, schema = {}) {
  const valueOptions = new Set(schema.value ?? []);
  const booleanOptions = new Set(schema.boolean ?? []);
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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
    const value = parsed.inlineValue ?? argv[++index];
    options[parsed.name] = requireOptionValue(parsed.name, value);
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
function requireOptionValue(name, value) {
  if (value === void 0 || value.startsWith("--") || value.length === 0) {
    throw new Error(`\u9009\u9879\u7F3A\u5C11\u503C: --${name}`);
  }
  return value;
}
function stringOption(options, name) {
  const value = options[name];
  return typeof value === "string" ? value : void 0;
}

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

// dist/env-command.js
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
  const value = stringOption(options, name);
  if (!value)
    throw new Error(`\u7F3A\u5C11 --${name}`);
  return value;
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

// dist/release-command.js
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_shared2 = __toESM(require_dist(), 1);
var VERSION_RE = /^vcpdeck-(\d+\.\d+\.\d+)-(win-x64|linux-x64)\.zip$/;
var VERSION_INPUT_RE = /^\d+\.\d+\.\d+$/;
var DEFAULT_WAIT_TIMEOUT_SECONDS = 1800;
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
  const environment = exclusiveAlias2(options, "env", "environment");
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
      if (snapshot.release.status === import_shared2.ReleaseStatus.DONE) {
        assertReleaseCompleted(snapshot.release, snapshot.serverVersion);
        log(`[vcpdeck] \u53D1\u7248 ${version} \u9A8C\u6536\u5B8C\u6210`);
        return;
      }
    } catch (error) {
      if (!isTransientReadError(error))
        throw error;
      if (!waitingForServer) {
        log("[vcpdeck] Server \u6682\u65F6\u4E0D\u53EF\u8FBE\uFF0C\u7B49\u5F85\u91CD\u542F\u5B8C\u6210\u2026");
        waitingForServer = true;
      }
    }
    await sleep2(Math.min(pollInterval, Math.max(0, deadline - Date.now())));
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
    if (entry.state === import_shared2.ReleaseClientState.DONE)
      counts.done++;
    else if (entry.state === import_shared2.ReleaseClientState.FAILED)
      counts.failed++;
    else if (entry.state === import_shared2.ReleaseClientState.UPDATING)
      counts.updating++;
    else
      counts.pending++;
  }
  return counts;
}
function assertReleaseNotFailed(release) {
  if (release.status === import_shared2.ReleaseStatus.FAILED) {
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
function isTransientReadError(error) {
  if (error instanceof VcpDeckApiError) {
    return error.status === 0 || [502, 503, 504].includes(error.status);
  }
  return error instanceof Error && error.name === "AbortError";
}
function parseTimeoutSeconds(options) {
  const raw = stringOption(options, "timeout");
  if (!raw)
    return DEFAULT_WAIT_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error("--timeout \u5FC5\u987B\u662F 1\u201386400 \u79D2\u7684\u6574\u6570");
  }
  return seconds;
}
function sleep2(ms) {
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
    const hash = (0, import_node_crypto.createHash)("sha256");
    (0, import_node_fs2.createReadStream)(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve2(hash.digest("hex")));
  });
}
async function uploadOne(client, zipPath, log, context) {
  const { version, platform } = platformOfFile(zipPath);
  const sha256 = await sha256File(zipPath);
  const { size } = await (0, import_promises2.stat)(zipPath);
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
    archive: (0, import_node_fs2.createReadStream)(zipPath),
    duplex: "half"
  });
  return release;
}
async function uploadDirectArchive(client, zipPath, platform, size, expectedSha256, session, log, context) {
  const expectedParts = Math.ceil(size / session.partSize);
  const parts = [...session.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (session.partSize < 1 || parts.length !== expectedParts || parts.some((part, index) => part.partNumber !== index + 1 || !isSafeDirectUploadUrl(part.url))) {
    throw new Error("Server \u8FD4\u56DE\u7684 Release \u76F4\u4F20\u5206\u7247\u4E0D\u5B8C\u6574\u6216 URL \u4E0D\u5B89\u5168");
  }
  const handle = await (0, import_promises2.open)(zipPath, "r");
  const uploadedHash = (0, import_node_crypto.createHash)("sha256");
  try {
    for (const part of parts) {
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
  let url = initialUrl;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, {
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
        url = refreshed.parts.find((part) => part.partNumber === partNumber)?.url ?? "";
        if (!isSafeDirectUploadUrl(url)) {
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
      await sleep2(retryDelay * (attempt + 1));
  }
  throw lastError ?? new Error(`\u5206\u7247 ${partNumber} \u4E0A\u4F20\u5931\u8D25`);
}
function isSafeDirectUploadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
function exclusiveAlias2(options, first, second) {
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
      log(import_shared3.VERSION);
      return 0;
    }
    if (command === "env") {
      await runEnvCommand(subcommand, rest, { log });
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
    "Release:",
    "  vcpdeck release status <version> [--env=<name>]",
    "  vcpdeck release wait <version> [--env=<name>] [--timeout=<seconds>]",
    "  vcpdeck release upload <win-x64.zip> <linux-x64.zip> [--env=<name>] [--wait] [--timeout=<seconds>]",
    "  \u517C\u5BB9\u76F4\u8FDE: \u6DFB\u52A0 --server=<url> [--username=<name> --password=<value>]"
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
