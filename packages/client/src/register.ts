import * as os from "node:os";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
	FrpCapabilityStatus,
	MachineRegister,
	PiCapabilityStatus,
	TerminalCapabilityStatus,
} from "@vcpdeck/shared";
import { FRP_RECONCILE_PROTOCOL_VERSION, VERSION } from "@vcpdeck/shared";
import { isFrpAvailable } from "./frpc-daemon.js";
import type { RuntimeSecurityInfo } from "./privileged-capability.js";

const CLIENT_ID_DIR = path.join(os.homedir(), ".vcpdeck");
const CLIENT_ID_FILE = path.join(CLIENT_ID_DIR, "client-id");

function loadOrCreateClientId(): string {
	try {
		return fs.readFileSync(CLIENT_ID_FILE, "utf-8").trim();
	} catch {
		const id = randomUUID();
		fs.mkdirSync(CLIENT_ID_DIR, { recursive: true });
		fs.writeFileSync(CLIENT_ID_FILE, id);
		return id;
	}
}

export const CLIENT_ID =
	process.env.VCPDECK_CLIENT_ID || loadOrCreateClientId();

/**
 * 构造机器注册消息。
 * @param piStatus Pi 能力探测结果（可选）
 * @param terminalStatus 终端能力探测结果（可选）
 * @param runtimeSecurity 运行时安全摘要：非交互特权能力（capabilityDetails.privileged）
 *   与安装模式（顶层 installation）；缺省不上报，不新增可执行 capability 字符串。
 */
/**
 * M1 迁移验证专用模式（VCPDECK_MIGRATION_VERIFY_ONLY=1）：
 * 注册保留身份/版本/安装/特权摘要，但不发布任何 operational 能力，
 * 使 Server 能在不下发任何工作前验证身份与运行时安全。仅 Linux A2 迁移使用，
 * 全新安装与稳态永不进入该模式。
 */
export function isMigrationVerifyOnly(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.VCPDECK_MIGRATION_VERIFY_ONLY === "1";
}

export function getRegisterInfo(
	piStatus?: PiCapabilityStatus,
	terminalStatus?: TerminalCapabilityStatus,
	runtimeSecurity?: RuntimeSecurityInfo,
	env: NodeJS.ProcessEnv = process.env,
): MachineRegister {
	const verifyOnly = isMigrationVerifyOnly(env);
	const cpus = os.cpus();
	const caps: string[] = [];
	if (!verifyOnly) {
		caps.push("exec", "file.read", "file.write");
		if (isFrpAvailable()) {
			caps.push("frp");
		}
		if (piStatus?.available) {
			caps.push("agent.pi");
		}
		if (terminalStatus?.available) {
			caps.push("terminal.pty");
		}
	}
	const capabilityDetails: MachineRegister["capabilityDetails"] = {};
	if (!verifyOnly) {
		if (piStatus !== undefined) capabilityDetails.pi = piStatus;
		if (terminalStatus !== undefined) capabilityDetails.terminal = terminalStatus;
		// FRP 能力：按 frpc 可探测性声明；协商固定为 protocol v1（不按应用版本猜测）。
		const frpStatus: FrpCapabilityStatus = isFrpAvailable()
			? { available: true, reconcileProtocolVersion: FRP_RECONCILE_PROTOCOL_VERSION }
			: { available: false, code: "FRPC_NOT_FOUND" };
		capabilityDetails.frp = frpStatus;
	}
	// 运行时安全摘要两种模式都上报（M1 验证依赖 privileged 与 installation）；不含本地路径或凭据。
	if (runtimeSecurity?.privileged !== undefined) {
		capabilityDetails.privileged = runtimeSecurity.privileged;
	}
	const register: MachineRegister = {
		clientId: CLIENT_ID,
		hostname: os.hostname(),
		os: `${os.platform()} ${os.release()}`,
		cpuModel: cpus[0]?.model || "unknown",
		totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
		clientVersion: VERSION,
		capabilities: caps,
		capabilityDetails,
	};
	if (runtimeSecurity?.installation !== undefined) {
		register.installation = runtimeSecurity.installation;
	}
	return register;
}
