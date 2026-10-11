import { describe, expect, it } from "vitest";
import {
	type PtyProcessHandle,
	type PtyScreen,
	type PtySessionFrame,
	SnapshotTooLargeError,
	createPtySession,
} from "./pty-session.js";

/** 假 PTY：记录 pause 调用次数；显式提供 pause，使任何调用都可被断言抓住。 */
function fakeHandle(options: { autoExitOnKill?: boolean; exitCode?: number } = {}) {
	const dataListener = { current: undefined as ((c: string) => void) | undefined };
	const exitListener = { current: undefined as ((e: { exitCode: number; signal?: number }) => void) | undefined };
	const counters = { pauseCalls: 0, killed: 0, written: [] as string[] };
	const handle = {
		onData(listener: (c: string) => void) {
			dataListener.current = listener;
		},
		onExit(listener: (e: { exitCode: number; signal?: number }) => void) {
			exitListener.current = listener;
		},
		write(data: string) {
			counters.written.push(data);
		},
		resize() {},
		kill() {
			counters.killed += 1;
			if (options.autoExitOnKill) exitListener.current?.({ exitCode: options.exitCode ?? 0 });
		},
		pause() {
			counters.pauseCalls += 1;
		},
		fire(chunk: string) {
			dataListener.current?.(chunk);
		},
		exit(code: number) {
			exitListener.current?.({ exitCode: code });
		},
		get pauseCalls() {
			return counters.pauseCalls;
		},
		get killed() {
			return counters.killed;
		},
		get written() {
			return counters.written;
		},
	} satisfies PtyProcessHandle & Record<string, unknown>;
	return handle as typeof handle & PtyProcessHandle;
}

/** 假画面：可指定写回调是否异步完成，用于验证快照会等待画面排空。 */
function fakeScreen(options: { async?: boolean } = {}) {
	let cols = 80;
	let rows = 24;
	const chunks: string[] = [];
	const screen = {
		get cols() {
			return cols;
		},
		get rows() {
			return rows;
		},
		write(data: string, done?: () => void) {
			chunks.push(data);
			if (options.async) queueMicrotask(() => done?.());
			else done?.();
		},
		resize(c: number, r: number) {
			cols = c;
			rows = r;
		},
		serialize() {
			return chunks.join("");
		},
		dispose() {},
	};
	return { screen: screen as PtyScreen, chunks };
}

function build(
	overrides: {
		busy?: () => boolean;
		maxBacklogBytes?: number;
		maxSnapshotBytes?: number;
		exitGraceMs?: number;
		autoExitOnKill?: boolean;
		asyncScreen?: boolean;
	} = {},
) {
	const handle = fakeHandle({ autoExitOnKill: overrides.autoExitOnKill });
	const { screen, chunks } = fakeScreen({ async: overrides.asyncScreen });
	/** attempts：宿主尝试发出的全部帧（含被消费者拒收的）。 */
	const attempts: PtySessionFrame[] = [];
	/** accepted：消费者真正接收的帧。 */
	const accepted: PtySessionFrame[] = [];
	const session = createPtySession({
		instanceId: "inst_1",
		kind: "pi",
		cwd: "/w",
		maxBacklogBytes: overrides.maxBacklogBytes,
		maxSnapshotBytes: overrides.maxSnapshotBytes,
		exitGraceMs: overrides.exitGraceMs,
		spawn: () => handle,
		screen,
		emit: (frame) => {
			attempts.push(frame);
			const busy = overrides.busy?.() ?? false;
			if (!busy) accepted.push(frame);
			return !busy;
		},
	});
	return { handle, screen, chunks, attempts, accepted, session };
}

describe("受管 PTY 实例", () => {
	it("身份来自 instanceId，不读取 pid", () => {
		const { session } = build();
		expect(session.instanceId).toBe("inst_1");
		// Windows ConPTY 下 pid 恒为 0，因此身份绝不能来自 pid。
		expect(session).not.toHaveProperty("pid");
	});

	it("输出 seq 严格递增且持续排空", () => {
		const { handle, accepted, session } = build();
		handle.fire("a");
		handle.fire("bb");
		handle.fire("ccc");
		expect(accepted.map((f) => (f.type === "output" ? f.seq : -1))).toEqual([1, 2, 3]);
		expect(session.lastSeq).toBe(3);
		expect(session.pendingBytes).toBe(0);
	});

	it("绝不调用 pause —— 这是设计违规而非优化项", () => {
		const { handle } = build();
		handle.fire("x".repeat(5000));
		handle.fire("x".repeat(5000));
		expect(handle.pauseCalls).toBe(0);
	});

	it("消费者繁忙时入队，不丢帧且恢复后按序补发", () => {
		let busy = true;
		const { handle, accepted } = build({ busy: () => busy });
		handle.fire("one");
		handle.fire("two");
		expect(accepted).toHaveLength(0);
		busy = false;
		handle.fire("three");
		// 恢复后先发当前帧，再补发已排队帧，且不丢任何一帧。
		expect(accepted).toHaveLength(3);
		expect(accepted.map((f) => (f.type === "output" ? f.data : ""))).toEqual(["three", "one", "two"]);
	});

	it("缓冲越界 fail-closed：报错、置 failed、终止子进程，不静默截断", () => {
		const { handle, attempts, session } = build({ maxBacklogBytes: 8, busy: () => true });
		handle.fire("1234567890");
		expect(session.state).toBe("failed");
		expect(handle.killed).toBe(1);
		const errored = attempts.find((f) => f.type === "error");
		expect(errored?.type === "error" && errored.code).toBe("SESSION_HOST_OUTPUT_BACKLOG_EXCEEDED");
	});

	it("fail-closed 的终态错误不因消费者繁忙而丢弃", () => {
		const { handle, attempts } = build({ maxBacklogBytes: 4, busy: () => true });
		handle.fire("12345");
		expect(attempts.some((f) => f.type === "error")).toBe(true);
	});

	it("fail-closed 后不再接收输出，也不接受写入", () => {
		const { handle, session } = build({ maxBacklogBytes: 4, busy: () => true });
		handle.fire("12345");
		expect(session.lastSeq).toBe(1);
		handle.fire("more");
		session.write("input");
		expect(session.lastSeq).toBe(1);
		expect(handle.written).toEqual([]);
	});

	it("正常退出记为 stopped，非零退出记为 failed", () => {
		const ok = build();
		ok.handle.exit(0);
		expect(ok.session.state).toBe("stopped");

		const bad = build();
		bad.handle.exit(1);
		expect(bad.session.state).toBe("failed");
	});
});

describe("受管 PTY 实例：画面", () => {
	it("输出按序喂给画面", () => {
		const { handle, chunks } = build();
		handle.fire("one");
		handle.fire("two");
		expect(chunks).toEqual(["one", "two"]);
	});

	it("快照返回 seq、画面正文与尺寸", async () => {
		const { handle, session } = build();
		handle.fire("hello ");
		handle.fire("world");
		const snapshot = await session.snapshot();
		expect(snapshot.snapshot).toBe("hello world");
		expect(snapshot.seq).toBe(2);
		expect(snapshot.cols).toBe(80);
		expect(snapshot.rows).toBe(24);
	});

	it("快照等待尚未完成的画面写入", async () => {
		const { handle, session } = build({ asyncScreen: true });
		handle.fire("deferred");
		const snapshot = await session.snapshot();
		expect(snapshot.snapshot).toBe("deferred");
	});

	it("resize 同步画面尺寸", async () => {
		const { session } = build();
		session.resize(120, 30);
		const snapshot = await session.snapshot();
		expect(snapshot.cols).toBe(120);
		expect(snapshot.rows).toBe(30);
	});

	it("快照超过上限时明确失败，不截断后假装完整", async () => {
		const { handle, session } = build({ maxSnapshotBytes: 4 });
		handle.fire("12345");
		await expect(session.snapshot()).rejects.toBeInstanceOf(SnapshotTooLargeError);
	});
});

describe("受管 PTY 实例：停止确认", () => {
	it("确认退出后才报告 exited: true", async () => {
		const { handle, session } = build({ autoExitOnKill: true });
		const result = await session.stop();
		expect(result).toEqual({ exited: true });
		expect(handle.killed).toBe(1);
		expect(session.state).toBe("stopped");
	});

	it("已退出的实例再次 stop 立即返回确认结果", async () => {
		const { session } = build({ autoExitOnKill: true });
		await session.stop();
		const again = await session.stop();
		expect(again).toEqual({ exited: true });
	});

	it("自然退出后 stop 不再重复终止，直接确认已退出", async () => {
		const { handle, session } = build({ exitGraceMs: 10 });
		handle.exit(0);
		const result = await session.stop();
		expect(result).toEqual({ exited: true });
		expect(handle.killed).toBe(0);
	});

	it("未在宽限期内退出时报告 exited: false，且不伪装成已停止", async () => {
		const { session } = build({ exitGraceMs: 10 });
		const result = await session.stop();
		expect(result).toEqual({ exited: false });
		// 未确认退出就不得把状态改成已停止。
		expect(session.state).toBe("running");
	});

	it("显式停止后收到非零退出仍记为 stopped，不误报为失败", async () => {
		const { handle, session } = build({ exitGraceMs: 10 });
		await session.stop();
		handle.exit(1);
		expect(session.state).toBe("stopped");
	});
});
