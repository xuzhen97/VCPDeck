"use strict";
// ── 自更新协议（server ↔ client 经 WebSocket，launcher 经本地控制通道） ──
// 详见 docs/design/release-and-update.md
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReleaseUploadErrorCode = exports.ReleaseClientState = exports.ReleaseStatus = void 0;
exports.parseReleaseUploadCreateInput = parseReleaseUploadCreateInput;
exports.parseReleaseUploadPartRefresh = parseReleaseUploadPartRefresh;
exports.parseReleaseUploadComplete = parseReleaseUploadComplete;
exports.isReleaseArchiveAvailable = isReleaseArchiveAvailable;
exports.platformFromOs = platformFromOs;
/** Release 状态机：uploaded → updating_server → updating_clients → done/failed */
var ReleaseStatus;
(function (ReleaseStatus) {
    ReleaseStatus["UPLOADED"] = "uploaded";
    ReleaseStatus["UPDATING_SERVER"] = "updating_server";
    ReleaseStatus["UPDATING_CLIENTS"] = "updating_clients";
    ReleaseStatus["DONE"] = "done";
    ReleaseStatus["FAILED"] = "failed";
})(ReleaseStatus || (exports.ReleaseStatus = ReleaseStatus = {}));
/** 单客户端在某个 release 中的更新状态 */
var ReleaseClientState;
(function (ReleaseClientState) {
    ReleaseClientState["PENDING"] = "pending";
    ReleaseClientState["UPDATING"] = "updating";
    ReleaseClientState["DONE"] = "done";
    ReleaseClientState["FAILED"] = "failed";
})(ReleaseClientState || (exports.ReleaseClientState = ReleaseClientState = {}));
/** Release 上传会话稳定错误码。 */
exports.ReleaseUploadErrorCode = {
    DIRECT_UPLOAD_REQUIRED: "RELEASE_DIRECT_UPLOAD_REQUIRED",
    SESSION_NOT_FOUND: "RELEASE_UPLOAD_SESSION_NOT_FOUND",
    SESSION_EXPIRED: "RELEASE_UPLOAD_SESSION_EXPIRED",
    SESSION_CONFLICT: "RELEASE_UPLOAD_SESSION_CONFLICT",
    SIZE_MISMATCH: "RELEASE_UPLOAD_SIZE_MISMATCH",
    PROVIDER_FAILED: "RELEASE_UPLOAD_PROVIDER_FAILED",
};
/** 严格解析 Release 上传会话创建输入。 */
function parseReleaseUploadCreateInput(value) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["version", "platform", "sha256", "size"])) {
        throw new Error("body 必须且只能包含 version/platform/sha256/size");
    }
    if (typeof value.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(value.version)) {
        throw new Error("version 格式应为 x.y.z");
    }
    if (value.platform !== "win-x64" && value.platform !== "linux-x64") {
        throw new Error("platform 应为 win-x64 或 linux-x64");
    }
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
        throw new Error("sha256 应为 64 位小写十六进制");
    }
    if (typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) ||
        value.size < 1 ||
        value.size > 2_147_483_647) {
        throw new Error("size 应为 1–2147483647 的整数");
    }
    return {
        version: value.version,
        platform: value.platform,
        sha256: value.sha256,
        size: value.size,
    };
}
/** 严格解析需要刷新的分片编号。 */
function parseReleaseUploadPartRefresh(value) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["partNumbers"]) ||
        !Array.isArray(value.partNumbers)) {
        throw new Error("body 必须且只能包含 partNumbers 数组");
    }
    const partNumbers = value.partNumbers;
    if (partNumbers.length < 1 ||
        partNumbers.length > 100 ||
        partNumbers.some((part) => !Number.isInteger(part) || part < 1 || part > 10_000) ||
        new Set(partNumbers).size !== partNumbers.length) {
        throw new Error("partNumbers 必须包含 1–100 个不重复的 1–10000 整数");
    }
    return { partNumbers: partNumbers };
}
/** 严格解析 Release 直传完成输入。 */
function parseReleaseUploadComplete(value) {
    if (!isRecord(value) ||
        !hasOnlyKeys(value, ["uploadedBytes"]) ||
        typeof value.uploadedBytes !== "number" ||
        !Number.isSafeInteger(value.uploadedBytes) ||
        value.uploadedBytes < 1 ||
        value.uploadedBytes > 2_147_483_647) {
        throw new Error("body 必须且只能包含有效整数 uploadedBytes");
    }
    return { uploadedBytes: value.uploadedBytes };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
    const actual = Object.keys(value);
    return (actual.length === keys.length && actual.every((key) => keys.includes(key)));
}
/** 只有正文仍可用的构件才可参与下载、编排、安装和补更。 */
function isReleaseArchiveAvailable(archive) {
    return Boolean(archive &&
        (archive.availability === undefined || archive.availability === "available"));
}
/** 由客户端注册的 os 字符串（如 "win32 10.0.26200"）映射到发布平台，未知平台返回 null */
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
