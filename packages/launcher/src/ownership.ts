/**
 * 受管进程所有权账本（Linux，ADR-0065）。
 *
 * procd 停服与卸载需要判断「这个 PID 是不是我们上次启动的那个进程」，
 * 不能按进程名 pkill。账本记录 bootId + PID + 进程启动时间 + UID 四元组：
 * 重启或 PID 复用都会让旧记录失效。字段与 `scripts/client-procd-lifecycle.cjs`
 * 的读取实现保持一致，任何一侧改动都必须同步。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OWNED_LEDGER_NAME = "owned-process.json";

export interface OwnedProcessFacts {
	/** /proc/sys/kernel/random/boot_id，重启后变化 */
	bootId: string;
	pid: number;
	/** /proc/<pid>/stat 第 22 字段（starttime，时钟滴答） */
	startTime: string;
	/** /proc/<pid>/status 的 Uid 首字段（数字，与 scripts/client-procd-lifecycle.cjs 一致） */
	uid: number;
}

/** 读取本次启动的 boot_id；无法读取时抛错，由调用方降级为不写账本。 */
export function readBootId(fsRoot = "/"): string {
	return readFileSync(
		join(fsRoot, "proc/sys/kernel/random/boot_id"),
		"utf-8",
	).trim();
}

/**
 * 读取指定进程的四元组。
 * 解析方式与 scripts/client-procd-lifecycle.cjs 一致：stat 的命令名可能含空格，
 * 因此先定位最后一个 ")"，其后才是字段序列。
 */
export function readOwnedProcessFacts(
	pid = process.pid,
	fsRoot = "/",
): OwnedProcessFacts {
	const bootId = readBootId(fsRoot);
	const stat = readFileSync(join(fsRoot, "proc", String(pid), "stat"), "utf-8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const startTime = fields[19];
	const status = readFileSync(
		join(fsRoot, "proc", String(pid), "status"),
		"utf-8",
	);
	const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
	if (!startTime || uid === undefined) {
		throw new Error("PROC_FACTS_INCOMPLETE");
	}
	return { bootId, pid, startTime, uid: Number(uid) };
}

/** 覆盖写入账本；目录不存在时由调用方决定是否忽略。 */
export function writeOwnedLedger(
	stateDir: string,
	facts: OwnedProcessFacts = readOwnedProcessFacts(),
): string {
	const ledgerPath = join(stateDir, OWNED_LEDGER_NAME);
	const tmpPath = `${ledgerPath}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(facts)}\n`, { mode: 0o600 });
	renameSync(tmpPath, ledgerPath);
	return ledgerPath;
}

/** 读取账本；不存在或内容不完整时返回 null（损坏记录不当作所有权证据）。 */
export function readOwnedLedger(stateDir: string): OwnedProcessFacts | null {
	try {
		const raw = readFileSync(join(stateDir, OWNED_LEDGER_NAME), "utf-8");
		const value = JSON.parse(raw) as Partial<OwnedProcessFacts>;
		if (
			typeof value.bootId !== "string" ||
			typeof value.pid !== "number" ||
			typeof value.startTime !== "string" ||
			typeof value.uid !== "number"
		) {
			return null;
		}
		return {
			bootId: value.bootId,
			pid: value.pid,
			startTime: value.startTime,
			uid: value.uid,
		};
	} catch {
		return null;
	}
}

/** 账本记录的受管进程是否仍在运行（bootId + startTime 都要一致，防 PID 复用与重启）。 */
export function isOwnedProcessAlive(
	saved: OwnedProcessFacts,
	fsRoot = "/",
): boolean {
	try {
		const live = readOwnedProcessFacts(saved.pid, fsRoot);
		return (
			live.bootId === saved.bootId &&
			live.startTime === saved.startTime &&
			live.uid === saved.uid
		);
	} catch {
		return false;
	}
}

/** 回收遗留受管进程的可注入依赖（测试用 fake /proc 与假 kill）。 */
export interface ReclaimOwnedProcessOptions {
	fsRoot?: string;
	kill?: (pid: number) => void;
	log?: (message: string) => void;
}

/**
 * 启动前回收账本里仍活着的受管进程。
 *
 * - 账本不存在：视为没有记录，放行；
 * - 账本存在但无法解析：证据不足，拒绝启动（fail-closed，不能当作“没有进程”）；
 * - 四元组一致：强杀旧进程；复证失败（PID 复用/重启）时视为无有效记录。
 */
export function reclaimOwnedProcess(
	stateDir: string,
	options: ReclaimOwnedProcessOptions = {},
): void {
	const ledgerPath = join(stateDir, OWNED_LEDGER_NAME);
	const saved = readOwnedLedger(stateDir);
	if (!saved) {
		if (!existsSync(ledgerPath)) return;
		throw new Error(
			`OWNED_PROCESS_ALIVE: 所有权账本无法解析（${join(stateDir, OWNED_LEDGER_NAME)}），拒绝启动；请人工确认无遗留进程后删除该文件`,
		);
	}
	if (!isOwnedProcessAlive(saved, options.fsRoot ?? "/")) return;
	try {
		const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
		kill(saved.pid);
		options.log?.(`回收遗留受管进程 pid=${saved.pid}`);
	} catch (error) {
		throw new Error(
			`OWNED_PROCESS_ALIVE: ${saved.pid} 无法回收（${(error as Error).message}）`,
		);
	}
}
