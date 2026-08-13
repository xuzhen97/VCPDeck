import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import type { TerminalClientRequest, TerminalClientResponse, TerminalStateAck } from "@vcpdeck/shared";
import { attachTerminalBridge, wireManagerToSocket } from "./protocol-bridge.js";
import { createTerminalManager, type PtyAdapter } from "./terminal-manager.js";

class FakePty implements PtyAdapter {
	pid = 6000 + counter++;
	writes: string[] = [];
	resized: Array<[number, number]> = [];
	killed = false;
	private dataCbs: Array<(d: string) => void> = [];
	private exitCbs: Array<(code: number) => void> = [];
	write(d: string): void {
		this.writes.push(d);
	}
	resize(c: number, r: number): void {
		this.resized.push([c, r]);
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
		for (const cb of this.exitCbs) cb(code);
	}
}
let counter = 0;

function fakeSocket() {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const emitCalls: Array<{ event: string; args: unknown[] }> = [];
	const responseResolvers: Array<(r: TerminalClientResponse | undefined) => void> = [];
	const socket = {
		connected: true,
		on: (event: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(cb);
			listeners.set(event, list);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emitCalls.push({ event, args });
			if (event === Events.TERMINAL_RESPONSE) {
				const resolvers = responseResolvers.splice(0);
				for (const resolve of resolvers) resolve(args[0] as TerminalClientResponse | undefined);
			}
			return socket;
		},
	} as unknown as Socket;
	return { socket, emitCalls, listeners, responseResolvers };
}

interface Harness {
	manager: ReturnType<typeof createTerminalManager>;
	spawned: FakePty[];
	socket: Socket;
	emitCalls: Array<{ event: string; args: unknown[] }>;
	listeners: Map<string, Array<(...args: unknown[]) => void>>;
	request: (req: TerminalClientRequest) => Promise<TerminalClientResponse | undefined>;
	registered: () => void;
}

function makeHarness(): Harness {
	const spawned: FakePty[] = [];
	const { socket, emitCalls, listeners, responseResolvers } = fakeSocket();
	const manager = createTerminalManager({
		shells: [
			{
				id: "bash",
				label: "bash",
				kind: "bash",
				executable: "/usr/bin/bash",
				args: [],
				isDefault: true,
			},
		],
		cwd: "/home/dev",
		generationId: "gen-1",
		onOutput: () => undefined,
		onSessionEnded: () => undefined,
		spawnPty: (opts) => {
			const pty = new FakePty();
			pty.resized.push([opts.cols, opts.rows]);
			spawned.push(pty);
			return pty;
		},
		killTree: async () => undefined,
	});
	attachTerminalBridge(socket, { clientId: "c1", manager });
	wireManagerToSocket(socket, manager);
	const request = (req: TerminalClientRequest) =>
		new Promise<TerminalClientResponse | undefined>((resolve) => {
			responseResolvers.push(resolve);
			for (const cb of listeners.get(Events.TERMINAL_REQUEST) ?? []) {
				(cb as (...args: unknown[]) => void)(req);
			}
		});
	const registered = () => {
		for (const cb of listeners.get("ack") ?? []) {
			(cb as (data: { event?: string }) => void)({ event: Events.REGISTER });
		}
	};
	return { manager, spawned, socket, emitCalls, listeners, request, registered };
}

function emitted(h: Harness, event: string): unknown[] {
	return h.emitCalls.filter((c) => c.event === event).map((c) => c.args[0]);
}

beforeEach(() => {
	vi.useFakeTimers();
	counter = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("terminal request/response", () => {
	it("非法请求返回 TERMINAL_PROTOCOL_INVALID 且不触碰 Manager", async () => {
		const h = makeHarness();
		const resp = await h.request({ requestId: "r1", action: "session.hack" } as unknown as TerminalClientRequest);
		expect(resp).toBeDefined();
		if (resp?.ok) throw new Error("expected error");
		expect(resp?.error.code).toBe("TERMINAL_PROTOCOL_INVALID");
		expect(h.spawned).toHaveLength(0);
	});

	it("shells.list 返回安全 DTO", async () => {
		const h = makeHarness();
		const resp = await h.request({ requestId: "r1", action: "shells.list" });
		if (!resp || !resp.ok) throw new Error("expected ok");
		if (resp.action !== "shells.list") throw new Error("narrow");
		expect(resp.shells[0]).toEqual({ id: "bash", label: "bash", kind: "bash", isDefault: true });
		expect(JSON.stringify(resp)).not.toContain("/usr/bin/bash");
	});

	it("create → input → resize → snapshot → close 完整链路", async () => {
		const h = makeHarness();
		const created = await h.request({
			requestId: "r1",
			action: "session.create",
			sessionId: "s1",
			shellId: "bash",
			cols: 80,
			rows: 24,
		});
		expect(created?.ok).toBe(true);
		expect(h.spawned).toHaveLength(1);

		await h.request({ requestId: "r2", action: "session.input", sessionId: "s1", data: "ls\r" });
		expect(h.spawned[0]?.writes).toEqual(["ls\r"]);

		await h.request({ requestId: "r3", action: "session.resize", sessionId: "s1", cols: 100, rows: 40 });
		expect(h.spawned[0]?.resized).toContainEqual([100, 40]);

		// 输出：快照 + 输出事件
		h.spawned[0]?.emitData("hello");
		await vi.advanceTimersByTimeAsync(30);
		expect(emitted(h, Events.TERMINAL_OUTPUT)).toHaveLength(1);

		const snap = await h.request({ requestId: "r4", action: "session.snapshot", sessionId: "s1" });
		expect(snap?.ok).toBe(true);
		if (!snap?.ok) throw new Error("expected ok");
		if (snap.action !== "session.snapshot") throw new Error("narrow");
		expect(snap.snapshotSeq).toBe(1);
		expect(snap.snapshot).toContain("hello");

		const closed = await h.request({ requestId: "r5", action: "session.close", sessionId: "s1", reason: "closed" });
		expect(closed?.ok).toBe(true);
		expect(h.spawned[0]?.killed).toBe(true);
	});

	it("shell 不存在时 create 返回 TERMINAL_SHELL_NOT_AVAILABLE", async () => {
		const h = makeHarness();
		const resp = await h.request({
			requestId: "r1",
			action: "session.create",
			sessionId: "s1",
			shellId: "fish",
			cols: 80,
			rows: 24,
		});
		expect(resp?.ok).toBe(false);
		if (resp?.ok || !resp) throw new Error("expected error");
		expect(resp.error.code).toBe("TERMINAL_SHELL_NOT_AVAILABLE");
	});

	it("manager 抛出的未知错误映射为安全错误", async () => {
		const h = makeHarness();
		const resp = await h.request({ requestId: "r1", action: "session.input", sessionId: "nope", data: "x" });
		expect(resp?.ok).toBe(false);
		if (resp?.ok || !resp) throw new Error("expected error");
		expect(resp.error.code).toBe("TERMINAL_SESSION_NOT_FOUND");
		expect(resp.error.message).not.toContain("/home/dev");
	});
});

describe("输出与退出事件", () => {
	it("PTY 输出经 flush 窗口发送 TERMINAL_OUTPUT", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		h.spawned[0]?.emitData("ab");
		await vi.advanceTimersByTimeAsync(30);
		const outputs = emitted(h, Events.TERMINAL_OUTPUT) as Array<{ sessionId: string; seq: number; data: string }>;
		expect(outputs).toEqual([{ sessionId: "s1", seq: 1, data: "ab" }]);
	});

	it("Shell 自行退出发送 TERMINAL_EXIT", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		h.spawned[0]?.emitExit(0);
		const exits = emitted(h, Events.TERMINAL_EXIT) as Array<{ sessionId: string; exitCode: number }>;
		expect(exits).toEqual([{ sessionId: "s1", exitCode: 0 }]);
	});

	it("关闭后输出不再发送", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		await h.request({ requestId: "r2", action: "session.close", sessionId: "s1", reason: "closed" });
		h.spawned[0]?.emitData("late");
		await vi.advanceTimersByTimeAsync(30);
		expect(emitted(h, Events.TERMINAL_OUTPUT)).toHaveLength(0);
	});
});

describe("状态对账", () => {
	it("REGISTER ack 后发送 TERMINAL_STATE 且带 generationId", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		h.registered();
		const states = emitted(h, Events.TERMINAL_STATE) as Array<{ clientId: string; generationId: string; sessions: unknown[] }>;
		expect(states).toHaveLength(1);
		expect(states[0].generationId).toBe("gen-1");
		expect(states[0].clientId).toBe("c1");
		expect(states[0].sessions).toHaveLength(1);
		expect(JSON.stringify(states[0])).not.toContain("/home/dev");
		expect(JSON.stringify(states[0])).not.toContain("env");
	});

	it("state ack 的 closeSessionIds 关闭孤儿 PTY", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		h.registered();
		const stateCall = h.emitCalls.find((c) => c.event === Events.TERMINAL_STATE);
		expect(stateCall).toBeTruthy();
		const ackCb = stateCall?.args[1] as (ack: TerminalStateAck) => void;
		ackCb({ acceptedSessionIds: [], closeSessionIds: ["s1"] });
		await vi.advanceTimersByTimeAsync(10);
		expect(h.spawned[0]?.killed).toBe(true);
	});

	it("非法 state ack 被忽略", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		h.registered();
		const stateCall = h.emitCalls.find((c) => c.event === Events.TERMINAL_STATE);
		const ackCb = stateCall?.args[1] as (ack: unknown) => void;
		ackCb({ acceptedSessionIds: [7], closeSessionIds: [] }); // 非法 → 忽略
		await vi.advanceTimersByTimeAsync(10);
		expect(h.spawned[0]?.killed).toBe(false);
	});
});

describe("断线处理", () => {
	it("socket 断线调用 handleServerDisconnect 且不 kill PTY", async () => {
		const h = makeHarness();
		await h.request({ requestId: "r", action: "session.create", sessionId: "s1", shellId: "bash", cols: 80, rows: 24 });
		for (const cb of h.listeners.get("disconnect") ?? []) {
			(cb as (reason: string) => void)("transport close");
		}
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.spawned[0]?.killed).toBe(false);
		// 30 分钟到期后才清理
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(h.spawned[0]?.killed).toBe(true);
	});
});
