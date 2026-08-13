import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTerminalSession, type TerminalViewHandle, type TerminalSocketEvents } from "./use-terminal-session.js";
import type { TerminalControlState, TerminalErrorMessage, TerminalOutputChunk, TerminalSessionStateMessage, TerminalSnapshotMessage } from "@vcpdeck/shared";

function makeSocket() {
	let connectionChange: ((connected: boolean) => void) | null = null;
	const handlers: {
		onSnapshot?: (m: TerminalSnapshotMessage) => void;
		onOutput?: (c: TerminalOutputChunk) => void;
		onControl?: (c: TerminalControlState) => void;
		onSessionState?: (m: TerminalSessionStateMessage) => void;
		onResyncRequired?: () => void;
		onError?: (e: TerminalErrorMessage) => void;
	} = {};
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const log = (method: string, ...args: unknown[]) => calls.push({ method, args });
	const socket: TerminalSocketEvents = {
		attach: vi.fn(async (sessionId: string, reconnectToken?: string | null) => {
			log("attach", sessionId, reconnectToken ?? null);
			return { sessionId, attachmentId: "ta1", reconnectToken: "tok-new", mode: "operator" as const, controlProtectedUntil: null };
		}),
		detach: vi.fn(async (sessionId: string, attachmentId: string) => {
			log("detach", sessionId, attachmentId);
		}),
		input: vi.fn(async (sessionId: string, attachmentId: string, data: string) => {
			log("input", sessionId, attachmentId, data);
		}),
		resize: vi.fn(async (sessionId: string, attachmentId: string, cols: number, rows: number) => {
			log("resize", sessionId, attachmentId, cols, rows);
		}),
		takeover: vi.fn(async (sessionId: string, attachmentId: string) => {
			log("takeover", sessionId, attachmentId);
			return { mode: "operator" as const };
		}),
		ackOutput: vi.fn(async (sessionId: string, attachmentId: string, seq: number) => {
			log("ack-output", sessionId, attachmentId, seq);
		}),
		resync: vi.fn(async (sessionId: string, attachmentId: string) => {
			log("resync", sessionId, attachmentId);
		}),
		onSnapshot: (cb: (m: TerminalSnapshotMessage) => void) => {
			handlers.onSnapshot = cb;
		},
		onOutput: (cb: (c: TerminalOutputChunk) => void) => {
			handlers.onOutput = cb;
		},
		onControl: (cb: (c: TerminalControlState) => void) => {
			handlers.onControl = cb;
		},
		onSessionState: (cb: (m: TerminalSessionStateMessage) => void) => {
			handlers.onSessionState = cb;
		},
		onResyncRequired: (cb: () => void) => {
			handlers.onResyncRequired = cb;
		},
		onError: (cb: (e: TerminalErrorMessage) => void) => {
			handlers.onError = cb;
		},
		onConnectionChange: (cb: (connected: boolean) => void) => {
			connectionChange = cb;
		},
		dispose: vi.fn(() => undefined),
	};
	return { socket, handlers, calls, getConnectionChange: () => connectionChange };
}

function makeView() {
	const writes: string[] = [];
	const resets: number[] = [];
	const view: TerminalViewHandle = {
		write: (data) => writes.push(data),
		reset: () => resets.push(1),
	};
	return { view, writes, resets };
}

function makeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		map,
	};
}

describe("useTerminalSession", () => {
	function goLive(handlers: { onSnapshot?: (m: TerminalSnapshotMessage) => void }) {
		act(() => {
			handlers.onSnapshot?.({
				sessionId: "s1",
				snapshot: "S",
				snapshotSeq: 0,
				cols: 80,
				rows: 24,
				historyTruncated: false,
			});
		});
	}
	it("挂载时 attach 并保存 token，无 token 时直接 attach", async () => {
		const { socket, handlers, calls } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		const { result } = renderHook(() =>
			useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }),
		);
		await waitFor(() => expect(calls.find((c) => c.method === "attach")?.args).toEqual(["s1", null]));
		expect(storage.map.get("vcpdeck:term:c1:s1")).toBe("tok-new");
		await waitFor(() => expect(result.current.state.phase).toBe("syncing"));
		goLive(handlers);
		await waitFor(() => expect(result.current.state.phase).toBe("live"));
		expect(result.current.state.mode).toBe("operator");
	});

	it("使用 sessionStorage 中已有 token 重连", async () => {
		const { socket, calls } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		storage.map.set("vcpdeck:term:c1:s1", "old-tok");
		renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(calls.find((c) => c.method === "attach")?.args).toEqual(["s1", "old-tok"]));
	});

	it("snapshot 后写入 view，期间增量缓冲后按序写出", async () => {
		const { socket, handlers } = makeSocket();
		const { view, writes } = makeView();
		const storage = makeStorage();
		const { result } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(result.current.state.phase).toBe("syncing"));
		// syncing 期间到达增量
		act(() => {
			handlers.onOutput?.({ sessionId: "s1", seq: 3, data: "delta3" });
		});
		act(() => {
			handlers.onSnapshot?.({
				sessionId: "s1",
				snapshot: "SNAP",
				snapshotSeq: 2,
				cols: 80,
				rows: 24,
				historyTruncated: false,
			});
		});
		await waitFor(() => expect(writes).toContain("SNAP"));
		await waitFor(() => expect(writes).toContain("delta3"));
	});

	it("重复 seq 丢弃；gap 触发 resync", async () => {
		const { socket, handlers, calls } = makeSocket();
		const { view, writes } = makeView();
		const storage = makeStorage();
		renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(0));
		act(() => {
			handlers.onSnapshot?.({ sessionId: "s1", snapshot: "S", snapshotSeq: 5, cols: 80, rows: 24, historyTruncated: false });
		});
		await waitFor(() => expect(writes).toContain("S"));
		act(() => {
			handlers.onOutput?.({ sessionId: "s1", seq: 6, data: "a" });
			handlers.onOutput?.({ sessionId: "s1", seq: 6, data: "dup" });
			handlers.onOutput?.({ sessionId: "s1", seq: 8, data: "gap" });
		});
		await waitFor(() => expect(writes).toContain("a"));
		expect(writes.filter((w) => w === "dup")).toHaveLength(0);
		expect(writes.filter((w) => w === "gap")).toHaveLength(0);
		expect(calls.find((c) => c.method === "resync")).toBeTruthy();
	});

	it("viewer 输入不发送；operator 输入发送", async () => {
		const { socket, handlers, calls } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		const { result } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(result.current.state.phase).toBe("syncing"));
		goLive(handlers);
		await waitFor(() => expect(result.current.state.phase).toBe("live"));
		act(() => {
			result.current.handleInput("ls\r");
		});
		expect(calls.find((c) => c.method === "input")?.args).toEqual(["s1", "ta1", "ls\r"]);
		// 变为 viewer
		act(() => {
			handlers.onControl?.({
				sessionId: "s1",
				mode: "viewer",
				operatorName: "other",
				controlProtectedUntil: null,
				canTakeover: true,
			});
		});
		act(() => {
			result.current.handleInput("rm -rf /\r");
		});
		expect(calls.filter((c) => c.method === "input")).toHaveLength(1);
	});

	it("接管：保护期后 canTakeover 时调用 takeover", async () => {
		const { socket, handlers, calls } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		const { result } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		goLive(handlers);
		await waitFor(() => expect(result.current.state.phase).toBe("live"));
		act(() => {
			handlers.onControl?.({
				sessionId: "s1",
				mode: "viewer",
				operatorName: null,
				controlProtectedUntil: "2026-08-12T00:00:30.000Z",
				canTakeover: false,
			});
		});
		act(() => {
			void result.current.handleTakeover();
		});
		expect(calls.find((c) => c.method === "takeover")).toBeUndefined();
		act(() => {
			handlers.onControl?.({
				sessionId: "s1",
				mode: "viewer",
				operatorName: null,
				controlProtectedUntil: null,
				canTakeover: true,
			});
		});
		act(() => {
			void result.current.handleTakeover();
		});
		await waitFor(() => expect(calls.find((c) => c.method === "takeover")).toBeTruthy());
	});

	it("session-state 终态进入 ended 并清理 token", async () => {
		const { socket, handlers } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		storage.map.set("vcpdeck:term:c1:s1", "tok");
		const { result } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		goLive(handlers);
		await waitFor(() => expect(result.current.state.phase).toBe("live"));
		act(() => {
			handlers.onSessionState?.({ sessionId: "s1", status: "exited", reason: "exit:0" });
		});
		expect(result.current.state.phase).toBe("ended");
		expect(storage.map.has("vcpdeck:term:c1:s1")).toBe(false);
	});

	it("卸载时 detach 且不 close", async () => {
		const { socket, calls } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		const { unmount } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(calls.find((c) => c.method === "attach")).toBeTruthy());
		unmount();
		expect(calls.find((c) => c.method === "detach")).toBeTruthy();
		expect(calls.filter((c) => c.method === "close")).toHaveLength(0);
	});
});

describe("断线重连与操作权", () => {
	it("断线进入 reconnecting；重连后自动重新 attach（带 token）", async () => {
		const { socket, handlers, calls, getConnectionChange } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		storage.map.set("vcpdeck:term:c1:s1", "saved-tok");
		const { result } = renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage }));
		await waitFor(() => expect(result.current.state.phase).toBe("syncing"));
		act(() => {
			getConnectionChange()?.(false);
		});
		expect(result.current.state.phase).toBe("reconnecting");
		const attachCalls = calls.filter((c) => c.method === "attach").length;
		act(() => {
			getConnectionChange()?.(true);
		});
		await waitFor(() => expect(calls.filter((c) => c.method === "attach").length).toBe(attachCalls + 1));
	});

	it("获得操作权时触发 onGainedControl", async () => {
		const { socket, handlers } = makeSocket();
		const { view } = makeView();
		const storage = makeStorage();
		const onGainedControl = vi.fn();
		renderHook(() => useTerminalSession({ socket, clientId: "c1", sessionId: "s1", view, storage, onGainedControl }));
		await waitFor(() => expect(onGainedControl).not.toHaveBeenCalled());
		act(() => {
			handlers.onControl?.({
				sessionId: "s1",
				mode: "viewer",
				operatorName: "other",
				controlProtectedUntil: null,
				canTakeover: false,
			});
		});
		expect(onGainedControl).not.toHaveBeenCalled();
		act(() => {
			handlers.onControl?.({
				sessionId: "s1",
				mode: "operator",
				operatorName: null,
				controlProtectedUntil: null,
				canTakeover: false,
			});
		});
		expect(onGainedControl).toHaveBeenCalledTimes(1);
	});
});
