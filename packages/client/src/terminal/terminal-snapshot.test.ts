import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { createSnapshotter, type SnapshotterEnv } from "./terminal-snapshot.js";

/** 真实 xterm headless 环境（单元测试使用真实实现，保证序列化语义可信）。 */
function realEnv(rows = 8, scrollback = 200): SnapshotterEnv {
	return {
		createTerminal: (opts) => {
			const t = new Terminal({
				cols: opts.cols,
				rows: opts.rows,
				scrollback: opts.scrollback,
				allowProposedApi: true,
			});
			const serialize = new SerializeAddon();
			t.loadAddon(serialize);
			return {
				write: (data: string, cb?: () => void) => {
					if (cb) t.write(data, cb);
					else t.write(data);
				},
				resize: (cols, rows) => t.resize(cols, rows),
				serialize: () => serialize.serialize(),
				dispose: () => t.dispose(),
			};
		},
		maxSnapshotBytes: 8 * 1024 * 1024,
		scrollback,
	};
}

/** 将 data 写入快照器并等待写入回调完成。 */
function writeAndWait(snap: ReturnType<typeof createSnapshotter>, data: string): Promise<void> {
	return new Promise((resolve) => {
		snap.write(data, () => resolve());
	});
}

describe("createSnapshotter", () => {
	it("写入 A(seq1) 后 snapshot 包含 A 且 snapshotSeq=1", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "A");
		const result = await snap.snapshot();
		expect(result.snapshotSeq).toBe(1);
		expect(result.snapshot).toContain("A");
		expect(result.historyTruncated).toBe(false);
	});

	it("snapshot 与并发写入原子一致：快照在队列中串行，seq 与画面同步", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "A");
		// 并发：先发起写入 B（未完成），再取 snapshot → B 先落盘，快照含 B/seq2
		const pending = writeAndWait(snap, "B");
		const result = await snap.snapshot();
		await pending;
		expect(result.snapshotSeq).toBe(2);
		expect(result.snapshot).toContain("B");
	});

	it("snapshot 与后续写入的 seq 单调衔接", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "A");
		const first = await snap.snapshot();
		await writeAndWait(snap, "B");
		const second = await snap.snapshot();
		expect(first.snapshotSeq).toBe(1);
		expect(second.snapshotSeq).toBe(2);
	});

	it("resize 后 snapshot 行列一致", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "hello");
		snap.resize(20, 5);
		const result = await snap.snapshot();
		expect(result.cols).toBe(20);
		expect(result.rows).toBe(5);
	});

	it("ANSI 颜色/清屏/中文可序列化并可在新 Terminal 恢复", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "\x1b[31mHello 中文\x1b[0m\r\nline2");
		const result = await snap.snapshot();
		expect(result.snapshot).toContain("\x1b[");
		const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
		await new Promise<void>((resolve) => restored.write(result.snapshot, () => resolve()));
		const line0 = restored.buffer.active.getLine(0)?.translateToString(true) ?? "";
		const line1 = restored.buffer.active.getLine(1)?.translateToString(true) ?? "";
		expect(line0).toBe("Hello 中文");
		expect(line1).toBe("line2");
		restored.dispose();
	});

	it("alternate screen 可序列化恢复", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "\x1b[?1049h");
		await writeAndWait(snap, "alt content");
		const result = await snap.snapshot();
		expect(result.snapshot).toContain("alt");
		const restored = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
		await new Promise<void>((resolve) => restored.write(result.snapshot, () => resolve()));
		const line0 = restored.buffer.active.getLine(0)?.translateToString(true) ?? "";
		expect(line0).toContain("alt");
		restored.dispose();
	});

	it("scrollback 上限生效（超出行不导致崩溃）", async () => {
		const snap = createSnapshotter(realEnv(8, 5), { cols: 20, rows: 8 });
		for (let i = 0; i < 20; i++) {
			await writeAndWait(snap, `line${i}\r\n`);
		}
		const result = await snap.snapshot();
		expect(result.snapshot.length).toBeGreaterThan(0);
		expect(result.historyTruncated).toBe(false);
	});

	it("超限 snapshot 返回有界结果与 historyTruncated", async () => {
		const env = realEnv();
		env.maxSnapshotBytes = 100;
		const snap = createSnapshotter(env, { cols: 40, rows: 8 });
		await writeAndWait(snap, "x".repeat(500));
		const result = await snap.snapshot();
		expect(result.snapshot.length).toBeLessThanOrEqual(100);
		expect(result.historyTruncated).toBe(true);
		expect(result.snapshotSeq).toBe(1);
	});

	it("serialize 抛错时 snapshot reject 且 code=TERMINAL_SNAPSHOT_FAILED", async () => {
		const env = realEnv();
		const orig = env.createTerminal;
		env.createTerminal = (opts) => {
			const t = orig(opts);
			return {
				...t,
				serialize: () => {
					throw new Error("serialize boom");
				},
			};
		};
		const snap = createSnapshotter(env, { cols: 40, rows: 8 });
		await writeAndWait(snap, "x");
		await expect(snap.snapshot()).rejects.toMatchObject({ code: "TERMINAL_SNAPSHOT_FAILED" });
	});

	it("dispose 后 write/snapshot 拒绝", async () => {
		const snap = createSnapshotter(realEnv(), { cols: 40, rows: 8 });
		await writeAndWait(snap, "x");
		snap.dispose();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await expect(snap.snapshot()).rejects.toMatchObject({ code: "TERMINAL_SNAPSHOT_FAILED" });
	});
});
