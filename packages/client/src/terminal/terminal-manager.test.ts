import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalManager, type TerminalManagerOptions, type PtyAdapter } from "./terminal-manager.js";
import { TerminalLimits } from "@vcpdeck/shared";
import type { TerminalOutputChunk } from "@vcpdeck/shared";

// ── fake PTY ──
let ptyCounter = 0;
class FakePty implements PtyAdapter {
	pid = 5000 + ptyCounter++;
	writes: string[] = [];
	resizes: Array<[number, number]> = [];
	killed = false;
	exited = false;
	private dataCbs: Array<(d: string) => void> = [];
	private exitCbs: Array<(code: number) => void> = [];
	write(d: string): void {
		this.writes.push(d);
	}
	resize(cols: number, rows: number): void {
		this.resizes.push([cols, rows]);
	}
	kill(): void {
		this.killed = true;
	}
	onData(cb: (d: string) => void): void {
		this.dataCbs.push(cb);
	}
	onExit(cb: (code: number) => void): void {
		this.exitCbs.push(cb);
	}
	emitData(d: string): void {
		for (const cb of this.dataCbs) cb(d);
	}
	emitExit(code: number): void {
		this.exited = true;
		for (const cb of this.exitCbs) cb(code);
	}
}

interface Harness {
	manager: ReturnType<typeof createTerminalManager>;
	spawned: FakePty[];
	outputs: TerminalOutputChunk[];
	ended: Array<{ sessionId: string; reason: string; exitCode?: number }>;
	killedTrees: number[];
}

function makeShells() {
	return [
		{ id: "pwsh", label: "pwsh", kind: "pwsh" as const, executable: "C:\\pwsh.exe", args: ["-NoLogo"], isDefault: true },
		{ id: "bash", label: "bash", kind: "bash" as const, executable: "/usr/bin/bash", args: [], isDefault: false },
	];
}

function makeHarness(overrides: Partial<TerminalManagerOptions> = {}): Harness {
	const spawned: FakePty[] = [];
	const outputs: TerminalOutputChunk[] = [];
	const ended: Array<{ sessionId: string; reason: string; exitCode?: number }> = [];
	const killedTrees: number[] = [];
	const manager = createTerminalManager({
		shells: makeShells(),
		cwd: "/home/dev",
		generationId: "g1",
		onOutput: (chunk) => outputs.push(chunk),
		onSessionEnded: (info) => ended.push(info),
		spawnPty: (opts) => {
			const pty = new FakePty();
			pty.resizes.push([opts.cols, opts.rows]);
			spawned.push(pty);
			return pty;
		},
		killTree: async (pid) => {
			killedTrees.push(pid);
		},
		...overrides,
	});
	return { manager, spawned, outputs, ended, killedTrees };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("create", () => {
	it("按 shellId 创建 PTY，携带固定 args/cwd/env，并设置初始尺寸", async () => {
		const h = makeHarness();
		const result = await h.manager.create({ shellId: "pwsh", cols: 120, rows: 30 });
		expect(result.sessionId).toBeTruthy();
		const pty = h.spawned[0];
		expect(pty).toBeTruthy();
		expect(pty.resizes[0]).toEqual([120, 30]);
	});

	it("拒绝未知 shellId（TERMINAL_SHELL_NOT_AVAILABLE）", async () => {
		const h = makeHarness();
		await expect(h.manager.create({ shellId: "fish", cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "TERMINAL_SHELL_NOT_AVAILABLE",
		});
	});

	it("spawn 失败映射为 TERMINAL_PTY_SPAWN_FAILED", async () => {
		const h = makeHarness({
			spawnPty: () => {
				throw new Error("spawn ENOENT");
			},
		});
		await expect(h.manager.create({ shellId: "bash", cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "TERMINAL_PTY_SPAWN_FAILED",
		});
	});

	it("第 6 个活跃会话被拒绝，终态后释放名额", async () => {
		const h = makeHarness();
		const ids: string[] = [];
		for (let i = 0; i < TerminalLimits.maxSessionsPerClient; i++) {
			const r = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
			ids.push(r.sessionId);
		}
		await expect(h.manager.create({ shellId: "bash", cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "TERMINAL_SESSION_LIMIT_REACHED",
		});
		// 终态（exit）释放名额
		h.spawned[0]?.emitExit(0);
		const r = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		expect(r.sessionId).toBeTruthy();
		expect(ids).toHaveLength(5);
	});
});

describe("input / resize", () => {
	it("input 原样写入 PTY；超限按 UTF-8 字节拒绝", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.input(sessionId, "ls -la\r");
		expect(h.spawned[0]?.writes).toEqual(["ls -la\r"]);
		await expect(
			h.manager.input(sessionId, "x".repeat(TerminalLimits.maxInputBytes + 1)),
		).rejects.toMatchObject({ code: "TERMINAL_INPUT_TOO_LARGE" });
	});

	it("resize 调用 PTY 并校验尺寸", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.resize(sessionId, 100, 40);
		expect(h.spawned[0]?.resizes).toContainEqual([100, 40]);
		await expect(h.manager.resize(sessionId, 5, 2)).rejects.toMatchObject({
			code: "TERMINAL_PROTOCOL_INVALID",
		});
	});

	it("未知 session 的 input/resize 返回 TERMINAL_SESSION_NOT_FOUND", async () => {
		const h = makeHarness();
		await expect(h.manager.input("nope", "x")).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
		await expect(h.manager.resize("nope", 80, 24)).rejects.toMatchObject({ code: "TERMINAL_SESSION_NOT_FOUND" });
	});
});

describe("输出 seq / 切分 / 批量", () => {
	it("输出产生严格单调 seq；小块按 flush 窗口合并", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		pty.emitData("a");
		pty.emitData("b");
		expect(h.outputs).toHaveLength(0); // 窗口未到
		await vi.advanceTimersByTimeAsync(20);
		expect(h.outputs).toHaveLength(1);
		expect(h.outputs[0]).toEqual({ sessionId, seq: 1, data: "ab" });
	});

	it("超过 64 KiB 的块被切分且 seq 递增", async () => {
		const h = makeHarness();
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const big = "x".repeat(TerminalLimits.maxOutputChunkBytes + 10);
		h.spawned[0]?.emitData(big);
		await vi.advanceTimersByTimeAsync(20);
		expect(h.outputs.length).toBeGreaterThanOrEqual(2);
		expect(h.outputs[0]?.seq).toBe(1);
		expect(h.outputs[1]?.seq).toBe(2);
		expect(h.outputs[0]?.data).toHaveLength(TerminalLimits.maxOutputChunkBytes);
	});

	it("空输出不产生 chunk", async () => {
		const h = makeHarness();
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		h.spawned[0]?.emitData("");
		await vi.advanceTimersByTimeAsync(20);
		expect(h.outputs).toHaveLength(0);
	});
});

describe("detach / attach / 30 分钟过期", () => {
	it("最后 detach 后 29:59 不关闭，30:00 自动过期并清理", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		await h.manager.detach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs - 1000);
		expect(pty.killed).toBe(false);
		await vi.advanceTimersByTimeAsync(2000);
		expect(pty.killed).toBe(true);
		expect(h.killedTrees).toContain(pty.pid);
		expect(h.ended).toContainEqual(expect.objectContaining({ sessionId, reason: "expired" }));
	});

	it("30 分钟内 reattach 取消过期计时", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		await h.manager.detach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs - 1000);
		await h.manager.attach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs);
		expect(pty.killed).toBe(false);
	});

	it("Server 断线：live 会话进入 detached 计时但不立即 kill，重连 attach 恢复", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		h.manager.handleServerDisconnect();
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs - 1000);
		expect(pty.killed).toBe(false);
		await h.manager.attach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs);
		expect(pty.killed).toBe(false);
	});
});

describe("终态竞态与幂等", () => {
	it("close 幂等：重复 close 只 settle 一次", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		await h.manager.close(sessionId, "closed");
		await h.manager.close(sessionId, "closed");
		expect(pty.killed).toBe(true);
		expect(h.ended.filter((e) => e.sessionId === sessionId)).toHaveLength(1);
		expect(h.ended[0]).toEqual({ sessionId, reason: "closed" });
	});

	it("exit 与 close 竞态：先到者胜，后到者忽略", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		pty.emitExit(0);
		await h.manager.close(sessionId, "closed");
		expect(h.ended).toEqual([{ sessionId, reason: "exited", exitCode: 0 }]);
	});

	it("expiry 与 close 竞态：只产生一个终态", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const pty = h.spawned[0]!;
		await h.manager.detach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs + 1000);
		await h.manager.close(sessionId, "closed");
		expect(h.ended.filter((e) => e.sessionId === sessionId)).toHaveLength(1);
		expect(h.ended[0]?.reason).toBe("expired");
	});

	it("过期后迟到输出不再产生 chunk", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.detach(sessionId);
		await vi.advanceTimersByTimeAsync(TerminalLimits.detachedTtlMs + 1000);
		const before = h.outputs.length;
		h.spawned[0]?.emitData("late");
		await vi.advanceTimersByTimeAsync(30);
		expect(h.outputs.length).toBe(before);
	});
});

describe("headless 快照集成", () => {
	it("output 同时写入快照器；getSnapshot 与 output seq 一致", async () => {
		const snapshots: string[] = [];
		let snapSeq = 0;
		const h = makeHarness({
			createSnapshotter: () => ({
				write: (data: string, cb?: () => void) => {
					snapshots.push(data);
					snapSeq += 1;
					cb?.();
				},
				resize: () => undefined,
				snapshot: async () => ({
					snapshot: snapshots.join(""),
					snapshotSeq: snapSeq,
					cols: 80,
					rows: 24,
					historyTruncated: false,
				}),
				dispose: () => undefined,
			}),
		});
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		h.spawned[0]?.emitData("hello");
		await vi.advanceTimersByTimeAsync(30);
		expect(snapshots).toEqual(["hello"]);
		expect(h.outputs[0]?.data).toBe("hello");
		const snap = await h.manager.getSnapshot(sessionId);
		expect(snap.snapshotSeq).toBe(1);
		expect(snap.snapshot).toBe("hello");
	});

	it("resize 同步到快照器", async () => {
		const resizes: Array<[number, number]> = [];
		const h = makeHarness({
			createSnapshotter: () => ({
				write: (_d: string, cb?: () => void) => cb?.(),
				resize: (c: number, r: number) => void resizes.push([c, r]),
				snapshot: async () => ({
					snapshot: "",
					snapshotSeq: 0,
					cols: 80,
					rows: 24,
					historyTruncated: false,
				}),
				dispose: () => undefined,
			}),
		});
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.resize(sessionId, 100, 40);
		expect(resizes).toContainEqual([100, 40]);
	});

	it("关闭后快照请求返回 TERMINAL_SESSION_NOT_FOUND", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		h.spawned[0]?.emitExit(0);
		await expect(h.manager.getSnapshot(sessionId)).rejects.toMatchObject({
			code: "TERMINAL_SESSION_NOT_FOUND",
		});
	});
});

describe("shutdown 与 state report", () => {
	it("shutdown 关闭所有活跃 PTY", async () => {
		const h = makeHarness();
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.shutdown();
		for (const pty of h.spawned) expect(pty.killed).toBe(true);
	});

	it("state report 携带 generationId 与 session 摘要，不含敏感字段", async () => {
		const h = makeHarness();
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		const report = h.manager.getStateReport();
		expect(report.generationId).toBe("g1");
		expect(report.sessions).toHaveLength(2);
		const json = JSON.stringify(report);
		expect(json).not.toContain("/home/dev");
		expect(json).not.toContain("cwd");
		expect(json).not.toContain("env");
		expect(report.sessions[0]?.status).toBe("active");
	});

	it("detach 后 state report 标记 detached 并带 expiresAt", async () => {
		const h = makeHarness();
		const { sessionId } = await h.manager.create({ shellId: "bash", cols: 80, rows: 24 });
		await h.manager.detach(sessionId);
		const report = h.manager.getStateReport();
		expect(report.sessions[0]?.status).toBe("detached");
		expect(report.sessions[0]?.detachedAt).toBeTruthy();
		expect(report.sessions[0]?.expiresAt).toBeTruthy();
	});
});
