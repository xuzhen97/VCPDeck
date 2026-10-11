import { describe, expect, it } from "vitest";
import { SessionHostOperationError, createInstanceRegistry } from "./instance-registry.js";
import type { PtySession } from "./pty-session.js";

function fakeSession(instanceId: string): PtySession & { stopCalls: number } {
	let state: PtySession["state"] = "running";
	let stopCalls = 0;
	return {
		instanceId,
		get state() {
			return state;
		},
		lastSeq: 0,
		pendingBytes: 0,
		write() {},
		resize() {},
		async snapshot() {
			return { seq: 0, snapshot: "", cols: 80, rows: 24 };
		},
		async stop() {
			stopCalls += 1;
			state = "stopped";
			return { exited: true };
		},
		get stopCalls() {
			return stopCalls;
		},
	};
}

function build(maxInstances?: number) {
	let next = 0;
	const spawned: string[] = [];
	const startedAt = "2026-10-10T00:00:00.000Z";
	const registry = createInstanceRegistry({
		maxInstances,
		createId: () => `inst_${++next}`,
		now: () => startedAt,
		start: ({ instanceId }) => {
			spawned.push(instanceId);
			return fakeSession(instanceId);
		},
	});
	return { registry, spawned, startedAt };
}

describe("受管实例登记表", () => {
	it("start 返回新身份并出现在 list 中", () => {
		const { registry } = build();
		const result = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		expect(result).toEqual({ instanceId: "inst_1", reused: false });
		expect(registry.list()).toEqual([
			{ instanceId: "inst_1", kind: "pi", state: "running", startedAt: "2026-10-10T00:00:00.000Z", lastSeq: 0 },
		]);
	});

	it("同一 operationId 重复 start 幂等复用，绝不重复启动", () => {
		const { registry, spawned } = build();
		const first = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		const second = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		expect(second).toEqual({ instanceId: first.instanceId, reused: true });
		expect(spawned).toEqual(["inst_1"]);
		expect(registry.size()).toBe(1);
	});

	it("实例已停止后重放同一 operationId 仍复用原身份，不重启", async () => {
		const { registry, spawned } = build();
		const first = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		await registry.stop(first.instanceId);
		const replay = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		expect(replay.instanceId).toBe(first.instanceId);
		expect(registry.get(first.instanceId)?.session.state).toBe("stopped");
		expect(spawned).toEqual(["inst_1"]);
	});

	it("不同 operationId 即使 kind 与 cwd 相同也各自独立", () => {
		const { registry } = build();
		const a = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		const b = registry.start({ operationId: "op_2", kind: "pi", cwd: "/w" });
		expect(a.instanceId).not.toBe(b.instanceId);
		expect(registry.size()).toBe(2);
	});

	it("越限拒绝并给出稳定错误码，不驱逐既有实例", () => {
		const { registry } = build(2);
		registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		registry.start({ operationId: "op_2", kind: "pi", cwd: "/w" });
		expect(() => registry.start({ operationId: "op_3", kind: "dsh", cwd: "/w" })).toThrow(
			SessionHostOperationError,
		);
		try {
			registry.start({ operationId: "op_3", kind: "dsh", cwd: "/w" });
		} catch (error) {
			expect((error as SessionHostOperationError).code).toBe("SESSION_HOST_INSTANCE_LIMIT_REACHED");
		}
		expect(registry.size()).toBe(2);
		expect(registry.list().every((i) => i.state === "running")).toBe(true);
	});

	it("stop 未知身份给出 NOT_FOUND，不静默成功", async () => {
		const { registry } = build();
		await expect(registry.stop("inst_missing")).rejects.toBeInstanceOf(SessionHostOperationError);
		try {
			await registry.stop("inst_missing");
			throw new Error("本应抛出");
		} catch (error) {
			expect((error as SessionHostOperationError).code).toBe("SESSION_HOST_INSTANCE_NOT_FOUND");
		}
	});

	it("stop 把退出确认结果如实透传，未确认时不冒充已退出", async () => {
		let next = 0;
		const exits = [true, false];
		const registry = createInstanceRegistry({
			createId: () => `inst_${++next}`,
			now: () => "2026-10-10T00:00:00.000Z",
			start: ({ instanceId }) => ({
				...fakeSession(instanceId),
				stop: async () => ({ exited: exits.shift() ?? false }),
			}),
		});
		const a = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		const b = registry.start({ operationId: "op_2", kind: "pi", cwd: "/w" });
		expect(await registry.stop(a.instanceId)).toEqual({ exited: true });
		expect(await registry.stop(b.instanceId)).toEqual({ exited: false });
	});

	it("list 不泄露 cwd 与 operationId", () => {
		const { registry } = build();
		registry.start({ operationId: "op_1", kind: "pi", cwd: "C:/secret/project" });
		const entry = registry.list()[0] as unknown as Record<string, unknown>;
		expect(Object.keys(entry).sort()).toEqual(["instanceId", "kind", "lastSeq", "startedAt", "state"]);
		expect(JSON.stringify(registry.list())).not.toContain("secret");
	});

	it("stop 后状态转为 stopped", async () => {
		const { registry } = build();
		const { instanceId } = registry.start({ operationId: "op_1", kind: "pi", cwd: "/w" });
		await registry.stop(instanceId);
		expect(registry.get(instanceId)?.session.state).toBe("stopped");
	});
});
