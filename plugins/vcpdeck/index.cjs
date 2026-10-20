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
    exports2.VERSION = "0.22.0";
  }
});

// ../shared/dist/client-annotations.js
var require_client_annotations = __commonJS({
  "../shared/dist/client-annotations.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.parseClientAnnotationsInput = parseClientAnnotationsInput;
    exports2.hasClientAnnotations = hasClientAnnotations;
    exports2.parseClientAnnotations = parseClientAnnotations;
    var MAX_PUBLIC_ADDRESSES = 4;
    var MAX_HOST_LENGTH = 253;
    var MAX_NOTES_LENGTH = 1e3;
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function isIPv4(value) {
      const parts = value.split(".");
      if (parts.length !== 4)
        return false;
      return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
    }
    function isIPv6(value) {
      if (!value.includes(":") || value.includes("%") || value.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(value)) {
        return false;
      }
      try {
        const parsed = new URL(`http://[${value}]/`);
        return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
      } catch {
        return false;
      }
    }
    function isHostname(value) {
      if (value.length === 0 || value.length > MAX_HOST_LENGTH)
        return false;
      return value.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
    }
    function parseAddressList(value, field, validator, label) {
      if (value === void 0)
        return [];
      if (!Array.isArray(value)) {
        throw new Error(`annotations.publicAddress.${field} \u5FC5\u987B\u4E3A\u6570\u7EC4`);
      }
      if (value.length > MAX_PUBLIC_ADDRESSES) {
        throw new Error(`annotations.publicAddress.${field} \u6700\u591A ${MAX_PUBLIC_ADDRESSES} \u4E2A`);
      }
      const result = [];
      for (const candidate of value) {
        if (typeof candidate !== "string") {
          throw new Error(`annotations.publicAddress.${field} \u7684\u5143\u7D20\u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32`);
        }
        const normalized = candidate.trim();
        if (!validator(normalized)) {
          throw new Error(`annotations.publicAddress.${field} \u542B\u975E\u6CD5 ${label} \u5730\u5740\uFF1A${normalized}`);
        }
        if (result.includes(normalized)) {
          throw new Error(`annotations.publicAddress.${field} \u4E0D\u80FD\u5305\u542B\u91CD\u590D\u5730\u5740`);
        }
        result.push(normalized);
      }
      return result;
    }
    function parseHost(value) {
      if (value === void 0 || value === null)
        return null;
      if (typeof value !== "string") {
        throw new Error("annotations.publicAddress.host \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6216 null");
      }
      const normalized = value.trim().toLowerCase().replace(/\.$/, "");
      if (normalized.length === 0)
        return null;
      if (!isHostname(normalized)) {
        throw new Error("annotations.publicAddress.host \u4E0D\u662F\u5408\u6CD5\u57DF\u540D");
      }
      return normalized;
    }
    function parseNotes(value) {
      if (value === void 0 || value === null)
        return null;
      if (typeof value !== "string") {
        throw new Error("annotations.notes \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6216 null");
      }
      const normalized = value.trim();
      if (normalized.length === 0)
        return null;
      if (normalized.length > MAX_NOTES_LENGTH) {
        throw new Error(`annotations.notes \u4E0D\u80FD\u8D85\u8FC7 ${MAX_NOTES_LENGTH} \u5B57\u7B26`);
      }
      if (hasControlCharacters(normalized)) {
        throw new Error("annotations.notes \u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26");
      }
      return normalized;
    }
    function hasControlCharacters(value) {
      for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) {
          return true;
        }
      }
      return false;
    }
    function parsePublicAddress(value) {
      if (value === void 0 || value === null)
        return null;
      if (!isRecord2(value)) {
        throw new Error("annotations.publicAddress \u5FC5\u987B\u4E3A\u5BF9\u8C61\u6216 null");
      }
      for (const key of Object.keys(value)) {
        if (key !== "v4" && key !== "v6" && key !== "host") {
          throw new Error(`annotations.publicAddress \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
      return {
        v4: parseAddressList(value.v4, "v4", isIPv4, "IPv4"),
        v6: parseAddressList(value.v6, "v6", isIPv6, "IPv6"),
        host: parseHost(value.host)
      };
    }
    function parseClientAnnotationsInput(value) {
      if (!isRecord2(value)) {
        throw new Error("annotations \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      }
      for (const key of Object.keys(value)) {
        if (key !== "publicAddress" && key !== "notes") {
          throw new Error(`annotations \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
      return {
        publicAddress: parsePublicAddress(value.publicAddress),
        notes: parseNotes(value.notes)
      };
    }
    function hasClientAnnotations(input) {
      return input.publicAddress !== null || input.notes !== null;
    }
    function parseClientAnnotations(value) {
      if (!isRecord2(value)) {
        throw new Error("annotations \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      }
      if (Object.keys(value).length === 0)
        return null;
      for (const key of Object.keys(value)) {
        if (key !== "publicAddress" && key !== "notes" && key !== "updatedAt") {
          throw new Error(`annotations \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
      const publicAddress = parsePublicAddress(value.publicAddress);
      const notes = parseNotes(value.notes);
      if (typeof value.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt) || Number.isNaN(Date.parse(value.updatedAt))) {
        throw new Error("annotations.updatedAt \u5FC5\u987B\u4E3A ISO \u65F6\u95F4\u5B57\u7B26\u4E32");
      }
      if (publicAddress === null && notes === null)
        return null;
      return {
        publicAddress,
        notes,
        updatedAt: new Date(value.updatedAt).toISOString()
      };
    }
  }
});

// ../shared/dist/client-dsh-web.js
var require_client_dsh_web = __commonJS({
  "../shared/dist/client-dsh-web.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DSH_WEB_URL_MAX_LENGTH = void 0;
    exports2.parseClientDshWebUrl = parseClientDshWebUrl;
    exports2.DSH_WEB_URL_MAX_LENGTH = 2048;
    function parseClientDshWebUrl(value) {
      if (value === null)
        return null;
      if (typeof value !== "string") {
        throw new Error("dshWebUrl \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32\u6216 null");
      }
      const trimmed = value.trim();
      if (trimmed.length === 0)
        return null;
      if (trimmed.length > exports2.DSH_WEB_URL_MAX_LENGTH) {
        throw new Error(`dshWebUrl \u4E0D\u80FD\u8D85\u8FC7 ${exports2.DSH_WEB_URL_MAX_LENGTH} \u5B57\u7B26`);
      }
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error("dshWebUrl \u4E0D\u662F\u5408\u6CD5 URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("dshWebUrl \u53EA\u5141\u8BB8 http/https");
      }
      if (parsed.username !== "" || parsed.password !== "") {
        throw new Error("dshWebUrl \u4E0D\u80FD\u5305\u542B\u7528\u6237\u540D\u6216\u53E3\u4EE4");
      }
      return parsed.toString();
    }
  }
});

// ../shared/dist/dsh-web.js
var require_dsh_web = __commonJS({
  "../shared/dist/dsh-web.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DSH_WEB_MODES = exports2.DSH_WEB_STATES = exports2.DSH_WEB_CAPABILITY = void 0;
    exports2.parseDshWebCommand = parseDshWebCommand;
    exports2.parseDshWebCommandResult = parseDshWebCommandResult;
    exports2.DSH_WEB_CAPABILITY = "dsh-web";
    exports2.DSH_WEB_STATES = [
      "stopped",
      "starting",
      "running",
      "failed",
      /**
       * 外部托管：实例由目标机自己管（systemd / docker / 手工常驻 / 自有反代），
       * VCPDeck 只登记入口，绝不代起代停。
       */
      "external"
    ];
    exports2.DSH_WEB_MODES = ["managed", "external"];
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function requireString(value, field, maxLength) {
      if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
        throw new Error(`${field} \u5FC5\u987B\u4E3A\u957F\u5EA6 1-${maxLength} \u7684\u5B57\u7B26\u4E32`);
      }
      return value;
    }
    function requirePort(value, field) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error(`${field} \u5FC5\u987B\u4E3A 1024-65535 \u7684\u6574\u6570`);
      }
      return value;
    }
    function parseDshWebCommand(value) {
      if (!isRecord2(value))
        throw new Error("dshweb \u547D\u4EE4\u5FC5\u987B\u4E3A\u5BF9\u8C61");
      const allowed = /* @__PURE__ */ new Set(["requestId", "action", "clientId", "port"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key))
          throw new Error(`dshweb \u547D\u4EE4\u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      const requestId = requireString(value.requestId, "requestId", 128);
      const clientId = requireString(value.clientId, "clientId", 128);
      if (value.action !== "start" && value.action !== "stop") {
        throw new Error("dshweb \u547D\u4EE4 action \u5FC5\u987B\u662F start \u6216 stop");
      }
      return {
        requestId,
        action: value.action,
        clientId,
        port: requirePort(value.port, "port")
      };
    }
    function parseDshWebCommandResult(value) {
      if (!isRecord2(value))
        throw new Error("dshweb \u7ED3\u679C\u5FC5\u987B\u4E3A\u5BF9\u8C61");
      const allowed = /* @__PURE__ */ new Set([
        "requestId",
        "ok",
        "port",
        "token",
        "error"
      ]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key))
          throw new Error(`dshweb \u7ED3\u679C\u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      const requestId = requireString(value.requestId, "requestId", 128);
      if (typeof value.ok !== "boolean")
        throw new Error("dshweb \u7ED3\u679C ok \u5FC5\u987B\u4E3A\u5E03\u5C14\u503C");
      const result = { requestId, ok: value.ok };
      if (value.port !== void 0) {
        result.port = requirePort(value.port, "port");
      }
      if (value.token !== void 0) {
        result.token = requireString(value.token, "token", 512);
      }
      if (value.error !== void 0) {
        if (!isRecord2(value.error))
          throw new Error("error \u5FC5\u987B\u4E3A\u5BF9\u8C61");
        result.error = {
          code: requireString(value.error.code, "error.code", 128),
          message: requireString(value.error.message, "error.message", 2e3)
        };
      }
      return result;
    }
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
    exports2.ReleaseRetryErrorCode = exports2.ReleaseUploadErrorCode = exports2.ReleaseClientState = exports2.ReleaseStatus = void 0;
    exports2.parseReleaseUploadCreateInput = parseReleaseUploadCreateInput;
    exports2.parseReleaseUploadPartRefresh = parseReleaseUploadPartRefresh;
    exports2.parseReleaseUploadComplete = parseReleaseUploadComplete;
    exports2.isReleaseArchiveAvailable = isReleaseArchiveAvailable;
    exports2.hasAllReleaseArchives = hasAllReleaseArchives;
    exports2.isCatchUpTarget = isCatchUpTarget;
    exports2.selectLatestCatchUpTarget = selectLatestCatchUpTarget;
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
    exports2.ReleaseRetryErrorCode = {
      NOT_FOUND: "RELEASE_NOT_FOUND",
      CLIENT_NOT_FOUND: "RELEASE_CLIENT_NOT_FOUND",
      RETRY_NOT_ALLOWED: "RELEASE_RETRY_NOT_ALLOWED"
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
    function hasAllReleaseArchives(release) {
      const archives = release.archives ?? {};
      return isReleaseArchiveAvailable(archives["win-x64"]) && isReleaseArchiveAvailable(archives["linux-x64"]);
    }
    function isCatchUpTarget(release) {
      if (release.status !== ReleaseStatus.UPDATING_CLIENTS && release.status !== ReleaseStatus.DONE) {
        return false;
      }
      return hasAllReleaseArchives(release);
    }
    function selectLatestCatchUpTarget(releases) {
      let latest = null;
      let latestAt = Number.NEGATIVE_INFINITY;
      for (const release of releases) {
        if (!isCatchUpTarget(release))
          continue;
        const at = Date.parse(release.createdAt);
        if (!Number.isFinite(at) || at <= latestAt)
          continue;
        latest = release;
        latestAt = at;
      }
      return latest;
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

// ../shared/dist/git-ssh.js
var require_git_ssh = __commonJS({
  "../shared/dist/git-ssh.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.GIT_SSH_TARGET_STATES = exports2.GitSshProtocolError = exports2.GIT_SSH_FAILURE_CODES = exports2.GIT_SSH_MAX_TARGETS = exports2.GIT_SSH_PROTOCOL_VERSION = void 0;
    exports2.isGitSshTargetState = isGitSshTargetState;
    exports2.isGitSshFailureCode = isGitSshFailureCode;
    exports2.parseGitSshCommand = parseGitSshCommand;
    exports2.parseGitSshAck = parseGitSshAck;
    exports2.parseGitSshCapability = parseGitSshCapability;
    exports2.parseGitSshTargetInput = parseGitSshTargetInput;
    exports2.GIT_SSH_PROTOCOL_VERSION = 1;
    exports2.GIT_SSH_MAX_TARGETS = 200;
    var MAX_PRIVATE_KEY_LENGTH = 8192;
    var MAX_PUBLIC_KEY_LENGTH = 512;
    var MAX_OPERATION_ID_LENGTH = 64;
    var MAX_CLIENT_ID_LENGTH = 128;
    exports2.GIT_SSH_FAILURE_CODES = [
      "GIT_SSH_KEY_UNAVAILABLE",
      "GIT_SSH_INSTALL_FAILED",
      "GIT_SSH_CLEAR_FAILED",
      "GIT_SSH_UNSUPPORTED"
    ];
    var GitSshProtocolError = class extends Error {
      code = "GIT_SSH_PROTOCOL_INVALID";
      constructor(message) {
        super(message);
        this.name = "GitSshProtocolError";
      }
    };
    exports2.GitSshProtocolError = GitSshProtocolError;
    function fail(message) {
      throw new GitSshProtocolError(message);
    }
    function assertRecord(value, what) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
      }
    }
    function assertExactKeys(value, allowed, what) {
      const allowedSet = new Set(allowed);
      for (const key of Object.keys(value)) {
        if (!allowedSet.has(key))
          fail(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      for (const key of allowed) {
        if (!(key in value))
          fail(`${what} \u7F3A\u5C11\u5B57\u6BB5 ${key}`);
      }
    }
    function requireBoundedString(value, what, maxLength) {
      if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
        fail(`${what} \u5FC5\u987B\u4E3A\u957F\u5EA6 1-${maxLength} \u7684\u5B57\u7B26\u4E32`);
      }
      return value;
    }
    function requirePositiveInt(value, what) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        fail(`${what} \u5FC5\u987B\u4E3A\u6B63\u6574\u6570`);
      }
      return value;
    }
    function requireProtocolVersion(value) {
      if (value !== exports2.GIT_SSH_PROTOCOL_VERSION) {
        fail(`protocolVersion \u4E0D\u652F\u6301\uFF1A${String(value)}`);
      }
      return exports2.GIT_SSH_PROTOCOL_VERSION;
    }
    var OPENSSH_PRIVATE_KEY_PATTERN = /^-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+-----END OPENSSH PRIVATE KEY-----\s*$/;
    var OPENSSH_PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
    exports2.GIT_SSH_TARGET_STATES = [
      "pending",
      "installed",
      "clear-pending",
      "cleared",
      "failed",
      "ambiguous",
      "unsupported"
    ];
    function isGitSshTargetState(value) {
      return typeof value === "string" && exports2.GIT_SSH_TARGET_STATES.includes(value);
    }
    function isGitSshFailureCode(value) {
      return typeof value === "string" && exports2.GIT_SSH_FAILURE_CODES.includes(value);
    }
    function parseGitSshCommand(value) {
      assertRecord(value, "gitSshCommand");
      if (value.action === "clear") {
        assertExactKeys(value, ["protocolVersion", "operationId", "version", "action"], "gitSshCommand");
        return {
          protocolVersion: requireProtocolVersion(value.protocolVersion),
          operationId: requireBoundedString(value.operationId, "operationId", MAX_OPERATION_ID_LENGTH),
          version: requirePositiveInt(value.version, "version"),
          action: "clear"
        };
      }
      if (value.action !== "install") {
        fail(`unknown gitSshCommand action: ${String(value.action)}`);
      }
      assertExactKeys(value, ["protocolVersion", "operationId", "version", "action", "privateKey", "publicKey"], "gitSshCommand");
      const { privateKey, publicKey } = value;
      if (typeof privateKey !== "string" || privateKey.length > MAX_PRIVATE_KEY_LENGTH || !OPENSSH_PRIVATE_KEY_PATTERN.test(privateKey)) {
        fail("privateKey \u5FC5\u987B\u662F OpenSSH \u79C1\u94A5\u88C5\u7532\u6587\u672C");
      }
      if (typeof publicKey !== "string" || publicKey.length > MAX_PUBLIC_KEY_LENGTH || !OPENSSH_PUBLIC_KEY_PATTERN.test(publicKey)) {
        fail("publicKey \u5FC5\u987B\u662F\u5355\u884C ssh-ed25519 \u516C\u94A5");
      }
      return {
        protocolVersion: requireProtocolVersion(value.protocolVersion),
        operationId: requireBoundedString(value.operationId, "operationId", MAX_OPERATION_ID_LENGTH),
        version: requirePositiveInt(value.version, "version"),
        action: "install",
        privateKey,
        publicKey
      };
    }
    function parseGitSshAck(value) {
      assertRecord(value, "gitSshAck");
      const state = value.state;
      if (state === "failed") {
        assertExactKeys(value, ["protocolVersion", "operationId", "version", "state", "code"], "gitSshAck");
        if (!exports2.GIT_SSH_FAILURE_CODES.includes(value.code)) {
          fail("gitSshAck.code \u5FC5\u987B\u4E3A\u5DF2\u77E5\u5931\u8D25\u7801");
        }
        return {
          protocolVersion: requireProtocolVersion(value.protocolVersion),
          operationId: requireBoundedString(value.operationId, "operationId", MAX_OPERATION_ID_LENGTH),
          version: requirePositiveInt(value.version, "version"),
          state: "failed",
          code: value.code
        };
      }
      if (state !== "installed" && state !== "cleared") {
        fail(`gitSshAck.state \u5FC5\u987B\u4E3A installed\u3001cleared \u6216 failed\uFF1A${String(state)}`);
      }
      assertExactKeys(value, ["protocolVersion", "operationId", "version", "state"], "gitSshAck");
      return {
        protocolVersion: requireProtocolVersion(value.protocolVersion),
        operationId: requireBoundedString(value.operationId, "operationId", MAX_OPERATION_ID_LENGTH),
        version: requirePositiveInt(value.version, "version"),
        state
      };
    }
    function parseGitSshCapability(value) {
      assertRecord(value, "gitSsh");
      if (value.available === true) {
        assertExactKeys(value, ["available", "protocolVersion"], "gitSsh");
        if (value.protocolVersion !== exports2.GIT_SSH_PROTOCOL_VERSION) {
          fail(`gitSsh.protocolVersion \u4E0D\u652F\u6301\uFF1A${String(value.protocolVersion)}`);
        }
        return { available: true, protocolVersion: exports2.GIT_SSH_PROTOCOL_VERSION };
      }
      if (value.available === false) {
        assertExactKeys(value, ["available", "code"], "gitSsh");
        if (value.code !== "GIT_SSH_UNAVAILABLE") {
          fail("gitSsh.code \u5FC5\u987B\u4E3A GIT_SSH_UNAVAILABLE");
        }
        return { available: false, code: "GIT_SSH_UNAVAILABLE" };
      }
      fail("gitSsh.available \u5FC5\u987B\u4E3A boolean");
    }
    function parseGitSshTargetInput(value) {
      assertRecord(value, "gitSshTargetInput");
      assertExactKeys(value, ["clientIds"], "gitSshTargetInput");
      const raw = value.clientIds;
      if (!Array.isArray(raw)) {
        fail("clientIds \u5FC5\u987B\u662F\u6570\u7EC4");
      }
      if (raw.length > exports2.GIT_SSH_MAX_TARGETS) {
        fail(`clientIds \u6570\u91CF\u4E0D\u5F97\u8D85\u8FC7 ${exports2.GIT_SSH_MAX_TARGETS}`);
      }
      const clientIds = raw.map((item, index) => requireBoundedString(item, `clientIds[${index}]`, MAX_CLIENT_ID_LENGTH));
      if (new Set(clientIds).size !== clientIds.length) {
        fail("clientIds \u5B58\u5728\u91CD\u590D\u9879");
      }
      return { clientIds };
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
      assertKeys(v, /* @__PURE__ */ new Set(["shellId", "cols", "rows", "parentRemoteDevSessionId"]), "create");
      assertString(v.shellId, "shellId", 64);
      if (typeof v.cols !== "number" || typeof v.rows !== "number" || !isValidTerminalSize(v.cols, v.rows)) {
        throw new TerminalProtocolError("create \u5C3A\u5BF8\u975E\u6CD5");
      }
      if (v.parentRemoteDevSessionId !== void 0) {
        assertString(v.parentRemoteDevSessionId, "parentRemoteDevSessionId", 128);
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

// ../shared/dist/job-log.js
var require_job_log = __commonJS({
  "../shared/dist/job-log.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.JobLogProtocolError = exports2.JOB_LOG_LIMITS = exports2.JOB_LOG_LEVELS = exports2.JOB_LOG_CLIENT_EVENTS = exports2.JOB_LOG_SERVER_EVENTS = void 0;
    exports2.parseJobLogLine = parseJobLogLine;
    exports2.JOB_LOG_SERVER_EVENTS = [
      "created",
      "dispatched",
      "output_first",
      "cancel_requested",
      "cancel_confirmed",
      "cancel_failed",
      "client_offline",
      "reconciled",
      "orphaned",
      "settled"
    ];
    exports2.JOB_LOG_CLIENT_EVENTS = [
      "received",
      "spawned",
      "exited",
      "local_settled",
      "cancel_received",
      "kill_failed",
      "drain_timeout"
    ];
    exports2.JOB_LOG_LEVELS = ["info", "warn", "error"];
    exports2.JOB_LOG_LIMITS = {
      /** jobId 最大长度（UUID 36，留余量给未来前缀）。 */
      maxJobId: 100,
      /** code 最大长度。 */
      maxCode: 64,
      /** message 最大长度（已脱敏文本）。 */
      maxMessage: 200,
      /** data 最多键数。 */
      maxDataKeys: 8,
      /** data 序列化后的最大字节数。 */
      maxDataBytes: 1024,
      /** 单个字符串型 data 值的最大长度。 */
      maxDataValue: 200,
      /** 每 Job 事件上限（超出时优先裁剪最旧的非 error 事件）。 */
      maxEventsPerJob: 200,
      /** 每 Job 允许的 Client 相位事件上限。 */
      maxClientEventsPerJob: 8,
      /** 每 Client 每分钟允许的相位事件数。 */
      clientEventsPerMinute: 30,
      /** 事件全局保留天数。 */
      retentionDays: 30
    };
    var JobLogProtocolError = class extends Error {
      code = "JOB_LOG_INVALID";
      constructor(message) {
        super(message);
        this.name = "JobLogProtocolError";
      }
    };
    exports2.JobLogProtocolError = JobLogProtocolError;
    var JOB_LOG_LINE_KEYS = /* @__PURE__ */ new Set([
      "jobId",
      "event",
      "level",
      "code",
      "message",
      "data",
      "clientAt"
    ]);
    function isPlainRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function requireShortString(value, field, maxLength) {
      if (typeof value !== "string" || value === "") {
        throw new JobLogProtocolError(`${field} must be a non-empty string`);
      }
      if (value.length > maxLength) {
        throw new JobLogProtocolError(`${field} exceeds ${maxLength} characters`);
      }
      return value;
    }
    function optionalShortString(value, field, maxLength) {
      if (value === void 0)
        return void 0;
      return requireShortString(value, field, maxLength);
    }
    function parseData(value) {
      if (value === void 0)
        return void 0;
      if (!isPlainRecord(value)) {
        throw new JobLogProtocolError("data must be a flat object");
      }
      const entries = Object.entries(value);
      if (entries.length > exports2.JOB_LOG_LIMITS.maxDataKeys) {
        throw new JobLogProtocolError(`data exceeds ${exports2.JOB_LOG_LIMITS.maxDataKeys} keys`);
      }
      const data = {};
      for (const [key, item] of entries) {
        if (key === "" || key.length > 64) {
          throw new JobLogProtocolError("data keys must be 1-64 characters");
        }
        if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
          if (typeof item === "string" && item.length > exports2.JOB_LOG_LIMITS.maxDataValue) {
            throw new JobLogProtocolError(`data.${key} exceeds ${exports2.JOB_LOG_LIMITS.maxDataValue} characters`);
          }
          if (typeof item === "number" && !Number.isFinite(item)) {
            throw new JobLogProtocolError(`data.${key} must be finite`);
          }
          data[key] = item;
          continue;
        }
        throw new JobLogProtocolError(`data.${key} must be a string, number or boolean`);
      }
      if (JSON.stringify(data).length > exports2.JOB_LOG_LIMITS.maxDataBytes) {
        throw new JobLogProtocolError(`data exceeds ${exports2.JOB_LOG_LIMITS.maxDataBytes} bytes`);
      }
      return data;
    }
    function parseJobLogLine(input) {
      if (!isPlainRecord(input)) {
        throw new JobLogProtocolError("job log line must be an object");
      }
      for (const key of Object.keys(input)) {
        if (!JOB_LOG_LINE_KEYS.has(key)) {
          throw new JobLogProtocolError(`unknown field: ${key}`);
        }
      }
      const jobId = requireShortString(input.jobId, "jobId", exports2.JOB_LOG_LIMITS.maxJobId);
      const event = input.event;
      if (typeof event !== "string" || !exports2.JOB_LOG_CLIENT_EVENTS.includes(event)) {
        throw new JobLogProtocolError("event is not a client job log event");
      }
      let level;
      if (input.level !== void 0) {
        if (typeof input.level !== "string" || !exports2.JOB_LOG_LEVELS.includes(input.level)) {
          throw new JobLogProtocolError("level must be info, warn or error");
        }
        level = input.level;
      }
      const code = optionalShortString(input.code, "code", exports2.JOB_LOG_LIMITS.maxCode);
      const message = optionalShortString(input.message, "message", exports2.JOB_LOG_LIMITS.maxMessage);
      const data = parseData(input.data);
      let clientAt;
      if (input.clientAt !== void 0) {
        clientAt = requireShortString(input.clientAt, "clientAt", 64);
        if (Number.isNaN(Date.parse(clientAt))) {
          throw new JobLogProtocolError("clientAt must be an ISO 8601 timestamp");
        }
      }
      const line = {
        jobId,
        event
      };
      if (level !== void 0)
        line.level = level;
      if (code !== void 0)
        line.code = code;
      if (message !== void 0)
        line.message = message;
      if (data !== void 0)
        line.data = data;
      if (clientAt !== void 0)
        line.clientAt = clientAt;
      return line;
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
    exports2.ClientInstallationComplianceReason = exports2.PrivilegedCapabilityMode = exports2.MachineInstallationMode = void 0;
    exports2.parseRemoteDevCapabilityStatus = parseRemoteDevCapabilityStatus;
    exports2.parseAcpCapabilityStatus = parseAcpCapabilityStatus;
    exports2.parseMachineInstallation = parseMachineInstallation;
    exports2.parsePrivilegedCapabilityStatus = parsePrivilegedCapabilityStatus;
    exports2.getClientInstallationCompliance = getClientInstallationCompliance;
    exports2.parseMachineRegister = parseMachineRegister;
    var frp_runtime_js_1 = require_frp_runtime();
    var git_ssh_js_1 = require_git_ssh();
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
      WINDOWS_SYSTEM_TASK: "windows-system-task",
      LEGACY_PM2: "legacy-pm2"
    };
    exports2.PrivilegedCapabilityMode = {
      SUDO_ALL: "sudo-all",
      WINDOWS_SYSTEM: "windows-system",
      UNAVAILABLE: "unavailable"
    };
    var RETIRED_DETAIL_KEYS = /* @__PURE__ */ new Set(["pi", "p2pTunnel"]);
    function parseRemoteDevCapabilityStatus(value) {
      if (!isRecord2(value))
        throw new Error("remoteDev \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      const allowed = /* @__PURE__ */ new Set(["available", "protocolVersion", "code"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key))
          throw new Error(`remoteDev \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      if (typeof value.available !== "boolean") {
        throw new Error("remoteDev.available \u5FC5\u987B\u4E3A boolean");
      }
      if (value.protocolVersion !== void 0 && (!Number.isInteger(value.protocolVersion) || value.protocolVersion < 1)) {
        throw new Error("remoteDev.protocolVersion \u5FC5\u987B\u4E3A\u6B63\u6574\u6570");
      }
      if (value.code !== void 0 && typeof value.code !== "string") {
        throw new Error("remoteDev.code \u5FC5\u987B\u4E3A string");
      }
      return {
        available: value.available,
        ...value.protocolVersion !== void 0 ? { protocolVersion: value.protocolVersion } : {},
        ...value.code !== void 0 ? { code: value.code } : {}
      };
    }
    function parseAcpCapabilityStatus(value) {
      if (!isRecord2(value))
        throw new Error("acp \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      const allowed = /* @__PURE__ */ new Set(["available", "protocolVersion", "code"]);
      for (const key of Object.keys(value)) {
        if (!allowed.has(key))
          throw new Error(`acp \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
      }
      if (typeof value.available !== "boolean") {
        throw new Error("acp.available \u5FC5\u987B\u4E3A boolean");
      }
      if (value.protocolVersion !== void 0 && (!Number.isInteger(value.protocolVersion) || value.protocolVersion < 1)) {
        throw new Error("acp.protocolVersion \u5FC5\u987B\u4E3A\u6B63\u6574\u6570");
      }
      if (value.code !== void 0 && typeof value.code !== "string") {
        throw new Error("acp.code \u5FC5\u987B\u4E3A string");
      }
      return {
        available: value.available,
        ...value.protocolVersion !== void 0 ? { protocolVersion: value.protocolVersion } : {},
        ...value.code !== void 0 ? { code: value.code } : {}
      };
    }
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
      const valid = [
        exports2.MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT,
        exports2.MachineInstallationMode.WINDOWS_SYSTEM_TASK,
        exports2.MachineInstallationMode.LEGACY_PM2
      ];
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
      if (mode !== exports2.PrivilegedCapabilityMode.SUDO_ALL && mode !== exports2.PrivilegedCapabilityMode.WINDOWS_SYSTEM && mode !== exports2.PrivilegedCapabilityMode.UNAVAILABLE) {
        throw new Error("privileged.mode \u5FC5\u987B\u4E3A sudo-all\u3001windows-system \u6216 unavailable");
      }
      const user = requireString(runAsUser, "privileged.runAsUser", MAX_RUN_AS_USER);
      if ((mode === exports2.PrivilegedCapabilityMode.SUDO_ALL || mode === exports2.PrivilegedCapabilityMode.WINDOWS_SYSTEM) && (available !== true || nonInteractive !== true)) {
        throw new Error(`privileged.mode=${mode} \u5FC5\u987B available=true \u4E14 nonInteractive=true`);
      }
      if (mode === exports2.PrivilegedCapabilityMode.UNAVAILABLE && nonInteractive !== false) {
        throw new Error("privileged.mode=unavailable \u5FC5\u987B nonInteractive=false");
      }
      return { available, mode, nonInteractive, runAsUser: user };
    }
    exports2.ClientInstallationComplianceReason = {
      /** 显式上报旧 PM2 安装模式 */
      LEGACY_PM2: "legacy-pm2",
      /** 安装模式未报告（旧 Client 缺字段） */
      INSTALLATION_UNREPORTED: "installation-unreported",
      /** 特权模式/可用性不满足系统级要求，或未报告 */
      PRIVILEGE_NONCOMPLIANT: "privilege-noncompliant",
      /** 安装模式与操作系统不匹配 */
      PLATFORM_MODE_MISMATCH: "platform-mode-mismatch",
      /** 不支持的操作系统 */
      PLATFORM_UNSUPPORTED: "platform-unsupported"
    };
    function getClientInstallationCompliance(client) {
      const mode = client.installation?.mode;
      if (mode === void 0) {
        return { compliant: false, reason: exports2.ClientInstallationComplianceReason.INSTALLATION_UNREPORTED };
      }
      if (mode === exports2.MachineInstallationMode.LEGACY_PM2) {
        return { compliant: false, reason: exports2.ClientInstallationComplianceReason.LEGACY_PM2 };
      }
      const isWin = client.os.startsWith("win32");
      const isLinux = client.os.startsWith("linux");
      if (!isWin && !isLinux) {
        return { compliant: false, reason: exports2.ClientInstallationComplianceReason.PLATFORM_UNSUPPORTED };
      }
      const expected = isWin ? exports2.MachineInstallationMode.WINDOWS_SYSTEM_TASK : exports2.MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT;
      if (mode !== expected) {
        return { compliant: false, reason: exports2.ClientInstallationComplianceReason.PLATFORM_MODE_MISMATCH };
      }
      const privileged = client.capabilityDetails?.privileged;
      const expectedPrivilege = isWin ? exports2.PrivilegedCapabilityMode.WINDOWS_SYSTEM : exports2.PrivilegedCapabilityMode.SUDO_ALL;
      if (privileged === void 0 || privileged.mode !== expectedPrivilege || privileged.available !== true || privileged.nonInteractive !== true) {
        return { compliant: false, reason: exports2.ClientInstallationComplianceReason.PRIVILEGE_NONCOMPLIANT };
      }
      return { compliant: true, reason: null };
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
        const known = ["terminal", "frp", "privileged", "gitSsh", "acp", "remoteDev"];
        for (const key of Object.keys(details)) {
          if (RETIRED_DETAIL_KEYS.has(key))
            continue;
          if (!known.includes(key)) {
            throw new Error(`capabilityDetails \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
          }
        }
        const parsedDetails = {};
        if (details.terminal !== void 0) {
          parsedDetails.terminal = details.terminal;
        }
        if (details.frp !== void 0) {
          parsedDetails.frp = (0, frp_runtime_js_1.parseFrpCapabilityStatus)(details.frp);
        }
        if (details.privileged !== void 0) {
          parsedDetails.privileged = parsePrivilegedCapabilityStatus(details.privileged);
        }
        if (details.gitSsh !== void 0) {
          parsedDetails.gitSsh = (0, git_ssh_js_1.parseGitSshCapability)(details.gitSsh);
        }
        if (details.acp !== void 0) {
          parsedDetails.acp = parseAcpCapabilityStatus(details.acp);
        }
        if (details.remoteDev !== void 0) {
          parsedDetails.remoteDev = parseRemoteDevCapabilityStatus(details.remoteDev);
        }
        result.capabilityDetails = parsedDetails;
      }
      if (value.installation !== void 0) {
        result.installation = parseMachineInstallation(value.installation);
      }
      if (value.remoteDevSessions !== void 0) {
        result.remoteDevSessions = parseRemoteDevSessionReports(value.remoteDevSessions);
      }
      return result;
    }
    var MAX_REMOTE_DEV_SESSION_REPORTS = 64;
    function parseRemoteDevSessionReports(value) {
      if (!Array.isArray(value)) {
        throw new Error("remoteDevSessions \u5FC5\u987B\u4E3A\u6570\u7EC4");
      }
      if (value.length > MAX_REMOTE_DEV_SESSION_REPORTS) {
        throw new Error(`remoteDevSessions \u8D85\u8FC7 ${MAX_REMOTE_DEV_SESSION_REPORTS} \u9879`);
      }
      return value.map((item, index) => {
        if (!isRecord2(item)) {
          throw new Error(`remoteDevSessions[${index}] \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
        }
        for (const key of Object.keys(item)) {
          if (key !== "sessionId" && key !== "generationId") {
            throw new Error(`remoteDevSessions[${index}] \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
          }
        }
        return {
          sessionId: requireString(item.sessionId, `remoteDevSessions[${index}].sessionId`, 128),
          generationId: requireString(item.generationId, `remoteDevSessions[${index}].generationId`, 128)
        };
      });
    }
  }
});

// ../shared/dist/feature.js
var require_feature = __commonJS({
  "../shared/dist/feature.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.FEATURE_ERROR_CODES = exports2.FeatureProtocolError = exports2.FEATURE_VERIFICATION_SOURCES = exports2.FEATURE_STALE_AFTER_DAYS = exports2.FEATURE_STATUSES = exports2.FEATURE_SCOPES = void 0;
    exports2.parseFeatureInvocation = parseFeatureInvocation;
    exports2.parseFeatureInputs = parseFeatureInputs;
    exports2.parseFeatureVerificationReport = parseFeatureVerificationReport;
    exports2.parseFeatureCreateInput = parseFeatureCreateInput;
    exports2.parseFeatureUpdateInput = parseFeatureUpdateInput;
    exports2.parseFeatureContract = parseFeatureContract;
    exports2.getFeatureFreshness = getFeatureFreshness;
    exports2.FEATURE_SCOPES = ["generic", "machine"];
    exports2.FEATURE_STATUSES = ["draft", "active", "retired"];
    exports2.FEATURE_STALE_AFTER_DAYS = 14;
    exports2.FEATURE_VERIFICATION_SOURCES = ["cli", "agent", "api"];
    var DAY_MS = 864e5;
    var DEFAULT_TIMEOUT_SECONDS = 60;
    var MAX_TIMEOUT_SECONDS = 3600;
    var MAX_CLIENT_ID = 128;
    var MAX_SLUG = 63;
    var MAX_NAME = 120;
    var MAX_SUMMARY = 500;
    var MAX_COMMAND = 4e3;
    var MAX_URL = 2048;
    var MAX_OUTPUT = 2e3;
    var MAX_NOTES = 8e3;
    var MAX_EVIDENCE = 2e3;
    var MAX_INPUTS = 20;
    var MAX_INPUT_DESCRIPTION = 200;
    var MAX_EXAMPLE = 200;
    var MAX_OPTIONS = 20;
    var MAX_OPTION_LENGTH = 120;
    var SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
    var INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
    var FeatureProtocolError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "FeatureProtocolError";
      }
    };
    exports2.FeatureProtocolError = FeatureProtocolError;
    exports2.FEATURE_ERROR_CODES = [
      "FEATURE_NOT_FOUND",
      "FEATURE_SLUG_TAKEN",
      "INVALID_FEATURE_INPUT",
      "INVALID_FEATURE_STATUS_TRANSITION",
      "FEATURE_CLIENT_UNKNOWN"
    ];
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function rejectUnknown(value, allowed, field) {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
          throw new FeatureProtocolError(`${field} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
    }
    function hasControlCharacters(value) {
      for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) {
          return true;
        }
      }
      return false;
    }
    function parseText(value, field, maxLength, allowEmpty = false) {
      if (typeof value !== "string") {
        throw new FeatureProtocolError(`${field} \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32`);
      }
      const trimmed = value.trim();
      if (!allowEmpty && trimmed.length === 0) {
        throw new FeatureProtocolError(`${field} \u4E0D\u80FD\u4E3A\u7A7A`);
      }
      if (trimmed.length > maxLength) {
        throw new FeatureProtocolError(`${field} \u4E0D\u80FD\u8D85\u8FC7 ${maxLength} \u5B57\u7B26`);
      }
      if (hasControlCharacters(trimmed)) {
        throw new FeatureProtocolError(`${field} \u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26`);
      }
      return trimmed;
    }
    function parseTimeout(value) {
      if (value === void 0)
        return DEFAULT_TIMEOUT_SECONDS;
      if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
        throw new FeatureProtocolError(`timeoutSeconds \u5FC5\u987B\u662F 1-${MAX_TIMEOUT_SECONDS} \u7684\u6574\u6570`);
      }
      return value;
    }
    function parseUrl(value, field) {
      const url = parseText(value, field, MAX_URL);
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new FeatureProtocolError(`${field} \u4E0D\u662F\u5408\u6CD5 URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new FeatureProtocolError(`${field} \u53EA\u652F\u6301 http/https`);
      }
      if (parsed.username !== "" || parsed.password !== "") {
        throw new FeatureProtocolError(`${field} \u4E0D\u5F97\u5305\u542B userinfo\uFF08user:pass@\uFF09`);
      }
      return url;
    }
    function parseFeatureInvocation(value, field = "invoke") {
      if (!isRecord2(value)) {
        throw new FeatureProtocolError(`${field} \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
      }
      if (value.kind === "command") {
        rejectUnknown(value, ["kind", "command", "timeoutSeconds"], field);
        return {
          kind: "command",
          command: parseText(value.command, `${field}.command`, MAX_COMMAND),
          timeoutSeconds: parseTimeout(value.timeoutSeconds)
        };
      }
      if (value.kind === "http") {
        rejectUnknown(value, ["kind", "method", "url", "timeoutSeconds"], field);
        if (value.method !== "GET" && value.method !== "POST") {
          throw new FeatureProtocolError(`${field}.method \u5FC5\u987B\u662F GET \u6216 POST`);
        }
        return {
          kind: "http",
          method: value.method,
          url: parseUrl(value.url, `${field}.url`),
          timeoutSeconds: parseTimeout(value.timeoutSeconds)
        };
      }
      throw new FeatureProtocolError(`${field}.kind \u5FC5\u987B\u662F command \u6216 http`);
    }
    function parseOptionalText(value, field, maxLength) {
      return value === void 0 ? void 0 : parseText(value, field, maxLength);
    }
    function parseFeatureInputs(value) {
      if (value === void 0)
        return [];
      if (!Array.isArray(value)) {
        throw new FeatureProtocolError("inputs \u5FC5\u987B\u4E3A\u6570\u7EC4");
      }
      if (value.length > MAX_INPUTS) {
        throw new FeatureProtocolError(`inputs \u6700\u591A ${MAX_INPUTS} \u9879`);
      }
      const seen = /* @__PURE__ */ new Set();
      return value.map((raw, index) => {
        const field = `inputs[${index}]`;
        if (!isRecord2(raw)) {
          throw new FeatureProtocolError(`${field} \u5FC5\u987B\u4E3A\u5BF9\u8C61`);
        }
        rejectUnknown(raw, ["name", "type", "required", "description", "example", "options"], field);
        const name = typeof raw.name === "string" ? raw.name : "";
        if (!INPUT_NAME_PATTERN.test(name)) {
          throw new FeatureProtocolError(`${field}.name \u683C\u5F0F\u65E0\u6548`);
        }
        if (seen.has(name)) {
          throw new FeatureProtocolError(`inputs \u542B\u91CD\u590D name: ${name}`);
        }
        seen.add(name);
        const type = raw.type;
        if (type !== "string" && type !== "number" && type !== "boolean" && type !== "enum" && type !== "path") {
          throw new FeatureProtocolError(`${field}.type \u5FC5\u987B\u662F string/number/boolean/enum/path`);
        }
        if (typeof raw.required !== "boolean") {
          throw new FeatureProtocolError(`${field}.required \u5FC5\u987B\u4E3A boolean`);
        }
        const param = {
          name,
          type,
          required: raw.required,
          description: parseText(raw.description, `${field}.description`, MAX_INPUT_DESCRIPTION)
        };
        const example = parseOptionalText(raw.example, `${field}.example`, MAX_EXAMPLE);
        if (example !== void 0)
          param.example = example;
        let options;
        if (raw.options !== void 0) {
          if (type !== "enum") {
            throw new FeatureProtocolError(`${field}.options \u4EC5 enum \u53EF\u7528`);
          }
          if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_OPTIONS) {
            throw new FeatureProtocolError(`${field}.options \u5FC5\u987B\u4E3A 1-${MAX_OPTIONS} \u9879\u6570\u7EC4`);
          }
          options = raw.options.map((option, optionIndex) => parseText(option, `${field}.options[${optionIndex}]`, MAX_OPTION_LENGTH));
        }
        if (type === "enum" && options === void 0) {
          throw new FeatureProtocolError(`${field}.options \u5728 enum \u7C7B\u578B\u4E0B\u5FC5\u586B`);
        }
        if (options !== void 0)
          param.options = options;
        return param;
      });
    }
    function parseFeatureVerificationReport(value) {
      if (!isRecord2(value)) {
        throw new FeatureProtocolError("verification \u5FC5\u987B\u4E3A\u5BF9\u8C61");
      }
      rejectUnknown(value, ["ok", "durationMs", "evidence", "via"], "verification");
      if (typeof value.ok !== "boolean") {
        throw new FeatureProtocolError("verification.ok \u5FC5\u987B\u4E3A boolean");
      }
      if (value.via !== "cli" && value.via !== "agent" && value.via !== "api") {
        throw new FeatureProtocolError("verification.via \u5FC5\u987B\u662F cli/agent/api");
      }
      const report = { ok: value.ok, via: value.via };
      if (value.durationMs !== void 0) {
        if (!Number.isInteger(value.durationMs) || value.durationMs < 0) {
          throw new FeatureProtocolError("verification.durationMs \u5FC5\u987B\u4E3A\u975E\u8D1F\u6574\u6570");
        }
        report.durationMs = value.durationMs;
      }
      if (value.evidence !== void 0) {
        if (typeof value.evidence !== "string") {
          throw new FeatureProtocolError("verification.evidence \u5FC5\u987B\u4E3A\u5B57\u7B26\u4E32");
        }
        const evidence = value.evidence.slice(0, MAX_EVIDENCE);
        if (hasControlCharacters(evidence.replace(/[\n\r\t]/g, " "))) {
          throw new FeatureProtocolError("verification.evidence \u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26");
        }
        report.evidence = evidence;
      }
      return report;
    }
    function parseFeatureCreateInput(value) {
      if (!isRecord2(value)) {
        throw new FeatureProtocolError("\u529F\u80FD\u6761\u76EE\u5FC5\u987B\u662F\u5BF9\u8C61");
      }
      rejectUnknown(value, [
        "clientId",
        "slug",
        "name",
        "summary",
        "scope",
        "invoke",
        "verify",
        "inputs",
        "output",
        "notes",
        "sourceJobId",
        "verification"
      ], "feature");
      const slug = typeof value.slug === "string" ? value.slug : "";
      if (slug.length > MAX_SLUG || !SLUG_PATTERN.test(slug)) {
        throw new FeatureProtocolError("slug \u5FC5\u987B\u4E3A 1-63 \u4F4D\u5C0F\u5199 kebab-case");
      }
      if (value.scope !== "generic" && value.scope !== "machine") {
        throw new FeatureProtocolError("scope \u5FC5\u987B\u662F generic \u6216 machine");
      }
      const input = {
        clientId: parseText(value.clientId, "clientId", MAX_CLIENT_ID),
        slug,
        name: parseText(value.name, "name", MAX_NAME),
        summary: parseText(value.summary, "summary", MAX_SUMMARY),
        scope: value.scope,
        invoke: parseFeatureInvocation(value.invoke, "invoke"),
        verify: parseFeatureInvocation(value.verify, "verify"),
        inputs: parseFeatureInputs(value.inputs),
        output: value.output === void 0 ? "" : parseText(value.output, "output", MAX_OUTPUT, true),
        notes: value.notes === void 0 ? "" : parseText(value.notes, "notes", MAX_NOTES, true),
        sourceJobId: value.sourceJobId === void 0 || value.sourceJobId === null ? null : parseText(value.sourceJobId, "sourceJobId", MAX_CLIENT_ID)
      };
      if (value.verification !== void 0) {
        input.verification = parseFeatureVerificationReport(value.verification);
      }
      return input;
    }
    function parseFeatureUpdateInput(value) {
      if (!isRecord2(value)) {
        throw new FeatureProtocolError("\u66F4\u65B0\u8BF7\u6C42\u5FC5\u987B\u662F\u5BF9\u8C61");
      }
      if (Object.keys(value).length === 0) {
        throw new FeatureProtocolError("\u66F4\u65B0\u8BF7\u6C42\u4E0D\u80FD\u4E3A\u7A7A\u5BF9\u8C61");
      }
      rejectUnknown(value, [
        "name",
        "summary",
        "scope",
        "invoke",
        "verify",
        "inputs",
        "output",
        "notes",
        "status"
      ], "feature");
      const input = {};
      if (value.name !== void 0)
        input.name = parseText(value.name, "name", MAX_NAME);
      if (value.summary !== void 0) {
        input.summary = parseText(value.summary, "summary", MAX_SUMMARY);
      }
      if (value.scope !== void 0) {
        if (value.scope !== "generic" && value.scope !== "machine") {
          throw new FeatureProtocolError("scope \u5FC5\u987B\u662F generic \u6216 machine");
        }
        input.scope = value.scope;
      }
      if (value.invoke !== void 0) {
        input.invoke = parseFeatureInvocation(value.invoke, "invoke");
      }
      if (value.verify !== void 0) {
        input.verify = parseFeatureInvocation(value.verify, "verify");
      }
      if (value.inputs !== void 0)
        input.inputs = parseFeatureInputs(value.inputs);
      if (value.output !== void 0) {
        input.output = parseText(value.output, "output", MAX_OUTPUT, true);
      }
      if (value.notes !== void 0) {
        input.notes = parseText(value.notes, "notes", MAX_NOTES, true);
      }
      if (value.status !== void 0) {
        if (value.status !== "draft" && value.status !== "retired") {
          throw new FeatureProtocolError("status \u53EA\u80FD\u6539\u4E3A draft \u6216 retired\uFF1Bactive \u53EA\u80FD\u7531\u9A8C\u8BC1\u4EA7\u751F");
        }
        input.status = value.status;
      }
      return input;
    }
    function parseFeatureContract(invoke, verify, inputs) {
      return {
        invoke: parseFeatureInvocation(invoke, "invoke"),
        verify: parseFeatureInvocation(verify, "verify"),
        inputs: parseFeatureInputs(inputs)
      };
    }
    function getFeatureFreshness(lastVerifiedAt, now = /* @__PURE__ */ new Date()) {
      if (lastVerifiedAt === null)
        return "never";
      const verifiedAt = new Date(lastVerifiedAt).getTime();
      if (Number.isNaN(verifiedAt))
        return "never";
      return now.getTime() - verifiedAt > exports2.FEATURE_STALE_AFTER_DAYS * DAY_MS ? "stale" : "fresh";
    }
  }
});

// ../shared/dist/a2a.js
var require_a2a = __commonJS({
  "../shared/dist/a2a.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.AGENT_ADAPTERS = exports2.A2aProtocolError = exports2.A2A_LIMITS = exports2.ACP_PERMISSION_EXTENSION_URI = exports2.TASK_LIFECYCLE_STATES = exports2.A2A_TASK_STATES = void 0;
    exports2.toA2aTaskState = toA2aTaskState;
    exports2.fromA2aTaskState = fromA2aTaskState;
    exports2.isA2aTaskState = isA2aTaskState;
    exports2.toA2aTask = toA2aTask;
    exports2.parseA2aJsonRpcRequest = parseA2aJsonRpcRequest;
    exports2.parseAgentPlacementInput = parseAgentPlacementInput;
    exports2.parseAgentPlacementUpdate = parseAgentPlacementUpdate;
    exports2.A2A_TASK_STATES = [
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_AUTH_REQUIRED",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_REJECTED",
      "TASK_STATE_FAILED"
    ];
    exports2.TASK_LIFECYCLE_STATES = [
      "submitted",
      "working",
      "input-required",
      "auth-required",
      "completed",
      "canceled",
      "rejected",
      "failed"
    ];
    var TO_A2A_STATE = {
      submitted: "TASK_STATE_SUBMITTED",
      working: "TASK_STATE_WORKING",
      "input-required": "TASK_STATE_INPUT_REQUIRED",
      "auth-required": "TASK_STATE_AUTH_REQUIRED",
      completed: "TASK_STATE_COMPLETED",
      canceled: "TASK_STATE_CANCELED",
      rejected: "TASK_STATE_REJECTED",
      failed: "TASK_STATE_FAILED"
    };
    var FROM_A2A_STATE = {
      TASK_STATE_SUBMITTED: "submitted",
      TASK_STATE_WORKING: "working",
      TASK_STATE_INPUT_REQUIRED: "input-required",
      TASK_STATE_AUTH_REQUIRED: "auth-required",
      TASK_STATE_COMPLETED: "completed",
      TASK_STATE_CANCELED: "canceled",
      TASK_STATE_REJECTED: "rejected",
      TASK_STATE_FAILED: "failed"
    };
    function toA2aTaskState(state) {
      return TO_A2A_STATE[state];
    }
    function fromA2aTaskState(state) {
      return FROM_A2A_STATE[state];
    }
    function isA2aTaskState(value) {
      return typeof value === "string" && exports2.A2A_TASK_STATES.includes(value);
    }
    exports2.ACP_PERMISSION_EXTENSION_URI = "https://vcpdeck.dev/a2a/extensions/acp-permission/v1";
    exports2.A2A_LIMITS = {
      maxMessageBytes: 64 * 1024,
      maxTextParts: 32,
      maxMessageIdBytes: 128,
      maxTaskIdBytes: 128,
      maxContextIdBytes: 128,
      maxAgentIdBytes: 128,
      maxIntentBytes: 4096,
      maxCriteria: 32,
      maxCriterionBytes: 1024,
      maxConstraintItems: 64,
      maxConstraintBytes: 1024,
      maxPermissionIdBytes: 128,
      maxHistoryLength: 1e3,
      maxPageSize: 100,
      maxPageTokenBytes: 512
    };
    var A2aProtocolError = class extends Error {
      rpcCode;
      code = "A2A_PROTOCOL_INVALID";
      constructor(message, rpcCode = -32600) {
        super(message);
        this.rpcCode = rpcCode;
        this.name = "A2aProtocolError";
      }
    };
    exports2.A2aProtocolError = A2aProtocolError;
    function toA2aTask(info, history) {
      return {
        id: info.id,
        contextId: info.contextId,
        status: {
          state: toA2aTaskState(info.state),
          timestamp: info.updatedAt
        },
        artifacts: info.artifacts,
        ...history && history.length > 0 ? { history } : {},
        metadata: {
          vcpdeck: {
            agentId: info.agentId,
            intent: info.intent,
            acceptanceCriteria: info.acceptanceCriteria,
            constraints: info.constraints,
            createdAt: info.createdAt,
            updatedAt: info.updatedAt,
            verdict: info.verdict ?? null
          }
        }
      };
    }
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function assertRecord(value, what) {
      if (!isRecord2(value))
        throw new A2aProtocolError(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
    }
    function assertKeys(value, allowed, what) {
      const set = new Set(allowed);
      for (const key of Object.keys(value)) {
        if (!set.has(key)) {
          throw new A2aProtocolError(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
    }
    function utf8ByteLength(value) {
      return new TextEncoder().encode(value).byteLength;
    }
    function assertString(value, what, maxBytes) {
      if (typeof value !== "string" || value.length === 0) {
        throw new A2aProtocolError(`${what} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
      if (utf8ByteLength(value) > maxBytes) {
        throw new A2aProtocolError(`${what} \u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650`);
      }
    }
    function assertOptionalString(value, what, maxBytes) {
      if (value !== void 0)
        assertString(value, what, maxBytes);
    }
    function assertBoolean(value, what) {
      if (typeof value !== "boolean") {
        throw new A2aProtocolError(`${what} \u5FC5\u987B\u662F boolean`);
      }
    }
    function assertInteger(value, what, min, max) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new A2aProtocolError(`${what} \u5FC5\u987B\u662F ${min}-${max} \u7684\u6574\u6570`);
      }
    }
    function parseStringArray(value, what, maxItems, maxItemBytes) {
      if (!Array.isArray(value) || value.length > maxItems) {
        throw new A2aProtocolError(`${what} \u5FC5\u987B\u662F\u4E0D\u8D85\u8FC7 ${maxItems} \u9879\u7684\u6570\u7EC4`);
      }
      return value.map((item, index) => {
        assertString(item, `${what}[${index}]`, maxItemBytes);
        return item;
      });
    }
    function parseConstraints(value) {
      assertRecord(value, "constraints");
      assertKeys(value, ["allowedPaths", "allowedCommands", "requiredArtifacts"], "constraints");
      const result = {};
      if (value.allowedPaths !== void 0) {
        result.allowedPaths = parseStringArray(value.allowedPaths, "constraints.allowedPaths", exports2.A2A_LIMITS.maxConstraintItems, exports2.A2A_LIMITS.maxConstraintBytes);
      }
      if (value.allowedCommands !== void 0) {
        result.allowedCommands = parseStringArray(value.allowedCommands, "constraints.allowedCommands", exports2.A2A_LIMITS.maxConstraintItems, exports2.A2A_LIMITS.maxConstraintBytes);
      }
      if (value.requiredArtifacts !== void 0) {
        result.requiredArtifacts = parseStringArray(value.requiredArtifacts, "constraints.requiredArtifacts", exports2.A2A_LIMITS.maxConstraintItems, exports2.A2A_LIMITS.maxConstraintBytes);
      }
      return result;
    }
    function parsePermissionExtension(value) {
      assertRecord(value, "extensions.permission");
      assertKeys(value, ["requestId", "optionId"], "extensions.permission");
      assertString(value.requestId, "extensions.permission.requestId", exports2.A2A_LIMITS.maxPermissionIdBytes);
      assertString(value.optionId, "extensions.permission.optionId", exports2.A2A_LIMITS.maxPermissionIdBytes);
      return { requestId: value.requestId, optionId: value.optionId };
    }
    function parseExtensions(value) {
      assertRecord(value, "metadata.extensions");
      assertKeys(value, [exports2.ACP_PERMISSION_EXTENSION_URI], "metadata.extensions");
      const result = {};
      if (value[exports2.ACP_PERMISSION_EXTENSION_URI] !== void 0) {
        result[exports2.ACP_PERMISSION_EXTENSION_URI] = parsePermissionExtension(value[exports2.ACP_PERMISSION_EXTENSION_URI]);
      }
      return result;
    }
    function parseMetadata(value) {
      assertRecord(value, "metadata");
      assertKeys(value, [
        "agentId",
        "intent",
        "acceptanceCriteria",
        "constraints",
        "extensions"
      ], "metadata");
      const result = {};
      if (value.agentId !== void 0) {
        assertString(value.agentId, "metadata.agentId", exports2.A2A_LIMITS.maxAgentIdBytes);
        result.agentId = value.agentId;
      }
      if (value.intent !== void 0) {
        assertString(value.intent, "metadata.intent", exports2.A2A_LIMITS.maxIntentBytes);
        result.intent = value.intent;
      }
      if (value.acceptanceCriteria !== void 0) {
        result.acceptanceCriteria = parseStringArray(value.acceptanceCriteria, "metadata.acceptanceCriteria", exports2.A2A_LIMITS.maxCriteria, exports2.A2A_LIMITS.maxCriterionBytes);
      }
      if (value.constraints !== void 0) {
        result.constraints = parseConstraints(value.constraints);
      }
      if (value.extensions !== void 0) {
        result.extensions = parseExtensions(value.extensions);
      }
      return result;
    }
    function parseMessage(value) {
      assertRecord(value, "message");
      assertKeys(value, ["messageId", "role", "parts", "contextId", "taskId"], "message");
      assertString(value.messageId, "message.messageId", exports2.A2A_LIMITS.maxMessageIdBytes);
      if (value.role !== "user" && value.role !== "agent") {
        throw new A2aProtocolError("message.role \u5FC5\u987B\u662F user \u6216 agent");
      }
      if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > exports2.A2A_LIMITS.maxTextParts) {
        throw new A2aProtocolError(`message.parts \u5FC5\u987B\u662F 1-${exports2.A2A_LIMITS.maxTextParts} \u9879\u6570\u7EC4`);
      }
      let totalBytes = 0;
      const parts = value.parts.map((part, index) => {
        assertRecord(part, `message.parts[${index}]`);
        assertKeys(part, ["text"], `message.parts[${index}]`);
        assertString(part.text, `message.parts[${index}].text`, exports2.A2A_LIMITS.maxMessageBytes);
        totalBytes += utf8ByteLength(part.text);
        return { text: part.text };
      });
      if (totalBytes > exports2.A2A_LIMITS.maxMessageBytes) {
        throw new A2aProtocolError(`message.parts \u603B\u957F\u5EA6\u8D85\u8FC7 ${exports2.A2A_LIMITS.maxMessageBytes} \u5B57\u8282\u4E0A\u9650`);
      }
      assertOptionalString(value.contextId, "message.contextId", exports2.A2A_LIMITS.maxContextIdBytes);
      assertOptionalString(value.taskId, "message.taskId", exports2.A2A_LIMITS.maxTaskIdBytes);
      const contextId = value.contextId;
      const taskId = value.taskId;
      return {
        messageId: value.messageId,
        role: value.role,
        parts,
        ...contextId !== void 0 ? { contextId } : {},
        ...taskId !== void 0 ? { taskId } : {}
      };
    }
    function parseConfiguration(value) {
      assertRecord(value, "configuration");
      assertKeys(value, ["returnImmediately", "historyLength"], "configuration");
      const result = {};
      if (value.returnImmediately !== void 0) {
        assertBoolean(value.returnImmediately, "configuration.returnImmediately");
        result.returnImmediately = value.returnImmediately;
      }
      if (value.historyLength !== void 0) {
        assertInteger(value.historyLength, "configuration.historyLength", 0, exports2.A2A_LIMITS.maxHistoryLength);
        result.historyLength = value.historyLength;
      }
      return result;
    }
    function parseSendMessageParams(value) {
      assertRecord(value, "params");
      assertKeys(value, ["message", "configuration", "metadata"], "params");
      const result = {
        message: parseMessage(value.message)
      };
      if (value.configuration !== void 0) {
        result.configuration = parseConfiguration(value.configuration);
      }
      if (value.metadata !== void 0) {
        result.metadata = parseMetadata(value.metadata);
      }
      return result;
    }
    function parseGetTaskParams(value) {
      assertRecord(value, "params");
      assertKeys(value, ["id", "historyLength"], "params");
      assertString(value.id, "params.id", exports2.A2A_LIMITS.maxTaskIdBytes);
      const result = { id: value.id };
      if (value.historyLength !== void 0) {
        assertInteger(value.historyLength, "params.historyLength", 0, exports2.A2A_LIMITS.maxHistoryLength);
        result.historyLength = value.historyLength;
      }
      return result;
    }
    function parseListTasksParams(value) {
      assertRecord(value, "params");
      assertKeys(value, [
        "contextId",
        "status",
        "pageSize",
        "pageToken",
        "historyLength",
        "includeArtifacts"
      ], "params");
      const result = {};
      if (value.contextId !== void 0) {
        assertString(value.contextId, "params.contextId", exports2.A2A_LIMITS.maxContextIdBytes);
        result.contextId = value.contextId;
      }
      if (value.status !== void 0) {
        if (!isA2aTaskState(value.status)) {
          throw new A2aProtocolError("params.status \u975E\u6CD5");
        }
        result.status = value.status;
      }
      if (value.pageSize !== void 0) {
        assertInteger(value.pageSize, "params.pageSize", 1, exports2.A2A_LIMITS.maxPageSize);
        result.pageSize = value.pageSize;
      }
      if (value.pageToken !== void 0) {
        assertString(value.pageToken, "params.pageToken", exports2.A2A_LIMITS.maxPageTokenBytes);
        result.pageToken = value.pageToken;
      }
      if (value.historyLength !== void 0) {
        assertInteger(value.historyLength, "params.historyLength", 0, exports2.A2A_LIMITS.maxHistoryLength);
        result.historyLength = value.historyLength;
      }
      if (value.includeArtifacts !== void 0) {
        assertBoolean(value.includeArtifacts, "params.includeArtifacts");
        result.includeArtifacts = value.includeArtifacts;
      }
      return result;
    }
    function parseCancelTaskParams(value) {
      assertRecord(value, "params");
      assertKeys(value, ["id"], "params");
      assertString(value.id, "params.id", exports2.A2A_LIMITS.maxTaskIdBytes);
      return { id: value.id };
    }
    function parseA2aJsonRpcRequest(value) {
      assertRecord(value, "request");
      assertKeys(value, ["jsonrpc", "id", "method", "params"], "request");
      if (value.jsonrpc !== "2.0") {
        throw new A2aProtocolError("jsonrpc \u5FC5\u987B\u662F 2.0");
      }
      if (typeof value.id !== "string" && typeof value.id !== "number") {
        throw new A2aProtocolError("id \u5FC5\u987B\u662F string \u6216 number");
      }
      if (typeof value.id === "string" && value.id.length === 0) {
        throw new A2aProtocolError("id \u4E0D\u5F97\u4E3A\u7A7A\u5B57\u7B26\u4E32");
      }
      if (typeof value.id === "number" && !Number.isFinite(value.id)) {
        throw new A2aProtocolError("id \u5FC5\u987B\u662F\u6709\u9650\u6570\u5B57");
      }
      switch (value.method) {
        case "SendMessage":
          return {
            jsonrpc: "2.0",
            id: value.id,
            method: "SendMessage",
            params: parseSendMessageParams(value.params)
          };
        case "GetTask":
          return {
            jsonrpc: "2.0",
            id: value.id,
            method: "GetTask",
            params: parseGetTaskParams(value.params)
          };
        case "ListTasks":
          return {
            jsonrpc: "2.0",
            id: value.id,
            method: "ListTasks",
            params: parseListTasksParams(value.params)
          };
        case "CancelTask":
          return {
            jsonrpc: "2.0",
            id: value.id,
            method: "CancelTask",
            params: parseCancelTaskParams(value.params)
          };
        default:
          throw new A2aProtocolError(`\u672A\u77E5 method ${String(value.method)}`, -32601);
      }
    }
    exports2.AGENT_ADAPTERS = ["acp", "cli"];
    var AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
    function parseAgentArgs(value) {
      return parseStringArray(value, "args", 64, 1024);
    }
    function parseAgentWorkspaceRoots(value) {
      return parseStringArray(value, "workspaceRoots", 32, 2048);
    }
    function parseAgentSkills(value) {
      return parseStringArray(value, "skills", 32, 128);
    }
    function parseAgentAdapter(value) {
      if (value !== "acp" && value !== "cli") {
        throw new A2aProtocolError("adapter \u5FC5\u987B\u662F acp \u6216 cli");
      }
      return value;
    }
    function parseAgentPlacementInput(value) {
      assertRecord(value, "agent placement");
      assertKeys(value, [
        "agentId",
        "name",
        "adapter",
        "clientId",
        "command",
        "args",
        "cwd",
        "workspaceRoots",
        "skills",
        "enabled"
      ], "agent placement");
      assertString(value.agentId, "agentId", 64);
      if (!AGENT_ID_PATTERN.test(value.agentId)) {
        throw new A2aProtocolError("agentId \u5FC5\u987B\u662F\u5C0F\u5199 slug");
      }
      assertString(value.name, "name", 128);
      const adapter = parseAgentAdapter(value.adapter);
      assertString(value.clientId, "clientId", 128);
      assertString(value.command, "command", 1024);
      const args = parseAgentArgs(value.args);
      assertString(value.cwd, "cwd", 2048);
      const workspaceRoots = parseAgentWorkspaceRoots(value.workspaceRoots);
      const result = {
        agentId: value.agentId,
        name: value.name,
        adapter,
        clientId: value.clientId,
        command: value.command,
        args,
        cwd: value.cwd,
        workspaceRoots
      };
      if (value.skills !== void 0) {
        result.skills = parseAgentSkills(value.skills);
      }
      if (value.enabled !== void 0) {
        assertBoolean(value.enabled, "enabled");
        result.enabled = value.enabled;
      }
      return result;
    }
    function parseAgentPlacementUpdate(value) {
      assertRecord(value, "agent placement update");
      assertKeys(value, [
        "name",
        "adapter",
        "command",
        "args",
        "cwd",
        "workspaceRoots",
        "skills",
        "enabled"
      ], "agent placement update");
      if (Object.keys(value).length === 0) {
        throw new A2aProtocolError("placement update \u4E0D\u5F97\u4E3A\u7A7A");
      }
      const result = {};
      if (value.name !== void 0) {
        assertString(value.name, "name", 128);
        result.name = value.name;
      }
      if (value.adapter !== void 0) {
        result.adapter = parseAgentAdapter(value.adapter);
      }
      if (value.command !== void 0) {
        assertString(value.command, "command", 1024);
        result.command = value.command;
      }
      if (value.args !== void 0) {
        result.args = parseAgentArgs(value.args);
      }
      if (value.cwd !== void 0) {
        assertString(value.cwd, "cwd", 2048);
        result.cwd = value.cwd;
      }
      if (value.workspaceRoots !== void 0) {
        result.workspaceRoots = parseAgentWorkspaceRoots(value.workspaceRoots);
      }
      if (value.skills !== void 0) {
        result.skills = parseAgentSkills(value.skills);
      }
      if (value.enabled !== void 0) {
        assertBoolean(value.enabled, "enabled");
        result.enabled = value.enabled;
      }
      return result;
    }
  }
});

// ../shared/dist/acp.js
var require_acp = __commonJS({
  "../shared/dist/acp.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.AcpProtocolError = exports2.ACP_ADAPTER_EVENT_TYPES = void 0;
    exports2.parseAcpSessionUpdate = parseAcpSessionUpdate;
    exports2.parseAcpAdapterEvent = parseAcpAdapterEvent;
    exports2.parseAcpPermissionRequest = parseAcpPermissionRequest;
    exports2.parseAcpPromptResult = parseAcpPromptResult;
    exports2.ACP_ADAPTER_EVENT_TYPES = [
      "agent.message.delta",
      "agent.thought.delta",
      "tool.started",
      "tool.updated",
      "plan.updated",
      "usage.updated",
      "permission.requested",
      "permission.resolved",
      "session.ended"
    ];
    var AcpProtocolError = class extends Error {
      code = "ACP_PROTOCOL_INVALID";
      constructor(message) {
        super(message);
        this.name = "AcpProtocolError";
      }
    };
    exports2.AcpProtocolError = AcpProtocolError;
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function assertRecord(value, what) {
      if (!isRecord2(value))
        throw new AcpProtocolError(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
    }
    function assertKeys(value, allowed, what) {
      const set = new Set(allowed);
      for (const key of Object.keys(value)) {
        if (!set.has(key)) {
          throw new AcpProtocolError(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
    }
    function assertString(value, what, allowEmpty = false) {
      if (typeof value !== "string" || !allowEmpty && value.length === 0) {
        throw new AcpProtocolError(`${what} \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
      }
    }
    function optionalString(value, what) {
      if (value === void 0)
        return void 0;
      assertString(value, what);
      return value;
    }
    function textContent(value, what) {
      assertRecord(value, what);
      assertKeys(value, ["type", "text"], what);
      if (value.type !== "text") {
        throw new AcpProtocolError(`${what}.type \u5FC5\u987B\u4E3A text`);
      }
      assertString(value.text, `${what}.text`, true);
      return value.text;
    }
    function parseLocations(value) {
      if (!Array.isArray(value)) {
        throw new AcpProtocolError("locations \u5FC5\u987B\u662F\u6570\u7EC4");
      }
      return value.map((item, index) => {
        assertRecord(item, `locations[${index}]`);
        assertKeys(item, ["path", "line"], `locations[${index}]`);
        assertString(item.path, `locations[${index}].path`);
        if (item.line !== void 0 && (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line < 0)) {
          throw new AcpProtocolError(`locations[${index}].line \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570`);
        }
        return {
          path: item.path,
          ...item.line !== void 0 ? { line: item.line } : {}
        };
      });
    }
    function parseToolCall(value) {
      assertString(value.toolCallId, "toolCallId");
      assertString(value.title, "title");
      const event = {
        type: "tool.started",
        toolCallId: value.toolCallId,
        title: value.title
      };
      const kind = optionalString(value.kind, "kind");
      const status = optionalString(value.status, "status");
      if (kind !== void 0)
        event.kind = kind;
      if (status !== void 0)
        event.status = status;
      if (value.locations !== void 0) {
        event.locations = parseLocations(value.locations);
      }
      return event;
    }
    function parseToolUpdate(value) {
      assertString(value.toolCallId, "toolCallId");
      const event = {
        type: "tool.updated",
        toolCallId: value.toolCallId
      };
      const status = optionalString(value.status, "status");
      const title = optionalString(value.title, "title");
      if (status !== void 0)
        event.status = status;
      if (title !== void 0)
        event.title = title;
      if (value.content !== void 0) {
        if (!Array.isArray(value.content)) {
          throw new AcpProtocolError("content \u5FC5\u987B\u662F\u6570\u7EC4");
        }
        const texts = [];
        for (const [index, block] of value.content.entries()) {
          assertRecord(block, `content[${index}]`);
          if (block.type === "content") {
            assertRecord(block.content, `content[${index}].content`);
            texts.push(textContent(block.content, `content[${index}].content`));
          }
        }
        if (texts.length > 0)
          event.content = texts.join("");
      }
      return event;
    }
    function parsePlan(value) {
      if (!Array.isArray(value.entries)) {
        throw new AcpProtocolError("plan.entries \u5FC5\u987B\u662F\u6570\u7EC4");
      }
      const entries = value.entries.map((entry, index) => {
        assertRecord(entry, `plan.entries[${index}]`);
        assertKeys(entry, ["content", "priority", "status"], `plan.entries[${index}]`);
        assertString(entry.content, `plan.entries[${index}].content`);
        const result = { content: entry.content };
        const priority = optionalString(entry.priority, `plan.entries[${index}].priority`);
        const status = optionalString(entry.status, `plan.entries[${index}].status`);
        if (priority !== void 0)
          result.priority = priority;
        if (status !== void 0)
          result.status = status;
        return result;
      });
      return { type: "plan.updated", entries };
    }
    function parseUsage(value) {
      if (typeof value.used !== "number" || !Number.isInteger(value.used) || value.used < 0 || typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) {
        throw new AcpProtocolError("usage.used/size \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
      }
      const event = {
        type: "usage.updated",
        used: value.used,
        size: value.size
      };
      if (value.cost !== void 0) {
        assertRecord(value.cost, "usage.cost");
        assertKeys(value.cost, ["amount", "currency"], "usage.cost");
        if (typeof value.cost.amount !== "number" || !Number.isFinite(value.cost.amount)) {
          throw new AcpProtocolError("usage.cost.amount \u5FC5\u987B\u662F\u6570\u5B57");
        }
        assertString(value.cost.currency, "usage.cost.currency");
        event.cost = {
          amount: value.cost.amount,
          currency: value.cost.currency
        };
      }
      return event;
    }
    function parseAcpSessionUpdate(value) {
      assertRecord(value, "session/update");
      if (typeof value.sessionUpdate !== "string") {
        throw new AcpProtocolError("sessionUpdate \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      }
      switch (value.sessionUpdate) {
        case "agent_message_chunk": {
          assertString(value.messageId, "messageId");
          return {
            type: "agent.message.delta",
            messageId: value.messageId,
            text: textContent(value.content, "content")
          };
        }
        case "agent_thought_chunk":
          return {
            type: "agent.thought.delta",
            text: textContent(value.content, "content")
          };
        case "tool_call":
          return parseToolCall(value);
        case "tool_call_update":
          return parseToolUpdate(value);
        case "plan":
          return parsePlan(value);
        case "usage_update":
          return parseUsage(value);
        default:
          return null;
      }
    }
    function parseAcpAdapterEvent(value) {
      assertRecord(value, "acp event");
      assertString(value.type, "acp event.type");
      switch (value.type) {
        case "agent.message.delta":
          assertKeys(value, ["type", "messageId", "text"], "agent.message.delta");
          assertString(value.messageId, "messageId");
          assertString(value.text, "text", true);
          return { type: "agent.message.delta", messageId: value.messageId, text: value.text };
        case "agent.thought.delta":
          assertKeys(value, ["type", "text"], "agent.thought.delta");
          assertString(value.text, "text", true);
          return { type: "agent.thought.delta", text: value.text };
        case "tool.started": {
          assertKeys(value, ["type", "toolCallId", "title", "kind", "status", "locations"], "tool.started");
          assertString(value.toolCallId, "toolCallId");
          assertString(value.title, "title");
          const event = {
            type: "tool.started",
            toolCallId: value.toolCallId,
            title: value.title
          };
          const kind = optionalString(value.kind, "kind");
          const status = optionalString(value.status, "status");
          if (kind !== void 0)
            event.kind = kind;
          if (status !== void 0)
            event.status = status;
          if (value.locations !== void 0) {
            event.locations = parseLocations(value.locations);
          }
          return event;
        }
        case "tool.updated": {
          assertKeys(value, ["type", "toolCallId", "status", "title", "content"], "tool.updated");
          assertString(value.toolCallId, "toolCallId");
          const event = {
            type: "tool.updated",
            toolCallId: value.toolCallId
          };
          const status = optionalString(value.status, "status");
          const title = optionalString(value.title, "title");
          if (status !== void 0)
            event.status = status;
          if (title !== void 0)
            event.title = title;
          if (value.content !== void 0) {
            assertString(value.content, "content", true);
            event.content = value.content;
          }
          return event;
        }
        case "plan.updated": {
          assertKeys(value, ["type", "entries"], "plan.updated");
          if (!Array.isArray(value.entries)) {
            throw new AcpProtocolError("plan.entries \u5FC5\u987B\u662F\u6570\u7EC4");
          }
          const entries = value.entries.map((entry, index) => {
            assertRecord(entry, `plan.entries[${index}]`);
            assertKeys(entry, ["content", "priority", "status"], `plan.entries[${index}]`);
            assertString(entry.content, `plan.entries[${index}].content`);
            const item = { content: entry.content };
            const priority = optionalString(entry.priority, `plan.entries[${index}].priority`);
            const status = optionalString(entry.status, `plan.entries[${index}].status`);
            if (priority !== void 0)
              item.priority = priority;
            if (status !== void 0)
              item.status = status;
            return item;
          });
          return { type: "plan.updated", entries };
        }
        case "usage.updated": {
          assertKeys(value, ["type", "used", "size", "cost"], "usage.updated");
          if (typeof value.used !== "number" || !Number.isInteger(value.used) || value.used < 0 || typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) {
            throw new AcpProtocolError("usage.used/size \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
          }
          const event = {
            type: "usage.updated",
            used: value.used,
            size: value.size
          };
          if (value.cost !== void 0) {
            assertRecord(value.cost, "usage.cost");
            assertKeys(value.cost, ["amount", "currency"], "usage.cost");
            if (typeof value.cost.amount !== "number" || !Number.isFinite(value.cost.amount)) {
              throw new AcpProtocolError("usage.cost.amount \u5FC5\u987B\u662F\u6570\u5B57");
            }
            assertString(value.cost.currency, "usage.cost.currency");
            event.cost = { amount: value.cost.amount, currency: value.cost.currency };
          }
          return event;
        }
        case "permission.requested": {
          assertKeys(value, ["type", "requestId", "toolCallId", "title", "options"], "permission.requested");
          assertString(value.requestId, "requestId");
          assertString(value.toolCallId, "toolCallId");
          const title = optionalString(value.title, "title");
          if (!Array.isArray(value.options) || value.options.length === 0) {
            throw new AcpProtocolError("permission.options \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4");
          }
          const options = value.options.map((option, index) => {
            assertRecord(option, `options[${index}]`);
            assertKeys(option, ["optionId", "name", "kind"], `options[${index}]`);
            assertString(option.optionId, `options[${index}].optionId`);
            assertString(option.name, `options[${index}].name`);
            assertString(option.kind, `options[${index}].kind`);
            return {
              optionId: option.optionId,
              name: option.name,
              kind: option.kind
            };
          });
          return {
            type: "permission.requested",
            requestId: value.requestId,
            toolCallId: value.toolCallId,
            ...title !== void 0 ? { title } : {},
            options
          };
        }
        case "permission.resolved": {
          assertKeys(value, ["type", "requestId", "optionId", "outcome"], "permission.resolved");
          assertString(value.requestId, "requestId");
          if (value.outcome === "selected") {
            assertString(value.optionId, "optionId");
            return {
              type: "permission.resolved",
              requestId: value.requestId,
              optionId: value.optionId,
              outcome: "selected"
            };
          }
          if (value.outcome === "cancelled") {
            if (value.optionId !== void 0) {
              throw new AcpProtocolError("cancelled \u4E0D\u80FD\u5E26 optionId");
            }
            return {
              type: "permission.resolved",
              requestId: value.requestId,
              outcome: "cancelled"
            };
          }
          throw new AcpProtocolError("permission.resolved.outcome \u975E\u6CD5");
        }
        case "session.ended": {
          assertKeys(value, ["type", "reason", "code"], "session.ended");
          if (value.reason !== "exited" && value.reason !== "closed" && value.reason !== "error") {
            throw new AcpProtocolError("session.ended.reason \u975E\u6CD5");
          }
          if (value.code !== void 0 && (typeof value.code !== "number" || !Number.isInteger(value.code) || value.code < 0)) {
            throw new AcpProtocolError("session.ended.code \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
          }
          return {
            type: "session.ended",
            reason: value.reason,
            ...value.code !== void 0 ? { code: value.code } : {}
          };
        }
        default:
          throw new AcpProtocolError(`\u672A\u77E5 ACP event ${value.type}`);
      }
    }
    function parseAcpPermissionRequest(value, requestId) {
      assertRecord(value, "session/request_permission params");
      assertKeys(value, ["sessionId", "toolCall", "options"], "params");
      assertString(value.sessionId, "sessionId");
      assertRecord(value.toolCall, "toolCall");
      assertString(value.toolCall.toolCallId, "toolCall.toolCallId");
      const title = optionalString(value.toolCall.title, "toolCall.title");
      if (!Array.isArray(value.options) || value.options.length === 0) {
        throw new AcpProtocolError("options \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4");
      }
      const options = value.options.map((option, index) => {
        assertRecord(option, `options[${index}]`);
        assertKeys(option, ["optionId", "name", "kind"], `options[${index}]`);
        assertString(option.optionId, `options[${index}].optionId`);
        assertString(option.name, `options[${index}].name`);
        assertString(option.kind, `options[${index}].kind`);
        return {
          optionId: option.optionId,
          name: option.name,
          kind: option.kind
        };
      });
      return {
        requestId,
        sessionId: value.sessionId,
        toolCallId: value.toolCall.toolCallId,
        ...title !== void 0 ? { title } : {},
        options
      };
    }
    function parseAcpPromptResult(value) {
      assertRecord(value, "session/prompt result");
      assertString(value.stopReason, "stopReason");
      return { stopReason: value.stopReason };
    }
  }
});

// ../shared/dist/task-client.js
var require_task_client = __commonJS({
  "../shared/dist/task-client.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TaskClientProtocolError = exports2.TASK_CLIENT_ACTIONS = void 0;
    exports2.parseTaskClientCommand = parseTaskClientCommand;
    exports2.parseTaskClientEvent = parseTaskClientEvent;
    exports2.parseTaskCommandResult = parseTaskCommandResult;
    exports2.TASK_CLIENT_ACTIONS = [
      "start",
      "prompt",
      "cancel",
      "permission",
      "close"
    ];
    var TaskClientProtocolError = class extends Error {
      code = "TASK_CLIENT_PROTOCOL_INVALID";
      constructor(message) {
        super(message);
        this.name = "TaskClientProtocolError";
      }
    };
    exports2.TaskClientProtocolError = TaskClientProtocolError;
    function isRecord2(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function assertRecord(value, what) {
      if (!isRecord2(value))
        throw new TaskClientProtocolError(`${what} \u5FC5\u987B\u662F\u5BF9\u8C61`);
    }
    function assertKeys(value, allowed, what) {
      const set = new Set(allowed);
      for (const key of Object.keys(value)) {
        if (!set.has(key)) {
          throw new TaskClientProtocolError(`${what} \u542B\u672A\u77E5\u5B57\u6BB5 ${key}`);
        }
      }
    }
    function assertString(value, what, maxBytes = 4096) {
      if (typeof value !== "string" || value.length === 0) {
        throw new TaskClientProtocolError(`${what} \u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32`);
      }
      if (new TextEncoder().encode(value).byteLength > maxBytes) {
        throw new TaskClientProtocolError(`${what} \u8D85\u8FC7 ${maxBytes} \u5B57\u8282\u4E0A\u9650`);
      }
    }
    function assertSeq(value) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TaskClientProtocolError("seq \u5FC5\u987B\u662F\u6B63\u6574\u6570");
      }
    }
    function assertBase(value) {
      assertString(value.requestId, "requestId", 128);
      assertString(value.taskId, "taskId", 128);
      assertString(value.attemptId, "attemptId", 128);
      return {
        requestId: value.requestId,
        taskId: value.taskId,
        attemptId: value.attemptId
      };
    }
    function parseTaskClientCommand(value) {
      assertRecord(value, "task command");
      if (typeof value.action !== "string") {
        throw new TaskClientProtocolError("action \u5FC5\u987B\u662F\u5B57\u7B26\u4E32");
      }
      const action = value.action;
      switch (action) {
        case "start": {
          assertKeys(value, [
            "requestId",
            "action",
            "taskId",
            "attemptId",
            "command",
            "args",
            "cwd",
            "prompt"
          ], "start");
          const base = assertBase(value);
          assertString(value.command, "command", 1024);
          if (!Array.isArray(value.args)) {
            throw new TaskClientProtocolError("args \u5FC5\u987B\u662F\u6570\u7EC4");
          }
          const args = value.args.map((arg, index) => {
            assertString(arg, `args[${index}]`, 1024);
            return arg;
          });
          assertString(value.cwd, "cwd", 2048);
          if (value.prompt !== void 0) {
            assertString(value.prompt, "prompt", 256 * 1024);
          }
          return {
            ...base,
            action: "start",
            command: value.command,
            args,
            cwd: value.cwd,
            ...value.prompt !== void 0 ? { prompt: value.prompt } : {}
          };
        }
        case "prompt": {
          assertKeys(value, ["requestId", "action", "taskId", "attemptId", "text"], "prompt");
          const base = assertBase(value);
          assertString(value.text, "text", 256 * 1024);
          return { ...base, action: "prompt", text: value.text };
        }
        case "cancel": {
          assertKeys(value, ["requestId", "action", "taskId", "attemptId"], "cancel");
          return { ...assertBase(value), action: "cancel" };
        }
        case "permission": {
          assertKeys(value, [
            "requestId",
            "action",
            "taskId",
            "attemptId",
            "permissionRequestId",
            "outcome"
          ], "permission");
          const base = assertBase(value);
          assertString(value.permissionRequestId, "permissionRequestId", 128);
          assertRecord(value.outcome, "outcome");
          assertKeys(value.outcome, ["outcome", "optionId"], "outcome");
          if (value.outcome.outcome === "selected") {
            assertString(value.outcome.optionId, "outcome.optionId", 128);
            return {
              ...base,
              action: "permission",
              permissionRequestId: value.permissionRequestId,
              outcome: {
                outcome: "selected",
                optionId: value.outcome.optionId
              }
            };
          }
          if (value.outcome.outcome === "cancelled") {
            return {
              ...base,
              action: "permission",
              permissionRequestId: value.permissionRequestId,
              outcome: { outcome: "cancelled" }
            };
          }
          throw new TaskClientProtocolError("outcome.outcome \u975E\u6CD5");
        }
        case "close": {
          assertKeys(value, ["requestId", "action", "taskId", "attemptId"], "close");
          return { ...assertBase(value), action: "close" };
        }
        default:
          throw new TaskClientProtocolError(`\u672A\u77E5 action ${action}`);
      }
    }
    function parseTaskClientEvent(value) {
      assertRecord(value, "task event");
      assertKeys(value, ["taskId", "attemptId", "seq", "event"], "task event");
      assertString(value.taskId, "taskId", 128);
      assertString(value.attemptId, "attemptId", 128);
      assertSeq(value.seq);
      assertRecord(value.event, "event");
      assertString(value.event.type, "event.type", 64);
      return value;
    }
    function parseTaskCommandResult(value) {
      assertRecord(value, "task command result");
      assertKeys(value, ["requestId", "ok", "sessionId", "stopReason", "error"], "task command result");
      assertString(value.requestId, "requestId", 128);
      if (typeof value.ok !== "boolean") {
        throw new TaskClientProtocolError("ok \u5FC5\u987B\u662F boolean");
      }
      if (value.sessionId !== void 0) {
        assertString(value.sessionId, "sessionId", 128);
      }
      if (value.stopReason !== void 0) {
        assertString(value.stopReason, "stopReason", 64);
      }
      if (value.error !== void 0) {
        assertRecord(value.error, "error");
        assertKeys(value.error, ["code", "message"], "error");
        assertString(value.error.code, "error.code", 128);
        assertString(value.error.message, "error.message", 512);
      }
      return value;
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
    exports2.StorageProviderKind = exports2.AuthErrorCode = exports2.FileErrorCode = exports2.parsePrivilegedCapabilityStatus = exports2.parseMachineRegister = exports2.parseMachineInstallation = exports2.parseRemoteDevCapabilityStatus = exports2.parseAcpCapabilityStatus = exports2.getClientInstallationCompliance = exports2.PrivilegedCapabilityMode = exports2.MachineInstallationMode = exports2.ClientInstallationComplianceReason = exports2.JobStatus = exports2.JobType = exports2.Events = exports2.isReleaseArchiveAvailable = exports2.platformFromOs = exports2.parseReleaseUploadPartRefresh = exports2.parseReleaseUploadCreateInput = exports2.parseReleaseUploadComplete = exports2.ReleaseUploadErrorCode = exports2.ReleaseStatus = exports2.ReleaseClientState = exports2.parseJobLogLine = exports2.JobLogProtocolError = exports2.JOB_LOG_SERVER_EVENTS = exports2.JOB_LOG_LIMITS = exports2.JOB_LOG_LEVELS = exports2.JOB_LOG_CLIENT_EVENTS = exports2.parseGitSshTargetInput = exports2.parseGitSshCommand = exports2.parseGitSshCapability = exports2.parseGitSshAck = exports2.isGitSshTargetState = exports2.isGitSshFailureCode = exports2.GitSshProtocolError = exports2.GIT_SSH_TARGET_STATES = exports2.GIT_SSH_PROTOCOL_VERSION = exports2.GIT_SSH_MAX_TARGETS = exports2.GIT_SSH_FAILURE_CODES = exports2.parseClientInstallerPlatform = exports2.parseClientInstallerNameUpdate = exports2.parseClientInstallerConfigUpdate = exports2.ClientInstallerErrorCode = exports2.parseClientDshWebUrl = exports2.DSH_WEB_URL_MAX_LENGTH = exports2.parseClientAnnotationsInput = exports2.parseClientAnnotations = exports2.hasClientAnnotations = exports2.VERSION = void 0;
    exports2.parseFeatureVerificationReport = exports2.parseFeatureUpdateInput = exports2.parseFeatureInvocation = exports2.parseFeatureInputs = exports2.parseFeatureCreateInput = exports2.parseFeatureContract = exports2.getFeatureFreshness = exports2.FeatureProtocolError = exports2.FEATURE_VERIFICATION_SOURCES = exports2.FEATURE_STATUSES = exports2.FEATURE_STALE_AFTER_DAYS = exports2.FEATURE_SCOPES = exports2.FEATURE_ERROR_CODES = exports2.parseFrpRuntimeStateReport = exports2.parseFrpRuntimeStateAck = exports2.parseFrpReconcileResult = exports2.parseFrpReconcilePayload = exports2.parseFrpCapabilityStatus = exports2.FRP_RECONCILE_PROTOCOL_VERSION = exports2.StorageShareErrorCode = exports2.FrpJobType = exports2.FrpProtocolError = exports2.FRP_ERROR_CODES = exports2.FRP_MAPPING_STATUSES = void 0;
    exports2.parseFrpOperationTimeout = parseFrpOperationTimeout;
    exports2.parseFrpMappingCreateRequest = parseFrpMappingCreateRequest;
    var version_js_1 = require_version();
    Object.defineProperty(exports2, "VERSION", { enumerable: true, get: function() {
      return version_js_1.VERSION;
    } });
    var client_annotations_js_1 = require_client_annotations();
    Object.defineProperty(exports2, "hasClientAnnotations", { enumerable: true, get: function() {
      return client_annotations_js_1.hasClientAnnotations;
    } });
    Object.defineProperty(exports2, "parseClientAnnotations", { enumerable: true, get: function() {
      return client_annotations_js_1.parseClientAnnotations;
    } });
    Object.defineProperty(exports2, "parseClientAnnotationsInput", { enumerable: true, get: function() {
      return client_annotations_js_1.parseClientAnnotationsInput;
    } });
    var client_dsh_web_js_1 = require_client_dsh_web();
    Object.defineProperty(exports2, "DSH_WEB_URL_MAX_LENGTH", { enumerable: true, get: function() {
      return client_dsh_web_js_1.DSH_WEB_URL_MAX_LENGTH;
    } });
    Object.defineProperty(exports2, "parseClientDshWebUrl", { enumerable: true, get: function() {
      return client_dsh_web_js_1.parseClientDshWebUrl;
    } });
    __exportStar(require_dsh_web(), exports2);
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
    var git_ssh_js_1 = require_git_ssh();
    Object.defineProperty(exports2, "GIT_SSH_FAILURE_CODES", { enumerable: true, get: function() {
      return git_ssh_js_1.GIT_SSH_FAILURE_CODES;
    } });
    Object.defineProperty(exports2, "GIT_SSH_MAX_TARGETS", { enumerable: true, get: function() {
      return git_ssh_js_1.GIT_SSH_MAX_TARGETS;
    } });
    Object.defineProperty(exports2, "GIT_SSH_PROTOCOL_VERSION", { enumerable: true, get: function() {
      return git_ssh_js_1.GIT_SSH_PROTOCOL_VERSION;
    } });
    Object.defineProperty(exports2, "GIT_SSH_TARGET_STATES", { enumerable: true, get: function() {
      return git_ssh_js_1.GIT_SSH_TARGET_STATES;
    } });
    Object.defineProperty(exports2, "GitSshProtocolError", { enumerable: true, get: function() {
      return git_ssh_js_1.GitSshProtocolError;
    } });
    Object.defineProperty(exports2, "isGitSshFailureCode", { enumerable: true, get: function() {
      return git_ssh_js_1.isGitSshFailureCode;
    } });
    Object.defineProperty(exports2, "isGitSshTargetState", { enumerable: true, get: function() {
      return git_ssh_js_1.isGitSshTargetState;
    } });
    Object.defineProperty(exports2, "parseGitSshAck", { enumerable: true, get: function() {
      return git_ssh_js_1.parseGitSshAck;
    } });
    Object.defineProperty(exports2, "parseGitSshCapability", { enumerable: true, get: function() {
      return git_ssh_js_1.parseGitSshCapability;
    } });
    Object.defineProperty(exports2, "parseGitSshCommand", { enumerable: true, get: function() {
      return git_ssh_js_1.parseGitSshCommand;
    } });
    Object.defineProperty(exports2, "parseGitSshTargetInput", { enumerable: true, get: function() {
      return git_ssh_js_1.parseGitSshTargetInput;
    } });
    __exportStar(require_terminal(), exports2);
    var job_log_js_1 = require_job_log();
    Object.defineProperty(exports2, "JOB_LOG_CLIENT_EVENTS", { enumerable: true, get: function() {
      return job_log_js_1.JOB_LOG_CLIENT_EVENTS;
    } });
    Object.defineProperty(exports2, "JOB_LOG_LEVELS", { enumerable: true, get: function() {
      return job_log_js_1.JOB_LOG_LEVELS;
    } });
    Object.defineProperty(exports2, "JOB_LOG_LIMITS", { enumerable: true, get: function() {
      return job_log_js_1.JOB_LOG_LIMITS;
    } });
    Object.defineProperty(exports2, "JOB_LOG_SERVER_EVENTS", { enumerable: true, get: function() {
      return job_log_js_1.JOB_LOG_SERVER_EVENTS;
    } });
    Object.defineProperty(exports2, "JobLogProtocolError", { enumerable: true, get: function() {
      return job_log_js_1.JobLogProtocolError;
    } });
    Object.defineProperty(exports2, "parseJobLogLine", { enumerable: true, get: function() {
      return job_log_js_1.parseJobLogLine;
    } });
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
      /** Client → Server：Job 生命周期相位（ADR-0054），只承载相位不承载输出正文。 */
      JOB_LOG: "job:log",
      STATUS_REPORT: "status:report",
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
      GIT_SSH_COMMAND: "git-ssh:command",
      GIT_SSH_ACK: "git-ssh:ack",
      TASK_COMMAND: "task:command",
      TASK_COMMAND_RESULT: "task:command-result",
      TASK_EVENT: "task:event",
      DSH_WEB_COMMAND: "dshweb:command",
      DSH_WEB_RESULT: "dshweb:result"
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
    Object.defineProperty(exports2, "ClientInstallationComplianceReason", { enumerable: true, get: function() {
      return machine_register_js_1.ClientInstallationComplianceReason;
    } });
    Object.defineProperty(exports2, "MachineInstallationMode", { enumerable: true, get: function() {
      return machine_register_js_1.MachineInstallationMode;
    } });
    Object.defineProperty(exports2, "PrivilegedCapabilityMode", { enumerable: true, get: function() {
      return machine_register_js_1.PrivilegedCapabilityMode;
    } });
    Object.defineProperty(exports2, "getClientInstallationCompliance", { enumerable: true, get: function() {
      return machine_register_js_1.getClientInstallationCompliance;
    } });
    Object.defineProperty(exports2, "parseAcpCapabilityStatus", { enumerable: true, get: function() {
      return machine_register_js_1.parseAcpCapabilityStatus;
    } });
    Object.defineProperty(exports2, "parseRemoteDevCapabilityStatus", { enumerable: true, get: function() {
      return machine_register_js_1.parseRemoteDevCapabilityStatus;
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
      "FRP_CLIENT_NO_FRP_CAPABILITY",
      "FRP_PORT_OUT_OF_RANGE",
      "FRP_PORT_CONFLICT",
      "FRP_INSTANCE_NOT_FOUND",
      "FRP_INSTANCE_CONFLICT"
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
    exports2.StorageShareErrorCode = {
      FILE_NOT_SHAREABLE: "FILE_NOT_SHAREABLE",
      STORAGE_PROVIDER_MISMATCH: "STORAGE_PROVIDER_MISMATCH",
      STORAGE_SHARE_NOT_FOUND: "STORAGE_SHARE_NOT_FOUND",
      FILE_HAS_ACTIVE_SHARES: "FILE_HAS_ACTIVE_SHARES"
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
    var feature_js_1 = require_feature();
    Object.defineProperty(exports2, "FEATURE_ERROR_CODES", { enumerable: true, get: function() {
      return feature_js_1.FEATURE_ERROR_CODES;
    } });
    Object.defineProperty(exports2, "FEATURE_SCOPES", { enumerable: true, get: function() {
      return feature_js_1.FEATURE_SCOPES;
    } });
    Object.defineProperty(exports2, "FEATURE_STALE_AFTER_DAYS", { enumerable: true, get: function() {
      return feature_js_1.FEATURE_STALE_AFTER_DAYS;
    } });
    Object.defineProperty(exports2, "FEATURE_STATUSES", { enumerable: true, get: function() {
      return feature_js_1.FEATURE_STATUSES;
    } });
    Object.defineProperty(exports2, "FEATURE_VERIFICATION_SOURCES", { enumerable: true, get: function() {
      return feature_js_1.FEATURE_VERIFICATION_SOURCES;
    } });
    Object.defineProperty(exports2, "FeatureProtocolError", { enumerable: true, get: function() {
      return feature_js_1.FeatureProtocolError;
    } });
    Object.defineProperty(exports2, "getFeatureFreshness", { enumerable: true, get: function() {
      return feature_js_1.getFeatureFreshness;
    } });
    Object.defineProperty(exports2, "parseFeatureContract", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureContract;
    } });
    Object.defineProperty(exports2, "parseFeatureCreateInput", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureCreateInput;
    } });
    Object.defineProperty(exports2, "parseFeatureInputs", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureInputs;
    } });
    Object.defineProperty(exports2, "parseFeatureInvocation", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureInvocation;
    } });
    Object.defineProperty(exports2, "parseFeatureUpdateInput", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureUpdateInput;
    } });
    Object.defineProperty(exports2, "parseFeatureVerificationReport", { enumerable: true, get: function() {
      return feature_js_1.parseFeatureVerificationReport;
    } });
    __exportStar(require_a2a(), exports2);
    __exportStar(require_acp(), exports2);
    __exportStar(require_task_client(), exports2);
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
    rename: (clientId, name, signal) => client.request("PATCH", `/api/clients/${encodeURIComponent(clientId)}/name`, { name }, signal),
    /** 全量替换操作者注解（ADR-0055）；空输入清除。 */
    updateAnnotations: (clientId, annotations, signal) => client.request("PUT", `/api/clients/${encodeURIComponent(clientId)}/annotations`, { annotations }, signal),
    /** 登记/清除远程 DSH WebUI 地址（ADR-0059）；`null` 清除。 */
    setDshWebUrl: (clientId, url, signal) => client.request("PUT", `/api/clients/${encodeURIComponent(clientId)}/dsh-web`, { url }, signal),
    /** 一键启动：代起 dsh web 并自动建 FRP 映射（ADR-0059 修订）。 */
    startDshWeb: (clientId, signal) => client.request("POST", `/api/clients/${encodeURIComponent(clientId)}/dsh-web/start`, void 0, signal),
    /** 一键停止：停进程、删映射、清地址；外部托管时等价于解除登记。 */
    stopDshWeb: (clientId, signal) => client.request("POST", `/api/clients/${encodeURIComponent(clientId)}/dsh-web/stop`, void 0, signal),
    /** 解除外部托管的登记：只清 VCPDeck 侧入口，不动目标机进程（ADR-0059 决策 12）。 */
    detachDshWeb: (clientId, signal) => client.request("DELETE", `/api/clients/${encodeURIComponent(clientId)}/dsh-web`, void 0, signal)
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

// ../sdk/dist/features.js
function createFeaturesApi(client) {
  return {
    list: (params = {}, signal) => {
      const search = new URLSearchParams();
      if (params.clientId)
        search.set("clientId", params.clientId);
      if (params.scope)
        search.set("scope", params.scope);
      if (params.status)
        search.set("status", params.status);
      if (params.page !== void 0)
        search.set("page", String(params.page));
      if (params.pageSize !== void 0)
        search.set("pageSize", String(params.pageSize));
      const query = search.toString();
      return client.request("GET", query ? `/api/features?${query}` : "/api/features", void 0, signal);
    },
    get: (id, signal) => client.request("GET", `/api/features/${encodeURIComponent(id)}`, void 0, signal),
    listByClient: (clientId, signal) => client.request("GET", `/api/clients/${encodeURIComponent(clientId)}/features`, void 0, signal),
    create: (input, signal) => client.request("POST", "/api/features", input, signal),
    update: (id, patch, signal) => client.request("PATCH", `/api/features/${encodeURIComponent(id)}`, patch, signal),
    reportVerification: (id, report, signal) => client.request("POST", `/api/features/${encodeURIComponent(id)}/verifications`, report, signal)
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
    /**
     * 读取 Job 日志事件链（ADR-0054）。
     *
     * `since` 传上一页的 `nextSeq` 即可增量拉取；返回条数小于 `limit` 表示已到末尾。
     */
    logs: (jobId, options, signal) => {
      const params = new URLSearchParams();
      if (options?.since !== void 0)
        params.set("since", String(options.since));
      if (options?.limit !== void 0)
        params.set("limit", String(options.limit));
      if (options?.level)
        params.set("level", options.level);
      const qs = params.toString();
      return client.request("GET", `/api/jobs/${encodeURIComponent(jobId)}/logs${qs ? `?${qs}` : ""}`, void 0, signal);
    },
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

// ../sdk/dist/git-ssh.js
function createGitSshApi(client) {
  return {
    /**
     * 当前密钥投影；未生成时返回 null。
     *
     * Server 在无密钥时返回 200 空 body，SDK `request` 会解析成 `undefined`；
     * 这里归一化为 `null`，使运行时值与声明类型一致。
     */
    get: async (signal) => await client.request("GET", "/api/git-ssh", void 0, signal) ?? null,
    /** 生成新一代密钥；公钥需人工登记到 Git 服务。 */
    generate: (signal) => client.request("POST", "/api/git-ssh/generate", void 0, signal),
    /** 密钥与每机分发状态。 */
    status: (signal) => client.request("GET", "/api/git-ssh/status", void 0, signal),
    /** 全量替换选机集合。 */
    setTargets: (clientIds, signal) => client.request("PUT", "/api/git-ssh/targets", { clientIds }, signal)
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
    /** 人工强制重试某个客户端的补更；永久失败会被服务端拒绝。 */
    retryClient: (version, clientId, signal) => client.request("POST", `/api/releases/${encodeURIComponent(version)}/clients/${encodeURIComponent(clientId)}/retry`, void 0, signal),
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
    delete: (key, signal) => client.request("DELETE", `/api/storage/raw/${encodeURIComponent(key)}`, void 0, signal),
    setBackend: (input, signal) => client.request("PUT", "/api/storage/config", input, signal)
  };
}

// ../sdk/dist/storage-shares.js
function createStorageSharesApi(client) {
  return {
    create: (input, signal) => client.request("POST", "/api/storage/shares", input, signal),
    list: (options = {}, signal) => {
      const params = new URLSearchParams();
      if (options.fileId)
        params.set("fileId", options.fileId);
      if (options.status)
        params.set("status", options.status);
      if (options.page)
        params.set("page", String(options.page));
      if (options.pageSize)
        params.set("pageSize", String(options.pageSize));
      const query = params.toString();
      return client.request("GET", `/api/storage/shares${query ? `?${query}` : ""}`, void 0, signal);
    },
    get: (id, signal) => client.request("GET", `/api/storage/shares/${encodeURIComponent(id)}`, void 0, signal),
    revoke: (id, signal) => client.request("DELETE", `/api/storage/shares/${encodeURIComponent(id)}`, void 0, signal)
  };
}

// ../sdk/dist/tasks.js
function createTasksApi(client, nextId = () => crypto.randomUUID()) {
  async function rpc(method, params, signal) {
    const response = await client.request("POST", "/api/a2a", { jsonrpc: "2.0", id: nextId(), method, params }, signal);
    if ("error" in response) {
      const data = response.error.data;
      throw new VcpDeckApiError(response.error.message, response.error.code, typeof data?.code === "string" ? data.code : void 0, response.error.data);
    }
    return response.result;
  }
  return {
    sendMessage: (params, signal) => rpc("SendMessage", params, signal),
    get: (id, historyLength, signal) => rpc("GetTask", { id, historyLength }, signal),
    list: (params = {}, signal) => rpc("ListTasks", params, signal),
    cancel: (id, signal) => rpc("CancelTask", { id }, signal),
    agentCard: (signal) => client.request("GET", "/api/a2a/agent-card", void 0, signal),
    events: (id, options = {}, signal) => {
      const search = new URLSearchParams();
      if (options.since !== void 0)
        search.set("since", String(options.since));
      if (options.limit !== void 0)
        search.set("limit", String(options.limit));
      const query = search.toString();
      return client.request("GET", `/api/tasks/${encodeURIComponent(id)}/events${query ? `?${query}` : ""}`, void 0, signal);
    },
    deviation: (id, signal) => client.request("GET", `/api/tasks/${encodeURIComponent(id)}/deviation`, void 0, signal)
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

// ../sdk/dist/agents.js
function createAgentsApi(client) {
  return {
    list: (options = {}, signal) => {
      const search = new URLSearchParams();
      if (options.page !== void 0)
        search.set("page", String(options.page));
      if (options.pageSize !== void 0)
        search.set("pageSize", String(options.pageSize));
      const query = search.toString();
      return client.request("GET", `/api/agents${query ? `?${query}` : ""}`, void 0, signal);
    },
    /** 登记一条受控 placement；Server 侧仍会做完整字段校验。 */
    create: (input, signal) => client.request("POST", "/api/agents", input, signal)
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
  /** 功能目录（ADR-0056）。 */
  features;
  storage;
  storageShares;
  aliyundrive;
  frp;
  /** Git SSH 共享密钥管理（ADR-0037）。 */
  gitSsh;
  releases;
  terminals;
  /** A2A Task 契约（ADR-0057）。 */
  tasks;
  /** Agent placement 只读投影。 */
  agents;
  /** Remote Dev Session（ADR-0058）。 */
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
    this.features = createFeaturesApi(this);
    this.storage = createStorageApi(this);
    this.storageShares = createStorageSharesApi(this);
    this.aliyundrive = createAliyunDriveApi(this);
    this.frp = createFrpApi(this, this.jobs);
    this.gitSsh = createGitSshApi(this);
    this.releases = createReleasesApi(this);
    this.terminals = createTerminalsApi(this);
    this.tasks = createTasksApi(this);
    this.agents = createAgentsApi(this);
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
  const timeoutStr = envFromFile.REQUEST_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || "300000";
  if (!serverUrl) {
    throw new Error("Missing SERVER_URL in config.env or environment variables");
  }
  if (!apiToken) {
    throw new Error("Missing API_TOKEN in config.env or environment variables");
  }
  const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
  const publicShareBaseUrl = (envFromFile.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_SHARE_BASE_URL || normalizedServerUrl).replace(/\/+$/, "");
  try {
    const parsed = new URL(publicShareBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error();
  } catch {
    throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
  }
  return {
    serverUrl: normalizedServerUrl,
    apiToken,
    publicShareBaseUrl,
    requestTimeoutMs: Number.parseInt(timeoutStr, 10) || 3e5
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
  const shellCommand = String(params.shellCommand || params.command || "");
  const timeout = params.timeout ? Number(params.timeout) : void 0;
  if (!clientFilter || !shellCommand) {
    throw new Error("Missing required parameters: clientId (or client), shellCommand");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const job = await client.jobs.create({
    clientId,
    type: "exec",
    payload: {
      command: shellCommand,
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

// dist/handlers/download.js
function publicUrl(base, sharePath) {
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_SHARE_BASE_URL must be a valid HTTP(S) URL");
  }
  return new URL(sharePath, `${parsed.toString().replace(/\/$/, "")}/`).toString();
}
async function handleDownloadFile(client, params, baseUrl) {
  const clientFilter = String(params.clientId || params.clientName || params.client || "");
  const filePath = String(params.path || "");
  if (!clientFilter || !filePath) {
    throw new Error("Missing required parameters: clientId (or client), path");
  }
  const clientId = await resolveClientId(client, clientFilter);
  const rootDir = await resolveRootDir(client, clientId, params.rootDir ? String(params.rootDir) : void 0);
  const exported = await client.files.export(clientId, { rootDir, path: filePath });
  const share = await client.storageShares.create({ fileId: exported.fileId });
  const url = publicUrl(baseUrl, share.sharePath);
  const content = [
    { type: "text", text: `[\u4E0B\u8F7D ${share.filename}](<${url}>)` }
  ];
  return {
    status: "success",
    content,
    messageForAI: `\u6587\u4EF6 ${share.filename} \u5DF2\u5BFC\u51FA\u5E76\u521B\u5EFA\u516C\u5F00\u4E0B\u8F7D\u94FE\u63A5\u3002`
  };
}

// dist/dispatcher.js
async function dispatchCommand(client, req, publicShareBaseUrl) {
  const { command, params: _nested, maid: _maid, ...flat } = req;
  const params = { ...flat, ..._nested ?? {} };
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
    case "DownloadFile":
      if (!publicShareBaseUrl)
        throw new Error("PUBLIC_SHARE_BASE_URL is required for DownloadFile");
      return handleDownloadFile(client, params, publicShareBaseUrl);
    default:
      throw new Error(`Unknown command identifier: "${command}"`);
  }
}

// dist/index.js
function sendResponse(response) {
  const payload = {
    status: response.status,
    result: {
      content: response.content || response.result?.content || []
    },
    messageForAI: response.messageForAI,
    content: response.content || response.result?.content || []
  };
  process.stdout.write(JSON.stringify(payload));
}
function sendError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const response = {
    status: "error",
    error: message,
    result: {
      content: [
        {
          type: "text",
          text: message
        }
      ]
    },
    messageForAI: `\u6267\u884C\u5931\u8D25: ${message}`
  };
  process.stdout.write(JSON.stringify(response));
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
    const res = await dispatchCommand(client, req, config.publicShareBaseUrl);
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
