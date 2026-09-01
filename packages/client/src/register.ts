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

export function getRegisterInfo(
	piStatus?: PiCapabilityStatus,
	terminalStatus?: TerminalCapabilityStatus,
): MachineRegister {
	const cpus = os.cpus();
	const caps: string[] = ["exec", "file.read", "file.write"];
	if (isFrpAvailable()) {
		caps.push("frp");
	}
	if (piStatus?.available) {
		caps.push("agent.pi");
	}
	if (terminalStatus?.available) {
		caps.push("terminal.pty");
	}
	const capabilityDetails: MachineRegister["capabilityDetails"] = {};
	if (piStatus !== undefined) capabilityDetails.pi = piStatus;
	if (terminalStatus !== undefined) capabilityDetails.terminal = terminalStatus;
	// FRP 能力：按 frpc 可探测性声明；协商固定为 protocol v1（不按应用版本猜测）。
	const frpStatus: FrpCapabilityStatus = isFrpAvailable()
		? { available: true, reconcileProtocolVersion: FRP_RECONCILE_PROTOCOL_VERSION }
		: { available: false, code: "FRPC_NOT_FOUND" };
	capabilityDetails.frp = frpStatus;
	return {
		clientId: CLIENT_ID,
		hostname: os.hostname(),
		os: `${os.platform()} ${os.release()}`,
		cpuModel: cpus[0]?.model || "unknown",
		totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
		clientVersion: VERSION,
		capabilities: caps,
		capabilityDetails,
	};
}
