/** Client 一键安装支持的平台。 */
export type ClientInstallerPlatform = "win-x64" | "linux-x64";

/** Client 一键安装稳定错误码。 */
export const ClientInstallerErrorCode = {
	DISABLED: "CLIENT_INSTALLER_DISABLED",
	RELEASE_NOT_READY: "CLIENT_INSTALLER_RELEASE_NOT_READY",
	ARCHIVE_MISSING: "CLIENT_INSTALLER_ARCHIVE_MISSING",
	PLATFORM_UNSUPPORTED: "CLIENT_INSTALLER_PLATFORM_UNSUPPORTED",
	ASSET_MISSING: "CLIENT_INSTALLER_ASSET_MISSING",
	PSK_INVALID: "CLIENT_INSTALLER_PSK_INVALID",
	CLIENT_NOT_FOUND: "CLIENT_INSTALLER_CLIENT_NOT_FOUND",
} as const;

export type ClientInstallerErrorCode =
	(typeof ClientInstallerErrorCode)[keyof typeof ClientInstallerErrorCode];

/** 单个平台的一键安装就绪状态。 */
export interface ClientInstallerPlatformStatus {
	available: boolean;
	reasonCode?: ClientInstallerErrorCode;
}

/** 发版页展示的单台 Client 系统级部署迁移状态（不含 capability 原文与凭据，ADR-0027）。 */
export interface ClientInstallerMigrationEntry {
	clientId: string;
	name: string;
	os: string;
	online: boolean;
	/** 不合规的稳定原因；数组只包含需要人工升级的 Client */
	reason: import("./machine-register.js").ClientInstallationComplianceReason;
}

/** 发版页安装合规汇总：全部 Client（含离线）按最后有效摘要判定。 */
export interface ClientInstallerMigrationSummary {
	compliantCount: number;
	needsUpgradeCount: number;
	clients: ClientInstallerMigrationEntry[];
}

/** 认证用户读取的一键安装配置。 */
export interface ClientInstallerConfigInfo {
	enabled: boolean;
	updatedAt: string | null;
	updatedByName: string | null;
	updatedVia: string | null;
	serverVersion: string;
	releaseReady: boolean;
	platforms: Record<ClientInstallerPlatform, ClientInstallerPlatformStatus>;
	/** 系统级部署迁移汇总（ADR-0027）；独立于业务 Release 版本 */
	migration: ClientInstallerMigrationSummary;
}

/** 安装引导器所需的公开、非秘密信息。 */
export interface ClientInstallerPreflight {
	serverVersion: string;
	releaseVersion: string;
	platform: ClientInstallerPlatform;
	archiveSize: number;
	installerUrl: string;
	installerSha256: string;
	lowLevelInstallerUrl: string;
	lowLevelInstallerSha256: string;
	nodeConstraint: string;
	nodeMirrors: string[];
	npmRegistries: string[];
}

/** 启用安装入口后返回的秘密 bootstrap 信息。 */
export interface ClientInstallerBootstrap {
	serverVersion: string;
	releaseVersion: string;
	platform: ClientInstallerPlatform;
	archiveUrl: string;
	archiveSha256: string;
	archiveSize: number;
	psk: string;
	verificationTimeoutMs: number;
}

/** Server 对目标 Client 的安装验收摘要。 */
export interface ClientInstallerClientStatus {
	registered: boolean;
	online: boolean;
	clientVersion: string | null;
	name: string | null;
	hostname: string | null;
	capabilitiesReported: boolean;
	/** 安装模式（旧 Client 未报告时为 null） */
	installationMode: MachineInstallationMode | null;
	/** 非交互 sudo 是否可用（旧 Client 未报告时为 null） */
	nonInteractiveSudo: boolean | null;
	/** 特权模式（旧 Client 未报告时为 null）：sudo-all / windows-system / unavailable */
	privilegedMode: PrivilegedCapabilityMode | null;
	connectedAt: string | null;
	lastHeartbeatAt: string | null;
}

import type { MachineInstallationMode, PrivilegedCapabilityMode } from "./machine-register.js";

/** 严格解析安装平台。 */
export function parseClientInstallerPlatform(
	value: unknown,
): ClientInstallerPlatform {
	if (value === "win-x64" || value === "linux-x64") return value;
	throw new Error("platform 必须为 win-x64 或 linux-x64");
}

/** 严格解析开关更新请求。 */
export function parseClientInstallerConfigUpdate(value: unknown): {
	enabled: boolean;
} {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		typeof value.enabled !== "boolean"
	) {
		throw new Error("body 必须且只能包含 boolean enabled");
	}
	return { enabled: value.enabled };
}

/** 严格解析 Client 显示名称更新。 */
export function parseClientInstallerNameUpdate(value: unknown): {
	name: string;
} {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		typeof value.name !== "string"
	) {
		throw new Error("body 必须且只能包含 string name");
	}
	const name = value.name.trim();
	if (!name || name.length > 100) throw new Error("name 长度必须为 1-100");
	return { name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
