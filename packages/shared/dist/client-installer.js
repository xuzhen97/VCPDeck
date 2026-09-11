"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientInstallerErrorCode = void 0;
exports.parseClientInstallerPlatform = parseClientInstallerPlatform;
exports.parseClientInstallerConfigUpdate = parseClientInstallerConfigUpdate;
exports.parseClientInstallerNameUpdate = parseClientInstallerNameUpdate;
/** Client 一键安装稳定错误码。 */
exports.ClientInstallerErrorCode = {
    DISABLED: "CLIENT_INSTALLER_DISABLED",
    RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY",
    ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING",
    PLATFORM_UNSUPPORTED: "CLIENT_INSTALLER_PLATFORM_UNSUPPORTED",
    ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING",
    PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID",
    CLIENT_NOT_FOUND: "CLIENT_INSTALLER_CLIENT_NOT_FOUND",
};
/** 严格解析安装平台。 */
function parseClientInstallerPlatform(value) {
    if (value === "win-x64" || value === "linux-x64")
        return value;
    throw new Error("platform 必须为 win-x64 或 linux-x64");
}
/** 严格解析开关更新请求。 */
function parseClientInstallerConfigUpdate(value) {
    if (!isRecord(value) ||
        Object.keys(value).length !== 1 ||
        typeof value.enabled !== "boolean") {
        throw new Error("body 必须且只能包含 boolean enabled");
    }
    return { enabled: value.enabled };
}
/** 严格解析 Client 显示名称更新。 */
function parseClientInstallerNameUpdate(value) {
    if (!isRecord(value) ||
        Object.keys(value).length !== 1 ||
        typeof value.name !== "string") {
        throw new Error("body 必须且只能包含 string name");
    }
    const name = value.name.trim();
    if (!name || name.length > 100)
        throw new Error("name 长度必须为 1-100");
    return { name };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
