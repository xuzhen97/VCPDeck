/**
 * 进程监管的重启策略（纯逻辑，无计时器与进程依赖）。
 *
 * 这里的取值与既有 `Daemon` 的崩溃退避语义保持一致（`MAX_CRASH_RETRIES` /
 * `STABLE_WINDOW_MS` / `min(1000·2^(n-1), 30_000)`），抽出来是为了让
 * Supervisor 的多组件监管复用同一套已验证的退避规则，而不是各写一份。
 */

export interface RestartPolicy {
	/** 连续崩溃达到该次数后放弃拉起。 */
	maxRestarts: number;
	/** 运行满此时长视为稳定，崩溃计数清零。 */
	stableWindowMs: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
	maxRestarts: 5,
	stableWindowMs: 30_000,
	backoffBaseMs: 1_000,
	backoffMaxMs: 30_000,
};

export type RestartDecision =
	| { action: "restart"; attempt: number; delayMs: number }
	| { action: "give-up"; attempt: number };

/**
 * 依据历史崩溃次数与上次运行的持续时长决定下一步。
 *
 * 稳定运行超过窗口就清零历史：否则一个健康运行数月的服务偶尔连续崩溃几次，
 * 会被历史计数直接推到放弃阈值而不再拉起。
 */
export function decideRestart(
	policy: RestartPolicy,
	previousAttempts: number,
	ranForMs: number,
): RestartDecision {
	const baseline = ranForMs > policy.stableWindowMs ? 0 : previousAttempts;
	const attempt = baseline + 1;
	if (attempt > policy.maxRestarts) {
		return { action: "give-up", attempt };
	}
	const delayMs = Math.min(
		policy.backoffBaseMs * 2 ** (attempt - 1),
		policy.backoffMaxMs,
	);
	return { action: "restart", attempt, delayMs };
}
