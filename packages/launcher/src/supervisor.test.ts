import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RESTART_POLICY } from "./supervision-policy.js";
import { Supervisor, type SupervisedComponent } from "./supervisor.js";

interface Harness {
	component: SupervisedComponent;
	calls: string[];
	/** 让下一次 check 返回该原因；null 表示健康。 */
	setHealth: (reason: string | null) => void;
	setStartError: (error: Error | null) => void;
}

function harness(name: string, calls: string[]): Harness {
	let health: string | null = null;
	let startError: Error | null = null;
	return {
		calls,
		setHealth: (reason) => {
			health = reason;
		},
		setStartError: (error) => {
			startError = error;
		},
		component: {
			name,
			start: async () => {
				calls.push(`start:${name}`);
				if (startError) throw startError;
			},
			stop: async () => {
				calls.push(`stop:${name}`);
			},
			check: async () => {
				calls.push(`check:${name}`);
				return health;
			},
		},
	};
}

/** 让决策即时执行，避免测试里真的等待退避。 */
function instantOptions(now: { value: number }) {
	return {
		policy: DEFAULT_RESTART_POLICY,
		now: () => now.value,
		sleep: async (ms: number) => {
			now.value += ms;
		},
	};
}

describe("Supervisor", () => {
	it("starts components in declaration order", async () => {
		const calls: string[] = [];
		const host = harness("desktop-host", calls);
		const client = harness("client", calls);
		const helper = harness("session-helper", calls);
		const supervisor = new Supervisor(
			[host.component, client.component, helper.component],
			instantOptions({ value: 0 }),
		);
		await supervisor.start();
		expect(calls).toEqual([
			"start:desktop-host",
			"start:client",
			"start:session-helper",
		]);
		expect(supervisor.status().every((entry) => entry.state === "running")).toBe(true);
	});

	it("rolls back already-started components when one fails to start", async () => {
		const calls: string[] = [];
		const host = harness("desktop-host", calls);
		const client = harness("client", calls);
		client.setStartError(new Error("client 启动失败"));
		const supervisor = new Supervisor(
			[host.component, client.component],
			instantOptions({ value: 0 }),
		);
		await expect(supervisor.start()).rejects.toThrow("client 启动失败");
		// 已启动的组件必须逆序停掉，不能留下半启动的系统。
		expect(calls).toEqual(["start:desktop-host", "start:client", "stop:desktop-host"]);
	});

	it("restarts an unhealthy component after the backoff delay", async () => {
		const calls: string[] = [];
		const now = { value: 0 };
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], instantOptions(now));
		await supervisor.start();
		calls.length = 0;

		client.setHealth("注册心跳超时");
		const report = await supervisor.runHealthCheck();

		expect(calls).toEqual(["check:client", "stop:client", "start:client"]);
		expect(report[0]).toMatchObject({
			name: "client",
			state: "running",
			attempts: 1,
			lastError: null,
		});
		// 第一次退避是 1s。
		expect(now.value).toBe(1_000);
	});

	it("gives up and reports a failed component instead of looping forever", async () => {
		const calls: string[] = [];
		const now = { value: 0 };
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], instantOptions(now));
		await supervisor.start();
		client.setHealth("一直不健康");

		let report = await supervisor.runHealthCheck();
		for (let index = 0; index < DEFAULT_RESTART_POLICY.maxRestarts; index += 1) {
			report = await supervisor.runHealthCheck();
		}
		expect(report[0]?.state).toBe("failed");
		expect(report[0]?.attempts).toBeGreaterThan(DEFAULT_RESTART_POLICY.maxRestarts);
		expect(report[0]?.lastError).toBe("一直不健康");
		// 放弃后不得再拉起。
		const before = calls.length;
		report = await supervisor.runHealthCheck();
		expect(calls.length).toBe(before);
		expect(report[0]?.state).toBe("failed");
	});

	it("resets the retry budget after a stable run", async () => {
		const calls: string[] = [];
		const now = { value: 0 };
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], instantOptions(now));
		await supervisor.start();
		client.setHealth("崩溃");
		await supervisor.runHealthCheck();
		expect(supervisor.status()[0]?.attempts).toBe(1);

		// 稳定运行超过窗口后再崩溃：计数清零，重新从第一次退避开始。
		now.value += DEFAULT_RESTART_POLICY.stableWindowMs + 1;
		client.setHealth("后来又崩溃");
		const report = await supervisor.runHealthCheck();
		expect(report[0]?.attempts).toBe(1);
	});

	it("leaves healthy components untouched", async () => {
		const calls: string[] = [];
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], instantOptions({ value: 0 }));
		await supervisor.start();
		calls.length = 0;
		const report = await supervisor.runHealthCheck();
		expect(calls).toEqual(["check:client"]);
		expect(report[0]).toMatchObject({ state: "running", attempts: 0 });
	});

	it("treats an unreachable health check as unhealthy rather than healthy", async () => {
		const calls: string[] = [];
		const client = harness("client", calls);
		// 检查本身抛错（IPC 不可达）：绝不能当成“健康”。
		client.component.check = async () => {
			calls.push("check:client");
			throw new Error("IPC 不可达");
		};
		const supervisor = new Supervisor([client.component], instantOptions({ value: 0 }));
		await supervisor.start();
		const report = await supervisor.runHealthCheck();
		expect(report[0]?.attempts).toBe(1);
	});

	it("stops components in reverse order and is idempotent", async () => {
		const calls: string[] = [];
		const host = harness("desktop-host", calls);
		const client = harness("client", calls);
		const supervisor = new Supervisor(
			[host.component, client.component],
			instantOptions({ value: 0 }),
		);
		await supervisor.start();
		calls.length = 0;
		await supervisor.stop();
		expect(calls).toEqual(["stop:client", "stop:desktop-host"]);
		await supervisor.stop();
		expect(calls).toEqual(["stop:client", "stop:desktop-host"]);
		expect(supervisor.status().every((entry) => entry.state === "stopped")).toBe(true);
	});

	it("does not run health checks after being stopped", async () => {
		const calls: string[] = [];
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], instantOptions({ value: 0 }));
		await supervisor.start();
		await supervisor.stop();
		calls.length = 0;
		const report = await supervisor.runHealthCheck();
		expect(calls).toEqual([]);
		expect(report[0]?.state).toBe("stopped");
	});

	it("keeps supervising other components when one has failed", async () => {
		const calls: string[] = [];
		const host = harness("desktop-host", calls);
		const client = harness("client", calls);
		const supervisor = new Supervisor(
			[host.component, client.component],
			instantOptions({ value: 0 }),
		);
		await supervisor.start();
		client.setHealth("坏掉了");
		for (let index = 0; index <= DEFAULT_RESTART_POLICY.maxRestarts; index += 1) {
			await supervisor.runHealthCheck();
		}
		calls.length = 0;
		host.setHealth("一并检查");
		await supervisor.runHealthCheck();
		// 一个组件放弃后仍必须继续检查其它组件。
		expect(calls).toContain("check:desktop-host");
	});

	it("rejects an empty component list", () => {
		expect(() => new Supervisor([], instantOptions({ value: 0 }))).toThrow();
	});

	it("rejects duplicate component names", () => {
		const calls: string[] = [];
		const a = harness("client", calls);
		const b = harness("client", calls);
		expect(
			() => new Supervisor([a.component, b.component], instantOptions({ value: 0 })),
		).toThrow();
	});

	it("logs lifecycle transitions with stable identifiers", async () => {
		const calls: string[] = [];
		const log = vi.fn();
		const client = harness("client", calls);
		const supervisor = new Supervisor([client.component], {
			...instantOptions({ value: 0 }),
			log,
		});
		await supervisor.start();
		client.setHealth("心跳缺失");
		await supervisor.runHealthCheck();
		expect(log).toHaveBeenCalled();
		const messages = log.mock.calls.map((call) => String(call[0])).join("\n");
		expect(messages).toContain("client");
		// 日志不得包含健康检查的原始异常内容以外的敏感信息。
		expect(messages).not.toContain("token");
	});
});
