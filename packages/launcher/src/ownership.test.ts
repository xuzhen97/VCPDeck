/**
 * 受管进程所有权账本测试（ADR-0065）。
 *
 * 账本必须记录受管 Client 的 bootId + PID + 启动时间 + UID；停服/卸载只用这份
 * 证据判断进程归属，绝不按进程名 pkill。PID 复用、重启或记录损坏都不得被当作
 * “进程仍归我们所有”。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isOwnedProcessAlive,
	readOwnedLedger,
	readOwnedProcessFacts,
	reclaimOwnedProcess,
	writeOwnedLedger,
} from "./ownership.js";

const roots: string[] = [];

function fakeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-owned-"));
	roots.push(root);
	mkdirSync(join(root, "proc", "sys", "kernel", "random"), { recursive: true });
	writeFileSync(join(root, "proc", "sys", "kernel", "random", "boot_id"), "boot-1\n");
	return root;
}

function writeProc(root: string, pid: number, startTime: string, uid = "0"): void {
	mkdirSync(join(root, "proc", String(pid)), { recursive: true });
	// 字段布局与真实 /proc/<pid>/stat 一致：命令名后第 20 项是 starttime。
	const fields = ["S", ...Array.from({ length: 18 }, () => "0"), startTime, "0", "0"];
	writeFileSync(
		join(root, "proc", String(pid), "stat"),
		`${pid} (node) ${fields.join(" ")}\n`,
	);
	writeFileSync(
		join(root, "proc", String(pid), "status"),
		`Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("受管进程账本", () => {
	it("读取四元组并写入/读回账本", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const facts = readOwnedProcessFacts(4321, root);
		expect(facts).toEqual({ bootId: "boot-1", pid: 4321, startTime: "777", uid: 0 });

		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeOwnedLedger(stateDir, facts);
		expect(readOwnedLedger(stateDir)).toEqual(facts);
	});

	it("PID 复用（starttime 变化）与重启（bootId 变化）都不再算活着的受管进程", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const saved = readOwnedProcessFacts(4321, root);
		expect(isOwnedProcessAlive(saved, root)).toBe(true);

		writeProc(root, 4321, "999");
		expect(isOwnedProcessAlive(saved, root)).toBe(false);

		writeProc(root, 4321, "777");
		writeFileSync(join(root, "proc", "sys", "kernel", "random", "boot_id"), "boot-2\n");
		expect(isOwnedProcessAlive(saved, root)).toBe(false);
	});

	it("进程已不存在时判定为不存活，而不是抛错", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const saved = readOwnedProcessFacts(4321, root);
		rmSync(join(root, "proc", "4321"), { recursive: true, force: true });
		expect(isOwnedProcessAlive(saved, root)).toBe(false);
	});

	it("账本缺失或内容损坏时返回 null，不当作所有权证据", () => {
		const root = fakeRoot();
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		expect(readOwnedLedger(stateDir)).toBeNull();

		writeFileSync(join(stateDir, "owned-process.json"), "{not-json");
		expect(readOwnedLedger(stateDir)).toBeNull();

		writeFileSync(join(stateDir, "owned-process.json"), JSON.stringify({ pid: 1 }));
		expect(readOwnedLedger(stateDir)).toBeNull();
	});

	it("缺少 Uid 行时拒绝产出四元组", () => {
		const root = fakeRoot();
		mkdirSync(join(root, "proc", "12"), { recursive: true });
		writeFileSync(join(root, "proc", "12", "stat"), "12 (node) S 0 0\n");
		writeFileSync(join(root, "proc", "12", "status"), "Name:\tnode\n");
		expect(() => readOwnedProcessFacts(12, root)).toThrow(/PROC_FACTS_INCOMPLETE/);
	});
});

describe("启动前回收遗留受管进程", () => {
	it("账本存在但无法解析时拒绝启动（fail-closed）", () => {
		const root = fakeRoot();
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "owned-process.json"), "{not-json");
		expect(() => reclaimOwnedProcess(stateDir, { fsRoot: root })).toThrow(
			/OWNED_PROCESS_ALIVE/,
		);
	});

	it("账本缺失时放行且不杀任何进程", () => {
		const root = fakeRoot();
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		const killed: number[] = [];
		reclaimOwnedProcess(stateDir, { fsRoot: root, kill: (pid) => killed.push(pid) });
		expect(killed).toEqual([]);
	});

	it("四元组一致时强杀遗留进程并记录日志", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeOwnedLedger(stateDir, readOwnedProcessFacts(4321, root));
		const killed: number[] = [];
		const logs: string[] = [];
		reclaimOwnedProcess(stateDir, {
			fsRoot: root,
			kill: (pid) => killed.push(pid),
			log: (message) => logs.push(message),
		});
		expect(killed).toEqual([4321]);
		expect(logs.join("")).toContain("4321");
	});

	it("进程已消失或 PID 复用时不误杀", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeOwnedLedger(stateDir, readOwnedProcessFacts(4321, root));
		writeProc(root, 4321, "999");
		const killed: number[] = [];
		reclaimOwnedProcess(stateDir, { fsRoot: root, kill: (pid) => killed.push(pid) });
		expect(killed).toEqual([]);
	});

	it("回收失败时抛稳定错误码，而不是吞掉", () => {
		const root = fakeRoot();
		writeProc(root, 4321, "777");
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		writeOwnedLedger(stateDir, readOwnedProcessFacts(4321, root));
		expect(() =>
			reclaimOwnedProcess(stateDir, {
				fsRoot: root,
				kill: () => {
					throw new Error("EPERM");
				},
			}),
		).toThrow(/OWNED_PROCESS_ALIVE/);
	});
});
