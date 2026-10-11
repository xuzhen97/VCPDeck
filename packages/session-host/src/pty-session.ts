import type { SessionHostKind, SessionHostState } from "@vcpdeck/shared";

/** PTY 句柄抽象。刻意不含 pid：Windows ConPTY 下 pid 恒为 0，不能作为身份。 */
export interface PtyProcessHandle {
	onData(listener: (chunk: string) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
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
	spawn: (options: { kind: SessionHostKind; cwd: string; cols: number; rows: number }) => PtyProcessHandle;
	/**
	 * 出站回调。返回 false 表示消费者当前无法接收，宿主将入队并稍后 flush。
	 * 实现必须同步尝试写出，不得依靠 handle.pause()。
	 */
	emit: (frame: PtySessionFrame) => boolean;
}

export interface PtySession {
	readonly instanceId: string;
	readonly state: SessionHostState;
	readonly lastSeq: number;
	readonly pendingBytes: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	stop(): void;
}

const DEFAULT_MAX_BACKLOG_BYTES = 1024 * 1024;

interface QueuedFrame {
	frame: PtySessionFrame;
	bytes: number;
}

/**
 * 创建受管 PTY 实例。
 *
 * 三条硬规则：
 * 1. 输出持续排空，绝不调用 handle.pause()（Windows 下 pause 会导致子进程写失败并以 134 中止）；
 * 2. 身份只来自 instanceId，不读取也不上报 pid；
 * 3. 缓冲有上限，越界即 fail-closed 并终止子进程，而不是丢帧后继续假报健康。
 */
export function createPtySession(options: PtySessionOptions): PtySession {
	const maxBacklogBytes = options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES;
	let state: SessionHostState = "running";
	let seq = 0;
	const queue: QueuedFrame[] = [];
	let pendingBytes = 0;

	const handle = options.spawn({
		kind: options.kind,
		cwd: options.cwd,
		cols: options.cols ?? 80,
		rows: options.rows ?? 24,
	});

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

	handle.onData((chunk) => {
		if (state !== "running") return;
		seq += 1;
		deliver({ type: "output", instanceId: options.instanceId, seq, data: chunk });
	});

	handle.onExit((event) => {
		if (state === "running") {
			state = event.exitCode === 0 ? "stopped" : "failed";
		}
		options.emit({ type: "state", instanceId: options.instanceId, state, exitCode: event.exitCode });
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
		},
		stop() {
			if (state === "running") state = "stopped";
			handle.kill();
		},
	};
}
