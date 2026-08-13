import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import { createTerminalSocket } from "./terminal-socket.js";

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
			const idx = list.indexOf(cb);
			if (idx >= 0) list.splice(idx, 1);
			return socket;
		},
		emit: (event: string, ...args: unknown[]) => {
			emitCalls.push({ event, args });
			return socket;
		},
	} as unknown as Socket;
	const fire = (event: string, ...args: unknown[]) => {
		for (const cb of listeners.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args);
	};
	const ack = (event: string, result: unknown) => {
		const call = emitCalls.find((c) => c.event === event && typeof c.args[1] === "function");
		(call?.args[1] as (r: unknown) => void)(result);
	};
	return { socket, emitCalls, listeners, fire, ack };
}

describe("createTerminalSocket", () => {
	it("attach 发送事件并解析 ack", async () => {
		const { socket, emitCalls, ack } = fakeSocket();
		const ts = createTerminalSocket(socket);
		const promise = ts.attach("s1", "tok");
		const call = emitCalls.find((c) => c.event === Events.TERMINAL_ATTACH);
		expect(call?.args[0]).toEqual({ sessionId: "s1", reconnectToken: "tok" });
		ack(Events.TERMINAL_ATTACH, {
			ok: true,
			data: { sessionId: "s1", attachmentId: "ta1", reconnectToken: "tok", mode: "operator", controlProtectedUntil: null },
		});
		await expect(promise).resolves.toMatchObject({ mode: "operator" });
	});

	it("attach 错误 ack 返回错误对象", async () => {
		const { socket, emitCalls, ack } = fakeSocket();
		const ts = createTerminalSocket(socket);
		const promise = ts.attach("s1");
		ack(Events.TERMINAL_ATTACH, { ok: false, error: { code: "TERMINAL_SESSION_ENDED", message: "ended" } });
		await expect(promise).rejects.toMatchObject({ code: "TERMINAL_SESSION_ENDED" });
	});

	it("input 只发送 sessionId/attachmentId/data", async () => {
		const { socket, emitCalls } = fakeSocket();
		const ts = createTerminalSocket(socket);
		void ts.input("s1", "ta1", "ls\r");
		const call = emitCalls.find((c) => c.event === Events.TERMINAL_INPUT);
		expect(call?.args[0]).toEqual({ sessionId: "s1", attachmentId: "ta1", data: "ls\r" });
	});

	it("事件订阅：snapshot/output/control/session-state/resync-required/error", () => {
		const { socket, fire } = fakeSocket();
		const ts = createTerminalSocket(socket);
		const onSnapshot = vi.fn();
		const onOutput = vi.fn();
		const onControl = vi.fn();
		const onSessionState = vi.fn();
		const onResyncRequired = vi.fn();
		const onError = vi.fn();
		ts.onSnapshot(onSnapshot);
		ts.onOutput(onOutput);
		ts.onControl(onControl);
		ts.onSessionState(onSessionState);
		ts.onResyncRequired(onResyncRequired);
		ts.onError(onError);
		fire(Events.TERMINAL_SNAPSHOT, { sessionId: "s1", snapshot: "x", snapshotSeq: 1, cols: 80, rows: 24, historyTruncated: false });
		fire(Events.TERMINAL_OUTPUT, { sessionId: "s1", seq: 2, data: "y" });
		fire(Events.TERMINAL_CONTROL, { sessionId: "s1", mode: "operator", operatorName: null, controlProtectedUntil: null, canTakeover: false });
		fire(Events.TERMINAL_SESSION_STATE, { sessionId: "s1", status: "exited", reason: "exit:0" });
		fire(Events.TERMINAL_RESYNC_REQUIRED, { sessionId: "s1" });
		fire(Events.TERMINAL_ERROR, { code: "TERMINAL_CLIENT_OFFLINE", message: "offline" });
		expect(onSnapshot).toHaveBeenCalledTimes(1);
		expect(onOutput).toHaveBeenCalledTimes(1);
		expect(onControl).toHaveBeenCalledTimes(1);
		expect(onSessionState).toHaveBeenCalledTimes(1);
		expect(onResyncRequired).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("dispose 移除监听", () => {
		const { socket, fire } = fakeSocket();
		const ts = createTerminalSocket(socket);
		const onOutput = vi.fn();
		ts.onOutput(onOutput);
		ts.dispose();
		fire(Events.TERMINAL_OUTPUT, { sessionId: "s1", seq: 1, data: "x" });
		expect(onOutput).not.toHaveBeenCalled();
	});
});
