import {
	parseFrpCapabilityStatus,
	type FrpCapabilityStatus,
} from "./frp-runtime.js";
import type {
	PiBundleCapability,
	PiCapabilityStatus,
	PiModelCatalogStatus,
} from "./pi.js";
import type { TerminalCapabilityStatus } from "./terminal.js";
import {
	parseP2pTunnelCapabilityStatus,
	type P2pTunnelCapabilityStatus,
} from "./tunnel.js";

// ── 严格边界：字段长度上限（防御异常注册消息撑爆存储与 UI） ──
const MAX_CLIENT_ID = 128;
const MAX_HOSTNAME = 256;
const MAX_OS = 64;
const MAX_CPU_MODEL = 128;
const MAX_CLIENT_VERSION = 64;
const MAX_CAPABILITY = 64;
const MAX_CAPABILITIES = 100;
const MAX_TOTAL_MEM_MB = 10_000_000;
const MAX_RUN_AS_USER = 256;

/** Client 安装模式（ADR-0023：Linux A2 专用账户 + systemd；ADR-0027：Windows SYSTEM 开机任务；legacy-pm2 为待迁移旧安装）。 */
export const MachineInstallationMode = {
	SYSTEMD_ROOT_EQUIVALENT: "systemd-root-equivalent",
	WINDOWS_SYSTEM_TASK: "windows-system-task",
	LEGACY_PM2: "legacy-pm2",
} as const;

export type MachineInstallationMode =
	(typeof MachineInstallationMode)[keyof typeof MachineInstallationMode];

/** 严格解析后的 Client 安装模式摘要。 */
export interface MachineInstallationStatus {
	mode: MachineInstallationMode;
}

/** 非交互特权执行模式：sudo-all（Linux A2）、windows-system（ADR-0027 SYSTEM 任务）与 unavailable。 */
export const PrivilegedCapabilityMode = {
	SUDO_ALL: "sudo-all",
	WINDOWS_SYSTEM: "windows-system",
	UNAVAILABLE: "unavailable",
} as const;

export type PrivilegedCapabilityMode =
	(typeof PrivilegedCapabilityMode)[keyof typeof PrivilegedCapabilityMode];

/**
 * 严格解析后的 Client 非交互特权能力摘要。
 * `available && mode === "sudo-all"` 表示该 Client 可被当作 root 等价节点对待。
 * `runAsUser` 只是 OS 账户名，不含密码或令牌。
 */
export interface PrivilegedCapabilityStatus {
	available: boolean;
	mode: PrivilegedCapabilityMode;
	nonInteractive: boolean;
	runAsUser: string;
}

/** 机器注册消息（Client → Server，/client Socket.IO）。 */
export interface MachineRegister {
	clientId: string;
	hostname: string;
	os: string;
	cpuModel: string;
	totalMemMB: number;
	clientVersion: string;
	capabilities: string[];
	/** 可选：Client 能力探测结果摘要（旧 Client 缺省） */
	capabilityDetails?: {
		pi?: PiCapabilityStatus;
		terminal?: TerminalCapabilityStatus;
		frp?: FrpCapabilityStatus;
		/** 可选：非交互特权能力摘要（ADR-0023 新 Client） */
		privileged?: PrivilegedCapabilityStatus;
		/** 可选：P2P 隧道能力摘要（ADR-0026 新 Client） */
		p2pTunnel?: P2pTunnelCapabilityStatus;
	};
	/** 可选：安装模式摘要（旧 Client 缺省表示未报告） */
	installation?: MachineInstallationStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	value: unknown,
	field: string,
	maxLength: number,
): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new Error(`${field} 必须为长度 1-${maxLength} 的字符串`);
	}
	return value;
}

/** 严格解析安装模式摘要；未知字段拒绝。 */
export function parseMachineInstallation(
	value: unknown,
): MachineInstallationStatus {
	if (!isRecord(value) || Object.keys(value).length !== 1) {
		throw new Error("installation 必须为仅含 mode 的对象");
	}
	const valid = [
	MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT,
	MachineInstallationMode.WINDOWS_SYSTEM_TASK,
	MachineInstallationMode.LEGACY_PM2,
	];
	if (!valid.includes(value.mode as MachineInstallationMode)) {
		throw new Error(`installation.mode 必须为 ${valid.join(" 或 ")}`);
	}
	return { mode: value.mode as MachineInstallationMode };
}

/** 严格解析特权能力摘要；未知字段拒绝，runAsUser 不含密码或令牌。 */
export function parsePrivilegedCapabilityStatus(
	value: unknown,
): PrivilegedCapabilityStatus {
	if (!isRecord(value) || Object.keys(value).length !== 4) {
		throw new Error("privileged 必须且只能包含 available/mode/nonInteractive/runAsUser");
	}
	const { available, mode, nonInteractive, runAsUser } = value;
	if (typeof available !== "boolean" || typeof nonInteractive !== "boolean") {
		throw new Error("privileged.available 与 privileged.nonInteractive 必须为 boolean");
	}
	if (
		mode !== PrivilegedCapabilityMode.SUDO_ALL &&
		mode !== PrivilegedCapabilityMode.WINDOWS_SYSTEM &&
		mode !== PrivilegedCapabilityMode.UNAVAILABLE
	) {
		throw new Error("privileged.mode 必须为 sudo-all、windows-system 或 unavailable");
	}
	const user = requireString(runAsUser, "privileged.runAsUser", MAX_RUN_AS_USER);
	// 语义约束：sudo-all/windows-system 必须可用且非交互；unavailable 不得声明非交互可用。
	if (
		(mode === PrivilegedCapabilityMode.SUDO_ALL || mode === PrivilegedCapabilityMode.WINDOWS_SYSTEM) &&
		(available !== true || nonInteractive !== true)
	) {
		throw new Error(`privileged.mode=${mode} 必须 available=true 且 nonInteractive=true`);
	}
	if (mode === PrivilegedCapabilityMode.UNAVAILABLE && nonInteractive !== false) {
		throw new Error("privileged.mode=unavailable 必须 nonInteractive=false");
	}
	return { available, mode, nonInteractive, runAsUser: user };
}

/** Pi 能力摘要的已知字段（旧 Client 缺新字段必须仍能解析）。 */
const PI_CAPABILITY_KEYS = new Set([
	"available",
	"sdkVersion",
	"nodeVersion",
	"shellKind",
	"sessionJobProtocolVersion",
	"runtimeSpecProtocolVersion",
	"configMode",
	"modelCatalog",
	"bundle",
	"code",
	"message",
]);

/** Bundle 资源 ID 数量上限（防止异常注册消息撑爆内存与 UI） */
const MAX_BUNDLE_RESOURCES = 64;

const PI_CAPABILITY_FAILURE_CODES = [
	"PI_CLIENT_UNSUPPORTED",
	"PI_NODE_UNSUPPORTED",
	"PI_BASH_NOT_FOUND",
	"PI_RUNTIME_UNAVAILABLE",
	"PI_AUTH_UNAVAILABLE",
] as const;

const PI_SHELL_KINDS = ["configured", "git-bash", "path", "system"] as const;

const MAX_CATALOG_PROVIDERS = 256;

/**
 * 严格解析 Pi 内置模型目录摘要。
 * 只接受 { sdkVersion, providerIds }；providerIds 去重后上限 256 项。
 */
export function parsePiModelCatalogStatus(
	value: unknown,
): PiModelCatalogStatus {
	if (!isRecord(value) || Object.keys(value).length !== 2) {
		throw new Error("pi.modelCatalog 必须且只能包含 sdkVersion/providerIds");
	}
	const sdkVersion = requireString(
		value.sdkVersion,
		"pi.modelCatalog.sdkVersion",
		MAX_CAPABILITY,
	);
	if (
		!Array.isArray(value.providerIds) ||
		value.providerIds.length === 0 ||
		value.providerIds.length > MAX_CATALOG_PROVIDERS
	) {
		throw new Error(
			`pi.modelCatalog.providerIds 数量必须在 1-${MAX_CATALOG_PROVIDERS} 之间`,
		);
	}
	const providerIds = value.providerIds.map((item, index) =>
		requireString(
			item,
			`pi.modelCatalog.providerIds[${index}]`,
			MAX_CAPABILITY,
		),
	);
	if (new Set(providerIds).size !== providerIds.length) {
		throw new Error("pi.modelCatalog.providerIds 存在重复项");
	}
	return { sdkVersion, providerIds };
}

function requirePositiveInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${what} 必须为正整数`);
	}
	return value;
}

/**
 * 严格解析 Pi 能力摘要（与 frp/privileged/p2pTunnel 同级）。
 * 未知字段拒绝；旧 Client 缺 runtimeSpecProtocolVersion/configMode 视为未报告。
 */
export function parsePiCapabilityStatus(value: unknown): PiCapabilityStatus {
	if (!isRecord(value)) throw new Error("pi 必须为对象");
	for (const key of Object.keys(value)) {
		if (!PI_CAPABILITY_KEYS.has(key)) throw new Error(`pi 含未知字段 ${key}`);
	}

	if (value.available === false) {
		if (!PI_CAPABILITY_FAILURE_CODES.includes(value.code as never)) {
			throw new Error("pi.code 必须为已知失败码");
		}
		const code = value.code as (typeof PI_CAPABILITY_FAILURE_CODES)[number];
		const message = requireString(value.message, "pi.message", MAX_CAPABILITY);
		const status: PiCapabilityStatus = { available: false, code, message };
		if (value.nodeVersion !== undefined) {
			status.nodeVersion = requireString(value.nodeVersion, "pi.nodeVersion", MAX_CAPABILITY);
		}
		return status;
	}

	if (value.available === true) {
		const sdkVersion = requireString(value.sdkVersion, "pi.sdkVersion", MAX_CAPABILITY);
		const nodeVersion = requireString(value.nodeVersion, "pi.nodeVersion", MAX_CAPABILITY);
		if (!PI_SHELL_KINDS.includes(value.shellKind as never)) {
			throw new Error("pi.shellKind 必须为 configured、git-bash、path 或 system");
		}
		const status: PiCapabilityStatus = {
			available: true,
			sdkVersion,
			nodeVersion,
			shellKind: value.shellKind as (typeof PI_SHELL_KINDS)[number],
		};
		if (value.sessionJobProtocolVersion !== undefined) {
			status.sessionJobProtocolVersion = requirePositiveInt(
				value.sessionJobProtocolVersion,
				"pi.sessionJobProtocolVersion",
			);
		}
		if (value.runtimeSpecProtocolVersion !== undefined) {
			status.runtimeSpecProtocolVersion = requirePositiveInt(
				value.runtimeSpecProtocolVersion,
				"pi.runtimeSpecProtocolVersion",
			);
		}
		if (value.configMode !== undefined) {
			if (value.configMode !== "server-authoritative") {
				throw new Error("pi.configMode 必须为 server-authoritative");
			}
			status.configMode = "server-authoritative";
		}
		if (value.modelCatalog !== undefined) {
			status.modelCatalog = parsePiModelCatalogStatus(value.modelCatalog);
		}
		if (value.bundle !== undefined) {
			status.bundle = parsePiBundleCapability(value.bundle);
		}
		return status;
	}

	throw new Error("pi.available 必须为 boolean");
}

/**
 * 严格解析 Client 上报的 Bundle 能力。
 * 只携带资源 ID 与版本事实，不含任何文件内容或路径。
 */
export function parsePiBundleCapability(value: unknown): PiBundleCapability {
	if (!isRecord(value)) throw new Error("pi.bundle 必须为对象");
	for (const key of Object.keys(value)) {
		if (
			!["protocolVersion", "bundleVersion", "piSdkVersion", "resourceIds"].includes(
				key,
			)
		) {
			throw new Error(`pi.bundle 含未知字段 ${key}`);
		}
	}
	const protocolVersion = requirePositiveInt(
		value.protocolVersion,
		"pi.bundle.protocolVersion",
	);
	const bundleVersion = requireString(
		value.bundleVersion,
		"pi.bundle.bundleVersion",
		MAX_CAPABILITY,
	);
	const piSdkVersion = requireString(
		value.piSdkVersion,
		"pi.bundle.piSdkVersion",
		MAX_CAPABILITY,
	);
	if (
		!Array.isArray(value.resourceIds) ||
		value.resourceIds.length === 0 ||
		value.resourceIds.length > MAX_BUNDLE_RESOURCES
	) {
		throw new Error(
			`pi.bundle.resourceIds 数量必须在 1-${MAX_BUNDLE_RESOURCES} 之间`,
		);
	}
	const resourceIds = value.resourceIds.map((item, index) =>
		requireString(item, `pi.bundle.resourceIds[${index}]`, MAX_CAPABILITY),
	);
	if (new Set(resourceIds).size !== resourceIds.length) {
		throw new Error("pi.bundle.resourceIds 存在重复项");
	}
	return { protocolVersion, bundleVersion, piSdkVersion, resourceIds };
}

/** 安装/特权合规不稳定的稳定原因（人工升级提示的单一事实来源，ADR-0027）。 */
export const ClientInstallationComplianceReason = {
	/** 显式上报旧 PM2 安装模式 */
	LEGACY_PM2: "legacy-pm2",
	/** 安装模式未报告（旧 Client 缺字段） */
	INSTALLATION_UNREPORTED: "installation-unreported",
	/** 特权模式/可用性不满足系统级要求，或未报告 */
	PRIVILEGE_NONCOMPLIANT: "privilege-noncompliant",
	/** 安装模式与操作系统不匹配 */
	PLATFORM_MODE_MISMATCH: "platform-mode-mismatch",
	/** 不支持的操作系统 */
	PLATFORM_UNSUPPORTED: "platform-unsupported",
} as const;

export type ClientInstallationComplianceReason =
	(typeof ClientInstallationComplianceReason)[keyof typeof ClientInstallationComplianceReason];

/** 合规判定所需的 Client 最小投影（与 ClientInfo 字段同形，独立于业务版本）。 */
export type ClientInstallationComplianceSource = Pick<
	MachineRegister,
	"os" | "installation" | "capabilityDetails"
>;

/** 安装与特权合规判定结果；compliant=true 时 reason 为 null。 */
export interface ClientInstallationCompliance {
	compliant: boolean;
	reason: ClientInstallationComplianceReason | null;
}

type PrivilegedStatusLike = Pick<
	PrivilegedCapabilityStatus,
	"available" | "mode" | "nonInteractive"
>;

/**
 * 判定 Client 部署是否合规（独立于业务版本，ADR-0027）。
 * Windows 需 windows-system-task + windows-system；Linux 需 systemd-root-equivalent + sudo-all 且非交互。
 * 缺字段只判“未报告”，不抛出、不猜测；未知平台返回 platform-unsupported。
 */
export function getClientInstallationCompliance(
	client: {
		os: string;
		installation?: MachineInstallationStatus;
		capabilityDetails?: { privileged?: PrivilegedStatusLike };
	},
): ClientInstallationCompliance {
	const mode = client.installation?.mode;
	if (mode === undefined) {
		return { compliant: false, reason: ClientInstallationComplianceReason.INSTALLATION_UNREPORTED };
	}
	if (mode === MachineInstallationMode.LEGACY_PM2) {
		return { compliant: false, reason: ClientInstallationComplianceReason.LEGACY_PM2 };
	}
	const isWin = client.os.startsWith("win32");
	const isLinux = client.os.startsWith("linux");
	if (!isWin && !isLinux) {
		return { compliant: false, reason: ClientInstallationComplianceReason.PLATFORM_UNSUPPORTED };
	}
	const expected = isWin ? MachineInstallationMode.WINDOWS_SYSTEM_TASK : MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT;
	if (mode !== expected) {
		return { compliant: false, reason: ClientInstallationComplianceReason.PLATFORM_MODE_MISMATCH };
	}
	const privileged = client.capabilityDetails?.privileged;
	const expectedPrivilege = isWin ? PrivilegedCapabilityMode.WINDOWS_SYSTEM : PrivilegedCapabilityMode.SUDO_ALL;
	if (
		privileged === undefined ||
		privileged.mode !== expectedPrivilege ||
		privileged.available !== true ||
		privileged.nonInteractive !== true
	) {
		return { compliant: false, reason: ClientInstallationComplianceReason.PRIVILEGE_NONCOMPLIANT };
	}
	return { compliant: true, reason: null };
}

/**
 * 严格解析机器注册消息。
 * 旧 Client 省略 privileged/installation 时按“未报告”处理（字段缺省而非猜测）。
 */
export function parseMachineRegister(value: unknown): MachineRegister {
	if (!isRecord(value)) throw new Error("register 必须为对象");
	const clientId = requireString(value.clientId, "clientId", MAX_CLIENT_ID);
	const hostname = requireString(value.hostname, "hostname", MAX_HOSTNAME);
	const os = requireString(value.os, "os", MAX_OS);
	const cpuModel = requireString(value.cpuModel, "cpuModel", MAX_CPU_MODEL);
	const clientVersion = requireString(value.clientVersion, "clientVersion", MAX_CLIENT_VERSION);

	const totalMemMB = value.totalMemMB;
	if (
		typeof totalMemMB !== "number" ||
		!Number.isFinite(totalMemMB) ||
		totalMemMB <= 0 ||
		totalMemMB > MAX_TOTAL_MEM_MB
	) {
		throw new Error("totalMemMB 必须为 0-10000000 的有限数字");
	}

	if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITIES) {
		throw new Error(`capabilities 必须为长度 0-${MAX_CAPABILITIES} 的字符串数组`);
	}
	const capabilities = value.capabilities.map((cap) =>
		requireString(cap, "capabilities[]", MAX_CAPABILITY),
	);

	const result: MachineRegister = {
		clientId,
		hostname,
		os,
		cpuModel,
		totalMemMB,
		clientVersion,
		capabilities,
	};

	if (value.capabilityDetails !== undefined) {
		const details = value.capabilityDetails;
		if (!isRecord(details)) throw new Error("capabilityDetails 必须为对象");
		const known = ["pi", "terminal", "frp", "privileged", "p2pTunnel"] as const;
		for (const key of Object.keys(details)) {
			if (!known.includes(key as (typeof known)[number])) {
				throw new Error(`capabilityDetails 含未知字段 ${key}`);
			}
		}
		const parsedDetails: MachineRegister["capabilityDetails"] = {};
		// pi/terminal 沿用现有透传行为（Server 投影阶段同样宽松处理），frp 严格解析。
		if (details.pi !== undefined) {
			parsedDetails.pi = parsePiCapabilityStatus(details.pi);
		}
		if (details.terminal !== undefined) {
			parsedDetails.terminal = details.terminal as TerminalCapabilityStatus;
		}
		if (details.frp !== undefined) {
			parsedDetails.frp = parseFrpCapabilityStatus(details.frp);
		}
		if (details.privileged !== undefined) {
			parsedDetails.privileged = parsePrivilegedCapabilityStatus(details.privileged);
		}
		if (details.p2pTunnel !== undefined) {
			parsedDetails.p2pTunnel = parseP2pTunnelCapabilityStatus(details.p2pTunnel);
		}
		result.capabilityDetails = parsedDetails;
	}

	if (value.installation !== undefined) {
		result.installation = parseMachineInstallation(value.installation);
	}

	return result;
}
