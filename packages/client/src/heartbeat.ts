import * as os from "node:os";
import * as fs from "node:fs";
import type { Heartbeat } from "@vcpdeck/shared";
import { CLIENT_ID } from "./register.js";

function calcCpuPercent(): number {
	const cpus = os.cpus();
	let totalIdle = 0;
	let totalAll = 0;
	for (const cpu of cpus) {
		totalIdle += cpu.times.idle;
		totalAll +=
			cpu.times.user +
			cpu.times.nice +
			cpu.times.sys +
			cpu.times.idle +
			cpu.times.irq;
	}
	if (totalAll === 0) return 0;
	return Math.round((1 - totalIdle / totalAll) * 100);
}

function calcDiskPercent(): number {
	try {
		const s = fs.statfsSync(
			os.platform() === "win32" ? process.cwd().charAt(0) + ":\\" : "/",
		);
		const total = Number(BigInt(s.blocks) * BigInt(s.bsize));
		const free = Number(BigInt(s.bfree) * BigInt(s.bsize));
		if (total === 0) return 0;
		return Math.round(((total - free) / total) * 100);
	} catch {
		return 0;
	}
}

export function getHeartbeat(runningJobs: string[]): Heartbeat {
	const totalMem = os.totalmem();
	const freeMem = os.freemem();

	return {
		clientId: CLIENT_ID,
		cpuPercent: Math.min(calcCpuPercent(), 100),
		memPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
		diskPercent: Math.min(calcDiskPercent(), 100),
		runningJobs,
		uptime: Math.round(process.uptime()),
	};
}
