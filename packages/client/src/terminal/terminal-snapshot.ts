import { utf8ByteLength } from "@vcpdeck/shared";

/** 快照终端的最小接口（生产用 @xterm/headless，测试可注入）。 */
export interface SnapshotTerminal {
	write(data: string, cb?: () => void): void;
	resize(cols: number, rows: number): void;
	serialize(): string;
	dispose(): void;
}

/** 快照器环境抽象（生产/测试注入）。 */
export interface SnapshotterEnv {
	createTerminal(opts: { cols: number; rows: number; scrollback: number }): SnapshotTerminal;
	maxSnapshotBytes: number;
	scrollback: number;
}

/** 快照结果（snapshot 为 ANSI 序列，可写入浏览器 xterm 恢复画面）。 */
export interface TerminalSnapshotResult {
	snapshot: string;
	snapshotSeq: number;
	cols: number;
	rows: number;
	historyTruncated: boolean;
}

/**
 * 每会话 headless 终端快照器。
 * - 所有 write/resize/snapshot 经单一串行队列处理，保证 snapshotSeq 与画面内容原子一致；
 * - snapshot 编码超过上限时回退为有界原始输出并标记 historyTruncated；
 * - 不持久化快照内容。
 */
export function createSnapshotter(env: SnapshotterEnv, opts: { cols: number; rows: number }) {
	let seq = 0;
	let cols = opts.cols;
	let rows = opts.rows;
	let raw = "";
	let terminal: SnapshotTerminal | null = env.createTerminal({
		cols,
		rows,
		scrollback: env.scrollback,
	});
	let disposed = false;
	let queue: Promise<void> = Promise.resolve();

	function enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = queue.then(task);
		queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	function snapshotError(message: string): Error {
		return Object.assign(new Error(message), { code: "TERMINAL_SNAPSHOT_FAILED" });
	}

	function assertAlive(): void {
		if (disposed || !terminal) throw snapshotError("Snapshotter is disposed");
	}

	return {
		/** 写入输出（headless 处理完成后推进 seq）。 */
		write(data: string, cb?: () => void): void {
			void enqueue(async () => {
				assertAlive();
				await new Promise<void>((resolve) => {
					terminal!.write(data, () => resolve());
				});
				raw += data;
				if (utf8ByteLength(raw) > env.maxSnapshotBytes) {
					raw = raw.slice(raw.length - env.maxSnapshotBytes);
				}
				seq += 1;
				cb?.();
			});
		},

		/** 同步调整 headless 终端尺寸。 */
		resize(newCols: number, newRows: number): void {
			void enqueue(async () => {
				assertAlive();
				terminal!.resize(newCols, newRows);
				cols = newCols;
				rows = newRows;
			});
		},

		/** 生成快照（串行队列内执行，保证与 seq 一致）。 */
		async snapshot(): Promise<TerminalSnapshotResult> {
			return enqueue(async () => {
				assertAlive();
				let serialized: string;
				try {
					serialized = terminal!.serialize();
				} catch {
					throw snapshotError("Terminal snapshot serialization failed");
				}
				if (utf8ByteLength(serialized) <= env.maxSnapshotBytes) {
					return { snapshot: serialized, snapshotSeq: seq, cols, rows, historyTruncated: false };
				}
				return {
					snapshot: raw.slice(-env.maxSnapshotBytes),
					snapshotSeq: seq,
					cols,
					rows,
					historyTruncated: true,
				};
			});
		},

		/** 释放资源（串行队列内执行）。 */
		dispose(): void {
			void enqueue(async () => {
				terminal?.dispose();
				terminal = null;
				disposed = true;
			});
		},
	};
}
