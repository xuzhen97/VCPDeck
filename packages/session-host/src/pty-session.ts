import type { SessionHostKind, SessionHostState } from "@vcpdeck/shared";

/** PTY 句柄抽象。刻意不含 pid：Windows ConPTY 下 pid 恒为 0，不能作为身份。 */
export interface PtyProcessHandle {
	onData(listener: (chunk: string) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

/**
 * 面向 Agent 的画面表面。
 *
 * Agent 看到的是屏幕，不是原始字节回放，因此快照必须来自真实终端模拟器，
 * 而不是把历史 chunk 拼起来。
 */
export interface PtyScreen {
	write(data: string, done?: () => void): void;
	resize(cols: number, rows: number): void;
	serialize(): string;
	dispose(): void;
	readonly cols: number;
	readonly rows: number;
}

/** 快照超过上限。必须如实失败：截断后的画面会骗过读取者。 */
export class SnapshotTooLargeError extends Error {
	readonly code = "SESSION_HOST_SNAPSHOT_TOO_LARGE" as const;
	constructor(message = "画面快照超过上限") {
		super(message);
		this.name = "SnapshotTooLargeError";
	}
}

/** 出站帧。真实符号只在 reason 里体现，不携带 PID 或正文之外的元数据。 */
export type PtySessionFrame =
	| { type: "output"; instanceId: string; seq: number; data: string }
	| { type: "state"; instanceId: string; state: SessionHostState; exitCode?: number }
	| {
			type: "error";
			instanceId: string;
			code: "SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED";
			message: string;
			reason: "interrupted-by-client-update" | "output-backlog-exceeded" | "exit";
	  };

export interface PtySessionOptions {
	/** 宿主生成的实例身份，绝不使用 pid。 */
	instanceId: string;
	kind: SessionHostKind;
	cwd: string;
	cols?: number;
	rows?: number;
	/** 缓冲字节上限；越界 fail-closed，不丢帧、不静默截断。 */
	maxBacklogBytes?: number;
	/** 画面快照字节上限；越界明确失败。 */
	maxSnapshotBytes?: number;
	/** 停止确认宽限期；超时如实返回 exited: false。 */
	exitGraceMs?: number;
	spawn: (options: { kind: SessionHostKind; cwd: string; cols: number; rows: number }) => PtyProcessHandle;
	/** 画面表面。生产必须注入真实终端模拟器，测试注入假实现。 */
	screen: PtyScreen;
	/**
	 * 出站回调。返回 false 表示消费者当前无法接收，宿主将入队并稍后 flush。
	 * 实现必须同步尝试写出，不得依靠 handle.pause()。
	 */
	emit: (frame: PtySessionFrame) => boolean;
}

export interface PtySessionSnapshot {
	seq: number;
	snapshot: string;
	cols: number;
	rows: number;
}

export interface PtySession {
	readonly instanceId: string;
	readonly state: SessionHostState;
	readonly lastSeq: number;
	readonly pendingBytes: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	snapshot(): Promise<PtySessionSnapshot>;
	/** 终止并等待确认；宽限期内未确认退出时返回 exited: false。 */
	stop(): Promise<{ exited: boolean }>;
}

const DEFAULT_MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXIT_GRACE_MS = 5000;

interface QueuedFrame {
	frame: PtySessionFrame;
	bytes: number;
}

/**
 * 创建受管 PTY 实例。
 *
 * 四条硬规则：
 * 1. 输出持续排空，绝不调用 handle.pause()（Windows 下 pause 会导致子进程写失败并以 134 中止）；
 * 2. 身份只来自 instanceId，不读取也不上报 pid；
 * 3. 缓冲有上限，越界即 fail-closed 并终止子进程，而不是丢帧后继续假报健康；
 * 4. 停止只在确认退出后报告成功，宽限期超时如实返回 false。
 */
export function createPtySession(options: PtySessionOptions): PtySession {
	const maxBacklogBytes = options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES;
	const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
	const exitGraceMs = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
	let state: SessionHostState = "running";
	let seq = 0;
	let exited = false;
	/** 是否已由操作者要求停止；决定非零退出算「失败」还是「已停止」。 */
	let stopRequested = false;
	const queue: QueuedFrame[] = [];
	let pendingBytes = 0;
	/** 画面写入计数：快照必须等到此前所有写入完成，否则会截到半帧。 */
	let pendingScreen = 0;
	let screenIdle: Promise<void> = Promise.resolve();
	let resolveScreenIdle: (() => void) | null = null;
	const exitWaiters: Array<() => void> = [];

	const handle = options.spawn({
		kind: options.kind,
		cwd: options.cwd,
		cols: options.cols ?? 80,
		rows: options.rows ?? 24,
	});
	const screen = options.screen;

	function frameBytes(frame: PtySessionFrame): number {
		return frame.type === "output" ? Buffer.byteLength(frame.data, "utf8") : 0;
	}

	function flush(): void {
		while (queue.length > 0) {
			const head = queue[0];
			if (head === undefined) return;
			if (!options.emit(head.frame)) return;
			queue.shift();
			pendingBytes -= head.bytes;
		}
	}

	function deliver(frame: PtySessionFrame): void {
		if (options.emit(frame)) {
			flush();
			return;
		}
		queue.push({ frame, bytes: frameBytes(frame) });
		pendingBytes += frameBytes(frame);
		if (pendingBytes > maxBacklogBytes) failClosed("output-backlog-exceeded");
	}

	function failClosed(reason: "output-backlog-exceeded" | "interrupted-by-client-update"): void {
		if (state !== "running") return;
		state = "failed";
		handle.kill();
		// 经 deliver 而非直接 emit：终态错误不得因消费者繁忙而被丢弃。
		// 此时 state 已非 running，重入的越界检查会直接返回，不会递归。
		deliver({
			type: "error",
			instanceId: options.instanceId,
			code: "SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED",
			message: `会话宿主 ${reason === "output-backlog-exceeded" ? "输出缓冲越界" : "因 Client 更新中断"}`,
			reason,
		});
	}

	function feedScreen(chunk: string): void {
		// 同步投递（顺序由终端模拟器内部队列保证），只用计数等待排空。
		if (pendingScreen === 0) {
			screenIdle = new Promise<void>((resolve) => {
				resolveScreenIdle = resolve;
			});
		}
		pendingScreen += 1;
		const done = (): void => {
			pendingScreen -= 1;
			if (pendingScreen === 0 && resolveScreenIdle) {
				resolveScreenIdle();
				resolveScreenIdle = null;
			}
		};
		try {
			screen.write(chunk, done);
		} catch {
			// 画面写入失败不能反过来杀死工作进程，但也不能让快照永远挂住。
			done();
		}
	}

	handle.onData((chunk) => {
		// 画面先于出站帧入队：即使消费者拒收，屏幕仍然连续。
		feedScreen(chunk);
		if (state !== "running") return;
		seq += 1;
		deliver({ type: "output", instanceId: options.instanceId, seq, data: chunk });
	});

	handle.onExit((event) => {
		exited = true;
		if (state === "running") {
			// 操作者要求停止时，非零退出不是失败；未要求停止的非零退出才是失败。
			state = stopRequested || event.exitCode === 0 ? "stopped" : "failed";
		}
		options.emit({ type: "state", instanceId: options.instanceId, state, exitCode: event.exitCode });
		for (const waiter of exitWaiters.splice(0)) waiter();
	});

	return {
		get instanceId() {
			return options.instanceId;
		},
		get state() {
			return state;
		},
		get lastSeq() {
			return seq;
		},
		get pendingBytes() {
			return pendingBytes;
		},
		write(data: string) {
			if (state !== "running") return;
			handle.write(data);
		},
		resize(cols: number, rows: number) {
			if (state !== "running") return;
			handle.resize(cols, rows);
			screen.resize(cols, rows);
		},
		async snapshot() {
			await screenIdle;
			const snapshot = screen.serialize();
			if (Buffer.byteLength(snapshot, "utf8") > maxSnapshotBytes) {
				throw new SnapshotTooLargeError();
			}
			return { seq, snapshot, cols: screen.cols, rows: screen.rows };
		},
		stop() {
			if (exited) return Promise.resolve({ exited: true });
			stopRequested = true;
			handle.kill();
			return new Promise<{ exited: boolean }>((resolve) => {
				if (exited) {
					resolve({ exited: true });
					return;
				}
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					// 未确认退出就报 exited: true 等于伪装成功，因此只报 false。
					resolve({ exited: false });
				}, exitGraceMs);
				exitWaiters.push(() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ exited: true });
				});
			});
		},
	};
}
