import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events, type FrpRuntimeStateReport } from "@vcpdeck/shared";
import { attachFrpSocketBridge } from "./frp-socket-bridge.js";
import { dispatch } from "./dispatcher.js";
import { attachUpdateHandler } from "./update.js";
import { handleFrpReconcile } from "./frpc-daemon.js";

// dispatcher 测试用：隔离 frpc-daemon 真实模块（避免 client-id 文件副作用与真实 spawn）。
vi.mock("./frpc-daemon.js", () => ({
	isFrpAvailable: () => true,
	getFrpRuntimeManager: vi.fn(),
	getFrpRuntimeState: vi.fn(),
	setFrpConnectionGeneration: vi.fn(),
	subscribeFrpRuntimeState: vi.fn(() => () => {}),
	handleFrpCreate: vi.fn(async () => {}),
	handleFrpDelete: vi.fn(async () => {}),
	handleFrpList: vi.fn(),
	handleFrpReconcile: vi.fn(async () => {}),
	shutdownFrpRuntime: vi.fn(async () => {}),
}));

function makeSocket() {
	const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
	const emitted: Array<[string, unknown, unknown]> = [];
	return {
		connected: true,
		on: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
			if (handlers[ev] === undefined) handlers[ev] = [];
			handlers[ev]?.push(fn);
		}),
		off: vi.fn((ev: string, fn: (...args: unknown[]) => void) => {
			handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn);
		}),
		emit: vi.fn((ev: string, data: unknown, cb?: unknown) => {
			emitted.push([ev, data, cb]);
		}),
		fire(ev: string, ...args: unknown[]) {
			for (const h of handlers[ev] ?? []) h(...args);
		},
		emitted,
	};
}

type FakeSocket = ReturnType<typeof makeSocket>;

function fakeManager() {
	let generation = "";
	const report = (clientId: string): FrpRuntimeStateReport => ({
		clientId,
		connectionGeneration: generation,
		runtimeGeneration: 0,
		status: "stopped",
		processRunning: false,
		recoveryOwner: null,
		attempt: 0,
		frpsEndpoint: null,
		mappings: [],
	});
	return {
		reconcile: vi.fn(async () => ({
			connectionGeneration: generation,
			runtimeGeneration: 1,
			status: "running" as const,
			loadedMappingIds: [],
		})),
		create: vi.fn(),
		delete: vi.fn(),
		list: () => ({ mappings: [] }),
		isAvailable: () => true,
		getStateReport: (clientId: string) => report(clientId),
		setConnectionGeneration: (value: string) => {
			generation = value;
		},
		subscribe: () => () => {},
		shutdown: vi.fn(async () => {}),
	};
}

function emitted(socket: FakeSocket, event: string): unknown[] {
	return socket.emitted.filter(([ev]) => ev === event).map(([, data]) => data);
}

// 文件级：避免 register 模块（经 frpc-daemon 链）读写 ~/.vcpdeck/client-id，并隔离 mock 调用计数。
beforeEach(() => {
	process.env.VCPDECK_CLIENT_ID = "test-client";
	vi.mocked(handleFrpReconcile).mockClear();
});

afterEach(() => {
	delete process.env.VCPDECK_CLIENT_ID;
	vi.useRealTimers();
});

describe("FRP socket 桥", () => {
	it("每次 REGISTER ack 生成新 connection generation 并上报安全快照", () => {
		const socket = makeSocket();
		const manager = fakeManager();
		const bridge = attachFrpSocketBridge(socket as never, {
			clientId: "c1",
			manager,
		});

		bridge.onConnected();
		socket.fire("ack", { event: Events.REGISTER });
		const first = emitted(socket, Events.FRP_STATE)[0] as FrpRuntimeStateReport;

		bridge.onConnected(); // 模拟重连
		socket.fire("ack", { event: Events.REGISTER });
		const second = emitted(socket, Events.FRP_STATE)[1] as FrpRuntimeStateReport;

		expect(first.connectionGeneration).not.toBe(second.connectionGeneration);
		expect(JSON.stringify(second)).not.toContain("authToken");
		expect(JSON.stringify(second)).not.toContain("frpc-combined.toml");
	});

	it("旧 Server 不发 FRP ack 时不从磁盘或空 registry 自恢复", () => {
		const socket = makeSocket();
		const manager = fakeManager();
		const bridge = attachFrpSocketBridge(socket as never, {
			clientId: "c1",
			manager,
		});
		bridge.onConnected();
		socket.fire("ack", { event: Events.REGISTER });
		expect(manager.reconcile).not.toHaveBeenCalled();
	});

	it("严格忽略非法 ack 与旧 connection generation 的 ack", () => {
		const socket = makeSocket();
		const manager = fakeManager();
		const bridge = attachFrpSocketBridge(socket as never, {
			clientId: "c1",
			manager,
		});
		bridge.onConnected();
		socket.fire("ack", { event: Events.REGISTER });
		const stateEmit = socket.emitted.find(([ev]) => ev === Events.FRP_STATE)!;
		const ackCb = stateEmit[2] as (raw: unknown) => void;

		// 非法 ack（未知字段）静默忽略。
		expect(() =>
			ackCb({ connectionGeneration: "x", accepted: true, action: "weird" }),
		).not.toThrow();
		// 旧 connection generation 的 ack 忽略（manager 不因此触发恢复）。
		const stale = {
			connectionGeneration: "conn-old",
			accepted: true,
			action: "server-reconciling",
		};
		expect(() => ackCb(stale)).not.toThrow();
		// 新 Server 直发 FRP_STATE_ACK 事件也走同一严格解析。
		socket.fire(Events.FRP_STATE_ACK, stale);
		expect(manager.reconcile).not.toHaveBeenCalled();
	});
});

describe("dispatcher frp.reconcile 路由", () => {
	it("dispatch({ type: 'frp.reconcile' }) 调用 handleFrpReconcile 一次", () => {
		const socket = makeSocket();
		dispatch(
			{
				jobId: "job-reconcile",
				type: "frp.reconcile",
				payload: { connectionGeneration: "conn-1" },
			},
			socket as never,
		);
		expect(handleFrpReconcile).toHaveBeenCalledTimes(1);
		expect(handleFrpReconcile).toHaveBeenCalledWith(
			expect.objectContaining({ _jobId: "job-reconcile" }),
			expect.anything(),
		);
	});

	it("draining 期间 frp.reconcile 仍走现有 CLIENT_UPDATING 拒绝", () => {
		const updateSocket = makeSocket();
		attachUpdateHandler({
			socket: updateSocket as never,
			launcher: {
				prepareUpdate: async () => {},
				// apply 挂起：draining 保持 true，模拟 launcher 接管前的窗口。
				applyUpdate: () => new Promise<void>(() => {}),
			},
			serverBase: "http://localhost:3001",
		} as never);
		// 通过注册的 UPDATE_REQUEST handler 触发 draining。
		updateSocket.fire(Events.UPDATE_REQUEST, {
			releaseVersion: "1.0.0",
			url: "/api/releases/1.0.0/file",
			sha256: "a".repeat(64),
		} as never);

		const socket = makeSocket();
		dispatch(
			{
				jobId: "job-reconcile-2",
				type: "frp.reconcile",
				payload: { connectionGeneration: "conn-1" },
			},
			socket as never,
		);
		const done = emitted(socket, Events.JOB_DONE)[0] as {
			error?: { code?: string };
		};
		expect(done.error?.code).toBe("CLIENT_UPDATING");
		expect(handleFrpReconcile).not.toHaveBeenCalled();
	});
});
