import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Events } from "@vcpdeck/shared";
import { attachUpdateHandler, isDraining } from "./update.js";
import { dispatch } from "./dispatcher.js";

function makeSocket() {
	const handlers = new Map<string, (data: never) => void>();
	const emitted: Array<[string, unknown]> = [];
	return {
		handlers,
		emitted,
		on: vi.fn((ev: string, fn: (data: never) => void) => {
			handlers.set(ev, fn);
		}),
		off: vi.fn((ev: string) => {
			handlers.delete(ev);
		}),
		emit: vi.fn((ev: string, data: unknown) => {
			emitted.push([ev, data]);
		}),
	};
}

type FakeSocket = ReturnType<typeof makeSocket>;

function makeLauncher() {
	return {
		prepareUpdate: vi.fn(),
		applyUpdate: vi.fn(),
	};
}

const REQ = {
	releaseVersion: "1.2.1",
	url: "/api/releases/1.2.1/file",
	sha256: "a".repeat(64),
};

function fireUpdateRequest(socket: FakeSocket) {
	const handler = socket.handlers.get(Events.UPDATE_REQUEST);
	if (!handler) throw new Error("UPDATE_REQUEST 未注册");
	handler(REQ as never);
}

function lastEmit(socket: FakeSocket, event: string): unknown {
	return socket.emitted.filter(([e]) => e === event).at(-1)?.[1];
}

describe("客户端优雅停机（update.ts）", () => {
	let socket: FakeSocket;
	let launcher: ReturnType<typeof makeLauncher>;
	let runningJobs: string[];

	beforeEach(() => {
		socket = makeSocket();
		launcher = makeLauncher();
		runningJobs = [];
		launcher.prepareUpdate.mockResolvedValue(undefined);
		launcher.applyUpdate.mockResolvedValue(undefined);
		attachUpdateHandler({
			socket: socket as never,
			launcher: launcher as never,
			serverBase: "http://localhost:3001",
			getRunningJobIds: () => runningJobs,
			pollIntervalMs: 50,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("完整流程：prepare（完整 URL）→ 等 job 清空 → READY → apply", async () => {
		runningJobs = ["job-1"];
		const phase = new Promise<void>((resolve) => {
			const interval = setInterval(() => {
				const ready = lastEmit(socket, Events.UPDATE_READY);
				if (ready) {
					clearInterval(interval);
					resolve();
				}
			}, 10);
		});

		fireUpdateRequest(socket);
		// job 完成后流程继续
		setTimeout(() => {
			runningJobs = [];
		}, 100);
		await phase;

		expect(launcher.prepareUpdate).toHaveBeenCalledWith({
			version: "1.2.1",
			url: "http://localhost:3001/api/releases/1.2.1/file",
			sha256: "a".repeat(64),
		});
		expect(lastEmit(socket, Events.UPDATE_READY)).toMatchObject({
			clientId: expect.any(String),
			releaseVersion: "1.2.1",
		});
		expect(launcher.applyUpdate).toHaveBeenCalledTimes(1);
	});

	it("beforeApply 顺序：prepare → drain → update:ready → beforeApply → apply", async () => {
		const order: string[] = [];
		launcher.prepareUpdate.mockImplementation(async () => {
			order.push("prepare");
		});
		launcher.applyUpdate.mockImplementation(async () => {
			order.push("apply");
		});
		// 重新 attach（Map 覆盖旧注册），注入 beforeApply 钩子。
		attachUpdateHandler({
			socket: socket as never,
			launcher: launcher as never,
			serverBase: "http://localhost:3001",
			getRunningJobIds: () => [],
			beforeApply: async () => {
				order.push(`ready=${String(lastEmit(socket, Events.UPDATE_READY) !== undefined)}`);
				order.push("beforeApply");
			},
		});

		fireUpdateRequest(socket);
		await vi.waitFor(() => {
			expect(launcher.applyUpdate).toHaveBeenCalledTimes(1);
		});

		expect(order).toEqual(["prepare", "ready=true", "beforeApply", "apply"]);
	});

	it("prepare 失败 → UPDATE_FAILED 且不发 READY", async () => {
		launcher.prepareUpdate.mockRejectedValue(new Error("校验失败"));

		fireUpdateRequest(socket);
		await vi.waitFor(() => {
			expect(lastEmit(socket, Events.UPDATE_FAILED)).toBeTruthy();
		});

		expect(lastEmit(socket, Events.UPDATE_FAILED)).toMatchObject({
			releaseVersion: "1.2.1",
			reason: expect.stringContaining("校验失败"),
		});
		expect(lastEmit(socket, Events.UPDATE_READY)).toBeUndefined();
		expect(isDraining()).toBe(false);
	});

	it("等待超时 → 强制继续（仍发 READY 并 apply）", async () => {
		vi.useFakeTimers();
		runningJobs = ["job-1"]; // 一直不完成

		fireUpdateRequest(socket);
		// 默认超时 10 分钟；这里推进超过超时上限
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

		expect(lastEmit(socket, Events.UPDATE_READY)).toBeTruthy();
		expect(launcher.applyUpdate).toHaveBeenCalled();
	});

	it("draining 期间重复 update:request 只处理一次", async () => {
		vi.useFakeTimers();
		runningJobs = ["job-1"];

		fireUpdateRequest(socket);
		fireUpdateRequest(socket);

		expect(launcher.prepareUpdate).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
		expect(launcher.applyUpdate).toHaveBeenCalledTimes(1);
	});

	it("apply 返回后不再上报失败（终局以重连注册版本为准）", async () => {
		launcher.applyUpdate.mockResolvedValue(undefined);

		fireUpdateRequest(socket);
		await vi.waitFor(() => {
			expect(isDraining()).toBe(false);
		});

		expect(launcher.applyUpdate).toHaveBeenCalledTimes(1);
		expect(lastEmit(socket, Events.UPDATE_FAILED)).toBeUndefined();
	});

	it("draining 期间 dispatch 拒绝新任务（CLIENT_UPDATING）", async () => {
		vi.useFakeTimers();
		runningJobs = ["job-1"];

		fireUpdateRequest(socket);
		await vi.advanceTimersByTimeAsync(10);

		dispatch(
			{
				jobId: "job-new",
				type: "exec",
				mode: "command",
				command: "echo hi",
			} as never,
			socket as never,
		);

		const done = lastEmit(socket, Events.JOB_DONE);
		expect(done).toMatchObject({
			jobId: "job-new",
			error: { code: "CLIENT_UPDATING" },
		});

		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
		expect(isDraining()).toBe(false);
	});
});
