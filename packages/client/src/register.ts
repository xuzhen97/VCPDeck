import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { MachineRegister } from "@vcpdeck/shared";

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

export function getRegisterInfo(): MachineRegister {
  const cpus = os.cpus();
  return {
    clientId: CLIENT_ID,
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
    cpuModel: cpus[0]?.model || "unknown",
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    totalDiskMB: 0, // ponytail: skip disk check, add when needed
    clientVersion: "0.0.0",
    capabilities: ["exec"],
  };
}
