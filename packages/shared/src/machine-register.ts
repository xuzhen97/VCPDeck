import {
	parseFrpCapabilityStatus,
	type FrpCapabilityStatus,
} from "./frp-runtime.js";
import type { TerminalCapabilityStatus } from "./terminal.js";
import {
	parseGitSshCapability,
	type GitSshCapability,
} from "./git-ssh.js";

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

/**
 * 已退役、但仍可能由旧 Client 上报的 `capabilityDetails` 键。
 *
 * 契约：**接受并丢弃**（不持久化、不投影）。退役字段必须容忍，不能让旧 Client
 * 因为“未知字段”被整条注册拒绝（0.19.0 曾因此让全集群掉线）。
 * 仅容纳“曾有定义、现已退役”的键；真正未知的键仍严格拒绝。
 *
 * - `pi`：ADR-0049 退役的 Pi／Agent 能力摘要。
 * - `p2pTunnel`：ADR-0053 退役的 P2P 隧道能力摘要（原 ADR-0026）。
 */
const RETIRED_DETAIL_KEYS = new Set(["pi", "p2pTunnel"]);

/** ACP Host capability 摘要（ADR-0057）：只表示 Client 能启动 ACP Host，不表示 agent 已安装。 */
export interface AcpCapabilityStatus {
	available: boolean;
	protocolVersion?: number;
	code?: string;
}

/** Remote Dev Session 能力摘要（ADR-0058）；只表示 Client 具备 RDS 运行时。 */
export interface RemoteDevCapabilityStatus {
	available: boolean;
	protocolVersion?: number;
	code?: string;
}

/** 严格解析 Remote Dev capability 摘要。 */
export function parseRemoteDevCapabilityStatus(
	value: unknown,
): RemoteDevCapabilityStatus {
	if (!isRecord(value)) throw new Error("remoteDev 必须为对象");
	const allowed = new Set(["available", "protocolVersion", "code"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`remoteDev 含未知字段 ${key}`);
	}
	if (typeof value.available !== "boolean") {
		throw new Error("remoteDev.available 必须为 boolean");
	}
	if (
		value.protocolVersion !== undefined &&
		(!Number.isInteger(value.protocolVersion) ||
			(value.protocolVersion as number) < 1)
	) {
		throw new Error("remoteDev.protocolVersion 必须为正整数");
	}
	if (value.code !== undefined && typeof value.code !== "string") {
		throw new Error("remoteDev.code 必须为 string");
	}
	return {
		available: value.available,
		...(value.protocolVersion !== undefined
			? { protocolVersion: value.protocolVersion as number }
			: {}),
		...(value.code !== undefined ? { code: value.code as string } : {}),
	};
}

/** 严格解析 ACP capability 摘要；旧 Client 缺省即未报告。 */
export function parseAcpCapabilityStatus(value: unknown): AcpCapabilityStatus {
	if (!isRecord(value)) throw new Error("acp 必须为对象");
	const allowed = new Set(["available", "protocolVersion", "code"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`acp 含未知字段 ${key}`);
	}
	if (typeof value.available !== "boolean") {
		throw new Error("acp.available 必须为 boolean");
	}
	if (
		value.protocolVersion !== undefined &&
		(!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1)
	) {
		throw new Error("acp.protocolVersion 必须为正整数");
	}
	if (value.code !== undefined && typeof value.code !== "string") {
		throw new Error("acp.code 必须为 string");
	}
	return {
		available: value.available,
		...(value.protocolVersion !== undefined
			? { protocolVersion: value.protocolVersion as number }
			: {}),
		...(value.code !== undefined ? { code: value.code as string } : {}),
	};
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
		terminal?: TerminalCapabilityStatus;
		frp?: FrpCapabilityStatus;
		/** 可选：非交互特权能力摘要（ADR-0023 新 Client） */
		privileged?: PrivilegedCapabilityStatus;
		/** 可选：Git SSH 受管密钥能力摘要（ADR-0037 新 Client）；旧 Client 缺省即未报告 */
		gitSsh?: GitSshCapability;
		/** 可选：ACP Host 能力摘要（ADR-0057）；旧 Client 缺省即未报告 */
		acp?: AcpCapabilityStatus;
		/** 可选：RDS 能力摘要（ADR-0058）；旧 Client 缺省即未报告 */
		remoteDev?: RemoteDevCapabilityStatus;
	};
	/** 可选：安装模式摘要（旧 Client 缺省表示未报告） */
	installation?: MachineInstallationStatus;
	/**
	 * 可选：注册时仍在运行的 RDS 会话（ADR-0058 修订 2026-10-19）。
	 *
	 * 缺省 = 旧 Client 未报告，Server 不得据此判定任何会话失效；
	 * 空数组 = 新 Client 明确报告"没有存活会话"，Server 据此把该机器遗留的
	 * `active`/`disconnected` 会话收敛为 `interrupted`。
	 */
	remoteDevSessions?: { sessionId: string; generationId: string }[];
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
		const known = ["terminal", "frp", "privileged", "gitSsh", "acp", "remoteDev"] as const;
		for (const key of Object.keys(details)) {
			// ADR-0049 退役的键：旧 Client（如 0.18.2）仍会带 pi 摘要，
			// 接受并丢弃，否则整个集群会因“未知字段”被拒注册。
			if (RETIRED_DETAIL_KEYS.has(key)) continue;
			if (!known.includes(key as (typeof known)[number])) {
				throw new Error(`capabilityDetails 含未知字段 ${key}`);
			}
		}
		const parsedDetails: MachineRegister["capabilityDetails"] = {};
		// terminal 沿用现有透传行为（Server 投影阶段同样宽松处理），frp 严格解析。
		if (details.terminal !== undefined) {
			parsedDetails.terminal = details.terminal as TerminalCapabilityStatus;
		}
		if (details.frp !== undefined) {
			parsedDetails.frp = parseFrpCapabilityStatus(details.frp);
		}
		if (details.privileged !== undefined) {
			parsedDetails.privileged = parsePrivilegedCapabilityStatus(details.privileged);
		}
		if (details.gitSsh !== undefined) {
			parsedDetails.gitSsh = parseGitSshCapability(details.gitSsh);
		}
		if (details.acp !== undefined) {
			parsedDetails.acp = parseAcpCapabilityStatus(details.acp);
		}
		if (details.remoteDev !== undefined) {
			parsedDetails.remoteDev = parseRemoteDevCapabilityStatus(details.remoteDev);
		}
		result.capabilityDetails = parsedDetails;
	}

	if (value.installation !== undefined) {
		result.installation = parseMachineInstallation(value.installation);
	}

	if (value.remoteDevSessions !== undefined) {
		result.remoteDevSessions = parseRemoteDevSessionReports(
			value.remoteDevSessions,
		);
	}

	return result;
}

/** 注册时上报的存活 RDS 会话上限（Client 单机并发会话远小于此值）。 */
const MAX_REMOTE_DEV_SESSION_REPORTS = 64;

/**
 * 解析注册时的 RDS 会话上报。
 *
 * 这是"谁还活着"的唯一权威来源：空数组表示明确没有存活会话，缺省表示未报告，
 * 两者语义不同，不能合并处理。
 */
function parseRemoteDevSessionReports(
	value: unknown,
): { sessionId: string; generationId: string }[] {
	if (!Array.isArray(value)) {
		throw new Error("remoteDevSessions 必须为数组");
	}
	if (value.length > MAX_REMOTE_DEV_SESSION_REPORTS) {
		throw new Error(
			`remoteDevSessions 超过 ${MAX_REMOTE_DEV_SESSION_REPORTS} 项`,
		);
	}
	return value.map((item, index) => {
		if (!isRecord(item)) {
			throw new Error(`remoteDevSessions[${index}] 必须为对象`);
		}
		for (const key of Object.keys(item)) {
			if (key !== "sessionId" && key !== "generationId") {
				throw new Error(`remoteDevSessions[${index}] 含未知字段 ${key}`);
			}
		}
		return {
			sessionId: requireString(
				item.sessionId,
				`remoteDevSessions[${index}].sessionId`,
				128,
			),
			generationId: requireString(
				item.generationId,
				`remoteDevSessions[${index}].generationId`,
				128,
			),
		};
	});
}
