import { describe, expect, it } from "vitest";
import { DEFAULT_RESTART_POLICY, decideRestart } from "./supervision-policy.js";

describe("decideRestart", () => {
	it("backs off exponentially from the first crash", () => {
		const first = decideRestart(DEFAULT_RESTART_POLICY, 0, 100);
		expect(first).toEqual({ action: "restart", attempt: 1, delayMs: 1_000 });
		expect(decideRestart(DEFAULT_RESTART_POLICY, 1, 100)).toEqual({
			action: "restart",
			attempt: 2,
			delayMs: 2_000,
		});
		expect(decideRestart(DEFAULT_RESTART_POLICY, 2, 100)).toEqual({
			action: "restart",
			attempt: 3,
			delayMs: 4_000,
		});
	});

	it("caps the backoff delay for a policy with a larger retry budget", () => {
		// 默认策略下最大退避是 1000·2⁴ = 16s，尚未触及 30s 封顶；
		// 封顶是为了防止自定义的更大重试预算把退避拉到不可接受的长度。
		const patient = { ...DEFAULT_RESTART_POLICY, maxRestarts: 10 };
		expect(decideRestart(DEFAULT_RESTART_POLICY, 4, 100)).toEqual({
			action: "restart",
			attempt: 5,
			delayMs: 16_000,
		});
		// 2⁵ = 32s 会被封到 30s。
		expect(decideRestart(patient, 5, 100)).toEqual({
			action: "restart",
			attempt: 6,
			delayMs: 30_000,
		});
		expect(decideRestart(patient, 8, 100).action).toBe("restart");
		expect(decideRestart(patient, 8, 100)).toEqual({
			action: "restart",
			attempt: 9,
			delayMs: 30_000,
		});
	});

	it("gives up once the retry budget is exhausted", () => {
		const decision = decideRestart(DEFAULT_RESTART_POLICY, 5, 100);
		expect(decision.action).toBe("give-up");
	});

	it("resets history after a stable run so a healthy service is not eventually abandoned", () => {
		// 已稳定运行超过窗口：历史清零，本次按“第一次崩溃”处理。
		const decision = decideRestart(DEFAULT_RESTART_POLICY, 5, 60_000);
		expect(decision).toEqual({ action: "restart", attempt: 1, delayMs: 1_000 });
	});

	it("treats exactly the stable window as not yet stable", () => {
		// 边界必须与既有实现一致：大于窗口才清零。
		expect(decideRestart(DEFAULT_RESTART_POLICY, 3, 30_000)).toEqual({
			action: "restart",
			attempt: 4,
			delayMs: 8_000,
		});
		expect(decideRestart(DEFAULT_RESTART_POLICY, 3, 30_001)).toEqual({
			action: "restart",
			attempt: 1,
			delayMs: 1_000,
		});
	});

	it("honours a custom policy", () => {
		const strict = {
			maxRestarts: 1,
			stableWindowMs: 1_000,
			backoffBaseMs: 250,
			backoffMaxMs: 500,
		};
		expect(decideRestart(strict, 0, 0)).toEqual({ action: "restart", attempt: 1, delayMs: 250 });
		expect(decideRestart(strict, 1, 0).action).toBe("give-up");
	});
});
