import {
	parseFrpCapabilityStatus,
	type FrpCapabilityStatus,
} from "./frp-runtime.js";
import type { PiCapabilityStatus } from "./pi.js";
import type { TerminalCapabilityStatus } from "./terminal.js";

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

/** Client 安装模式（ADR-0023：Linux A2 专用账户 + systemd 系统服务；legacy-pm2 为待迁移旧安装）。 */
export const MachineInstallationMode = {
	SYSTEMD_ROOT_EQUIVALENT: "systemd-root-equivalent",
	LEGACY_PM2: "legacy-pm2",
} as const;

export type MachineInstallationMode =
	(typeof MachineInstallationMode)[keyof typeof MachineInstallationMode];

/** 严格解析后的 Client 安装模式摘要。 */
export interface MachineInstallationStatus {
	mode: MachineInstallationMode;
}

/** 非交互特权执行模式：仅 sudo-all（Q2）与 unavailable 两种。 */
export const PrivilegedCapabilityMode = {
	SUDO_ALL: "sudo-all",
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
	const valid = [MachineInstallationMode.SYSTEMD_ROOT_EQUIVALENT, MachineInstallationMode.LEGACY_PM2];
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
	if (mode !== PrivilegedCapabilityMode.SUDO_ALL && mode !== PrivilegedCapabilityMode.UNAVAILABLE) {
		throw new Error("privileged.mode 必须为 sudo-all 或 unavailable");
	}
	const user = requireString(runAsUser, "privileged.runAsUser", MAX_RUN_AS_USER);
	// 语义约束：unavailable 不得声明非交互可用；sudo-all 必须可用。
	if (mode === PrivilegedCapabilityMode.SUDO_ALL && available !== true) {
		throw new Error("privileged.mode=sudo-all 必须 available=true");
	}
	if (mode === PrivilegedCapabilityMode.UNAVAILABLE && nonInteractive !== false) {
		throw new Error("privileged.mode=unavailable 必须 nonInteractive=false");
	}
	return { available, mode, nonInteractive, runAsUser: user };
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
		const known = ["pi", "terminal", "frp", "privileged"] as const;
		for (const key of Object.keys(details)) {
			if (!known.includes(key as (typeof known)[number])) {
				throw new Error(`capabilityDetails 含未知字段 ${key}`);
			}
		}
		const parsedDetails: MachineRegister["capabilityDetails"] = {};
		// pi/terminal 沿用现有透传行为（Server 投影阶段同样宽松处理），frp 严格解析。
		if (details.pi !== undefined) parsedDetails.pi = details.pi as PiCapabilityStatus;
		if (details.terminal !== undefined) {
			parsedDetails.terminal = details.terminal as TerminalCapabilityStatus;
		}
		if (details.frp !== undefined) {
			parsedDetails.frp = parseFrpCapabilityStatus(details.frp);
		}
		if (details.privileged !== undefined) {
			parsedDetails.privileged = parsePrivilegedCapabilityStatus(details.privileged);
		}
		result.capabilityDetails = parsedDetails;
	}

	if (value.installation !== undefined) {
		result.installation = parseMachineInstallation(value.installation);
	}

	return result;
}
