import * as os from "node:os";
import type { Heartbeat } from "@vcpdeck/shared";
import { CLIENT_ID } from "./register.js";

export function getHeartbeat(runningJobs: string[]): Heartbeat {
  const cpuCount = os.cpus().length;
  const loadAvg = os.loadavg()[0];
  const cpuPercent = Math.round((loadAvg / cpuCount) * 100);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

  return {
    clientId: CLIENT_ID,
    cpuPercent: Math.min(cpuPercent, 100),
    memPercent: Math.min(memPercent, 100),
    diskPercent: 0, // ponytail: skip disk, add when needed
    runningJobs,
    uptime: Math.round(process.uptime()),
  };
}
