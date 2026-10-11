import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import { describe, expect, it } from "vitest";
import type { SessionHostStatusReport } from "@vcpdeck/shared";
import { attachSessionHostBridge } from "./bridge.js";

const REPORT: SessionHostStatusReport = {
	available: true,
	hostId: "host-1",
	instances: [
		{ instanceId: "inst_1", kind: "pi", state: "running", startedAt: "2026-10-10T00:00:00.000Z", lastSeq: 1 },
	],
};
const UNAVAILABLE: SessionHostStatusReport = { available: false, hostId: null, instances: [] };

function fakeSocket() {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const emitCalls: Array<{ event: string; args: unknown[] }> = [];
	const socket = {
		connected: true,
		on: (event: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(cb);
			listeners.set(event, list);
			return socket;
		},
		off: (event: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(event) ?? [];
			listeners.set(
				event,
				list.filter((item) => item !== cb),
			);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emitCalls.push({ event, args });
			return socket;
		},
	} as unknown as Socket;
	const fire = (event: string, ...args: unknown[]): void => {
		for (const cb of listeners.get(event) ?? []) cb(...args);
	};
	return { socket, emitCalls, fire };
}

/** 等待桥内部异步上报完成。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeClient(status: () => Promise<SessionHostStatusReport>) {
	const stopCalls: string[] = [];
	return {
		stopCalls,
		client: {
			status,
			stop: async (instanceId: string) => {
				stopCalls.push(instanceId);
				return { exited: true };
			},
		},
	};
}

describe("会话宿主对账桥", () => {
	it("REGISTER ack 后上报宿主状态报告", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client } = makeClient(async () => REPORT);
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.REGISTER });
		await flush();
		const states = emitCalls.filter((call) => call.event === Events.SESSION_HOST_STATE);
		expect(states).toHaveLength(1);
		expect(states[0]?.args[0]).toEqual(REPORT);
	});

	it("宿主不可达时上报 available: false，且不产生任何关闭指令", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client, stopCalls } = makeClient(async () => UNAVAILABLE);
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.REGISTER });
		await flush();
		expect(emitCalls[0]?.args[0]).toEqual({ available: false, hostId: null, instances: [] });
		expect(stopCalls).toEqual([]);
	});

	it("状态查询抛错时上报不可达而不是崩掉桥", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client } = makeClient(async () => {
			throw new Error("boom");
		});
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.REGISTER });
		await flush();
		expect(emitCalls[0]?.args[0]).toEqual({ available: false, hostId: null, instances: [] });
	});

	it("非 REGISTER 的 ack 不上报", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client } = makeClient(async () => REPORT);
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.TERMINAL_STATE });
		fire("ack", {});
		await flush();
		expect(emitCalls).toEqual([]);
	});

	it("断线状态下不上报", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		(socket as unknown as { connected: boolean }).connected = false;
		const { client } = makeClient(async () => REPORT);
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.REGISTER });
		await flush();
		expect(emitCalls).toEqual([]);
	});

	it("只发新事件，绝不触碰 terminal:*", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client } = makeClient(async () => REPORT);
		attachSessionHostBridge(socket, { clientHost: client });
		fire("ack", { event: Events.REGISTER });
		await flush();
		expect(emitCalls.every((call) => !String(call.event).startsWith("terminal:"))).toBe(true);
		expect(emitCalls.some((call) => call.event === Events.TERMINAL_STATE)).toBe(false);
		expect(emitCalls.map((call) => call.event)).toEqual([Events.SESSION_HOST_STATE]);
		// 字面量断言：防止 shared 未重建时 undefined 与 undefined 相等造成的假绿。
		expect(emitCalls[0]?.event).toBe("session-host:state");
	});

	it("dispose 后不再响应注册 ack", async () => {
		const { socket, emitCalls, fire } = fakeSocket();
		const { client } = makeClient(async () => REPORT);
		const bridge = attachSessionHostBridge(socket, { clientHost: client });
		bridge.dispose();
		fire("ack", { event: Events.REGISTER });
		await flush();
		expect(emitCalls).toEqual([]);
	});

	it("可手动触发一次上报（供 Server 主动对账）", async () => {
		const { socket, emitCalls } = fakeSocket();
		const { client } = makeClient(async () => REPORT);
		const bridge = attachSessionHostBridge(socket, { clientHost: client });
		await bridge.report();
		expect(emitCalls).toHaveLength(1);
		expect(emitCalls[0]?.event).toBe(Events.SESSION_HOST_STATE);
	});
});
