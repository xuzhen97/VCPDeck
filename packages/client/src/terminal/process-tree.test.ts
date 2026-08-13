import { describe, expect, it, vi } from "vitest";
import { killProcessTree } from "./process-tree.js";

describe("killProcessTree（Windows）", () => {
	it("以参数数组调用 taskkill /T /F", async () => {
		let called = false;
		const env = {
			platform: "win32" as const,
			killGroupSignal: () => true,
			runTaskkill: async (pid: number) => {
				called = true;
				expect(pid).toBe(1234);
				return 0;
			},
		};
		await killProcessTree(1234, env);
		expect(called).toBe(true);
	});
});

describe("killProcessTree（POSIX）", () => {
	it("先 SIGTERM 进程组再 SIGKILL 兜底", async () => {
		const signals: Array<[number, NodeJS.Signals]> = [];
		const env = {
			platform: "linux" as const,
			killGroupSignal: (pid: number, sig: NodeJS.Signals) => {
				signals.push([pid, sig]);
				return true;
			},
			runTaskkill: async () => 0,
		};
		await killProcessTree(999, env);
		expect(signals).toEqual([
			[-999, "SIGTERM"],
			[-999, "SIGKILL"],
		]);
	});

	it("进程组已退出时静默成功", async () => {
		const env = {
			platform: "linux" as const,
			killGroupSignal: () => {
				throw new Error("ESRCH");
			},
			runTaskkill: async () => 0,
		};
		await expect(killProcessTree(999, env)).resolves.toBeUndefined();
	});

	it("使用真实 setTimeout 时不会抛出（集成冒烟）", async () => {
		vi.useRealTimers();
		const env = {
			platform: "linux" as const,
			killGroupSignal: () => true,
			runTaskkill: async () => 0,
		};
		await expect(killProcessTree(999, env)).resolves.toBeUndefined();
	});
});
