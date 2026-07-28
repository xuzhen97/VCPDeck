import * as os from "node:os";
import * as fs from "node:fs";
import type { Heartbeat } from "@vcpdeck/shared";
import { CLIENT_ID } from "./register.js";

// ponytail: 模块级缓存前一次 CPU 累计时间，计算两次心跳间的 delta
let prevCpu = { idle: 0, total: 0 };

function calcCpuPercent(): number {
	const cpus = os.cpus();
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		idle += cpu.times.idle;
		total +=
			cpu.times.user +
			cpu.times.nice +
			cpu.times.sys +
			cpu.times.idle +
			cpu.times.irq;
	}
	// 首次调用，只缓存不返回值
	if (prevCpu.total === 0 && prevCpu.idle === 0) {
		prevCpu = { idle, total };
		return 0;
	}
	const deltaIdle = idle - prevCpu.idle;
	const deltaTotal = total - prevCpu.total;
	prevCpu = { idle, total };
	if (deltaTotal <= 0) return 0;
	return Math.round((1 - deltaIdle / deltaTotal) * 100);
}

function calcDiskPercent(): number {
	try {
		const s = fs.statfsSync(
			os.platform() === "win32" ? process.cwd().charAt(0) + ":\\" : "/",
		);
		const total = Number(BigInt(s.blocks) * BigInt(s.bsize));
		const free = Number(BigInt(s.bavail) * BigInt(s.bsize));
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
