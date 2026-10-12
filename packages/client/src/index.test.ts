import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, type StatusReport } from "@vcpdeck/shared";
import {
	attachClientBridge,
	attachConnectionRecovery,
	isMigrationVerifyOnly,
} from "./index.js";

function fakeSocket() {
	const handlers: Record<string, Array<(...a: unknown[]) => unknown>> = {};
	const emits: Array<{ event: string; args: unknown[] }> = [];
	const socket = {
		on: (event: string, cb: (...a: unknown[]) => unknown) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(cb);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emits.push({ event, args });
			return socket;
		},
		connected: true,
		data: {},
		disconnect: () => {},
		connect: () => {},
	} as unknown as Socket;
	return { socket, handlers, emits };
}

function makeDeps() {
	return {
		deps: {
			clientId: "c1",
			getTerminalStatus: async () => undefined,
			getRuntimeSecurity: async () => undefined,
			getRegister: () =>
				({
					clientId: "c1",
					hostname: "host",
					os: "linux 1",
					cpuModel: "cpu",
					totalMemMB: 1,
					clientVersion: "1",
					capabilities: [],
				}) as never,
			getStatusReport: () => ({ clientId: "c1", jobs: [] } as StatusReport),
		},
	};
}

describe("attachClientBridge 迁移验证模式（verifyOnly）", () => {
	it("verifyOnly=true：注册后不下发 STATUS_REPORT", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never, {
			verifyOnly: true,
		});

		await bridge.onConnected();
		handlers["ack"]?.[0]?.({ event: Events.REGISTER });

		expect(emits.filter((e) => e.event === Events.REGISTER)).toHaveLength(1);
		expect(emits.some((e) => e.event === Events.STATUS_REPORT)).toBe(false);
	});

	it("verifyOnly 缺省（稳态）：注册 ack 后下发 STATUS_REPORT", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);

		await bridge.onConnected();
		handlers["ack"]?.[0]?.({ event: Events.REGISTER });

		expect(emits.some((e) => e.event === Events.STATUS_REPORT)).toBe(true);
	});

	it("注册回调直接调用时也只上报一次状态", async () => {
		const { socket, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);

		await bridge.onConnected();
		const register = emits.find((e) => e.event === Events.REGISTER);
		const ack = register?.args[1] as (() => void) | undefined;
		ack?.();
		ack?.();

		expect(emits.filter((e) => e.event === Events.STATUS_REPORT)).toHaveLength(1);
	});

	it("被取代的连接不重复发 REGISTER", async () => {
		const { socket, emits } = fakeSocket();
		const { deps } = makeDeps();
		const gate: { release?: () => void } = {};
		let calls = 0;
		const slowDeps = {
			...deps,
			getTerminalStatus: async () => {
				calls += 1;
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						gate.release = resolve;
					});
				}
				return undefined;
			},
		};
		const bridge = attachClientBridge(socket, slowDeps as never);

		const first = bridge.onConnected(); // 探测很慢
		const second = bridge.onConnected(); // 新连接代次
		gate.release?.();
		await Promise.all([first, second]);

		expect(emits.filter((e) => e.event === Events.REGISTER)).toHaveLength(1);
	});

	it("不再挂载任何 Pi 专用处理器", () => {
		const { socket, handlers } = fakeSocket();
		const { deps } = makeDeps();
		attachClientBridge(socket, deps as never);

		for (const event of ["pi:request", "pi:event", "pi:runtime-spec"]) {
			expect(handlers[event] ?? []).toHaveLength(0);
		}
	});
});

describe("isMigrationVerifyOnly", () => {
	it("VCPDECK_MIGRATION_VERIFY_ONLY=1 → true；其他 → false", () => {
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "1" })).toBe(true);
		expect(isMigrationVerifyOnly({})).toBe(false);
		expect(isMigrationVerifyOnly({ VCPDECK_MIGRATION_VERIFY_ONLY: "0" })).toBe(false);
	});
});

describe("attachConnectionRecovery 断开自愈", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("服务端主动断开时手动重连（socket.io 对 io server disconnect 不会自动重连）", () => {
		const { socket, handlers } = fakeSocket();
		socket.connect = vi.fn();
		attachConnectionRecovery(socket, { exit: vi.fn() });
		handlers["disconnect"]?.[0]?.("io server disconnect");
		expect(socket.connect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1_000);
		expect(socket.connect).toHaveBeenCalledTimes(1);
	});

	it("反复被踢时按退避继续重连（不放弃）", () => {
		const { socket, handlers } = fakeSocket();
		socket.connect = vi.fn();
		attachConnectionRecovery(socket, { exit: vi.fn() });
		handlers["disconnect"]?.[0]?.("io server disconnect");
		vi.advanceTimersByTime(1_000);
		handlers["disconnect"]?.[0]?.("io server disconnect");
		vi.advanceTimersByTime(1_000);
		expect(socket.connect).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1_000);
		expect(socket.connect).toHaveBeenCalledTimes(2);
	});

	it("传输层断开交给 socket.io 自动重连，不重复手动连", () => {
		const { socket, handlers } = fakeSocket();
		socket.connect = vi.fn();
		attachConnectionRecovery(socket, { exit: vi.fn() });
		handlers["disconnect"]?.[0]?.("transport close");
		vi.advanceTimersByTime(60_000);
		expect(socket.connect).not.toHaveBeenCalled();
	});

	it("长时间连不上时退出进程，交给 Launcher 拉起（不再静默假死）", () => {
		const { socket, handlers } = fakeSocket();
		socket.connect = vi.fn();
		const exit = vi.fn();
		attachConnectionRecovery(socket, { exit });
		handlers["disconnect"]?.[0]?.("io server disconnect");
		vi.advanceTimersByTime(5 * 60 * 1000 - 1);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("从未连上过（connect_error）也会被看门狗兜住", () => {
		const { socket, handlers } = fakeSocket();
		const exit = vi.fn();
		attachConnectionRecovery(socket, { exit });
		handlers["connect_error"]?.[0]?.(new Error("x"));
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("重新连上后撤销看门狗", () => {
		const { socket, handlers } = fakeSocket();
		socket.connect = vi.fn();
		const exit = vi.fn();
		attachConnectionRecovery(socket, { exit });
		handlers["disconnect"]?.[0]?.("io server disconnect");
		vi.advanceTimersByTime(4 * 60 * 1000);
		handlers["connect"]?.[0]?.();
		vi.advanceTimersByTime(30 * 60 * 1000);
		expect(exit).not.toHaveBeenCalled();
	});
});

describe("注册重试（服务端拒绝后自愈）", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const registerEmits = (emits: Array<{ event: string; args: unknown[] }>) =>
		emits.filter((e) => e.event === Events.REGISTER);

	it("未收到 ack 时按退避重发 REGISTER，收到 ack 后停止", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);
		await bridge.onConnected();
		expect(registerEmits(emits)).toHaveLength(1);

		vi.advanceTimersByTime(10_000);
		expect(registerEmits(emits)).toHaveLength(2);

		handlers["ack"]?.[0]?.({ event: Events.REGISTER });
		vi.advanceTimersByTime(10 * 60 * 1000);
		expect(registerEmits(emits)).toHaveLength(2);
	});

	it("服务端返回 ok:false（拒绝注册）不算注册成功，继续重试", async () => {
		const { socket, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);
		await bridge.onConnected();
		const first = registerEmits(emits)[0] as { args: unknown[] };
		// socket.io ack 回调收到 handler 返回值
		(first.args[1] as (r: { ok: boolean }) => void)({ ok: false });
		vi.advanceTimersByTime(20_000);
		expect(registerEmits(emits).length).toBeGreaterThanOrEqual(2);
		// 拒绝期间不得下发 STATUS_REPORT
		expect(emits.some((e) => e.event === Events.STATUS_REPORT)).toBe(false);
	});

	it("服务端主动回 error 后继续重试", async () => {
		const { socket, handlers, emits } = fakeSocket();
		const { deps } = makeDeps();
		const bridge = attachClientBridge(socket, deps as never);
		await bridge.onConnected();
		handlers["error"]?.[0]?.({ code: "REGISTER_INVALID" });
		vi.advanceTimersByTime(30_000);
		expect(registerEmits(emits).length).toBeGreaterThanOrEqual(2);
	});
});
