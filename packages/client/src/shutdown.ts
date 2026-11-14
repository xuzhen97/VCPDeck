/**
 * Client 进程级停机编排（ADR-0065）。
 *
 * 超时阶梯固定为 资源释放 8s < Launcher 强杀 10s < procd term_timeout 15s，
 * 任何一处单独改大或改小都会让另一层先动手，因此集中在这里定义。
 */

/** 停机超时阶梯；单位毫秒。 */
export const SHUTDOWN_TIMEOUTS = Object.freeze({
	/** 单个受管资源的释放上限，必须短于 Launcher 的 SIGKILL 等待。 */
	resourcesMs: 8_000,
	/** Launcher 等 Client 退出的上限，必须短于 procd 的 term_timeout。 */
	launcherGraceMs: 10_000,
	/** procd 服务定义的 term_timeout。 */
	procdTermMs: 15_000,
});

/**
 * 并发释放所有受管资源：单项失败或超时都不影响其它项收敛。
 * @param actions 释放动作列表
 * @param timeoutMs 单项超时；默认取 {@link SHUTDOWN_TIMEOUTS}.resourcesMs
 */
export async function shutdownManagedResources(
	actions: readonly (() => Promise<void>)[],
	timeoutMs: number = SHUTDOWN_TIMEOUTS.resourcesMs,
): Promise<void> {
	await Promise.allSettled(
		actions.map(async (action) => {
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					Promise.resolve().then(action),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, timeoutMs);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}),
	);
}

/**
 * 生成幂等的停机入口：重复信号只执行一次真实释放。
 * @param factory 延迟构造释放动作，避免在信号到来前就冻结资源列表
 * @param timeoutMs 单项超时
 */
export function createShutdownRunner(
	factory: () => readonly (() => Promise<void>)[],
	timeoutMs: number = SHUTDOWN_TIMEOUTS.resourcesMs,
): () => Promise<void> {
	let pending: Promise<void> | undefined;
	return () => {
		pending ??= shutdownManagedResources(factory(), timeoutMs);
		return pending;
	};
}
