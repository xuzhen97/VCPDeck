/**
 * 多组件进程监管（Task 14 核心）。
 *
 * 与既有的单构件 `Daemon` 的关系：`Daemon` 负责一个构件的版本切换、探活与回退；
 * `Supervisor` 在其之上统一启动、监控与重启**多个**组件（TypeScript Client、
 * Rust Desktop Host、活动用户 Session Helper），复用同一套已验证的退避策略。
 *
 * 这里刻意只依赖注入进来的 `start/stop/check` 与注入的时钟，因此可以在没有真实
 * 进程与真实系统服务的前提下被完整测试；平台注册（Windows Service / systemd）
 * 属于后续平台工作，不在这里假装完成。
 */

import {
	DEFAULT_RESTART_POLICY,
	decideRestart,
	type RestartPolicy,
} from "./supervision-policy.js";

export interface SupervisedComponent {
	/** 组件名；必须唯一，用于日志与状态上报。 */
	readonly name: string;
	/** 启动组件。返回后表示进程已派生，不代表已健康。 */
	start(): Promise<void>;
	/** 停止组件；必须可重复调用。 */
	stop(): Promise<void>;
	/**
	 * 健康检查。
	 *
	 * 返回 `null` 表示健康；返回字符串表示不健康的原因。抛出异常同样视为不健康
	 * ——检查本身不可达时绝不能被当成健康。
	 */
	check(): Promise<string | null>;
}

export type ComponentState = "idle" | "running" | "restarting" | "failed" | "stopped";

export interface ComponentStatus {
	name: string;
	state: ComponentState;
	/** 连续失败次数；稳定运行后会清零。 */
	attempts: number;
	lastError: string | null;
	startedAtMs: number | null;
}

export interface SupervisorOptions {
	policy?: RestartPolicy;
	/** 注入时钟；测试用它避免真实等待。 */
	now?: () => number;
	/** 注入等待；测试用它避免真实等待。 */
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string) => void;
}

interface Entry {
	component: SupervisedComponent;
	state: ComponentState;
	attempts: number;
	lastError: string | null;
	startedAtMs: number | null;
}

export class Supervisor {
	private readonly entries: Entry[];
	private readonly policy: RestartPolicy;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly log: (message: string) => void;
	private running = false;

	constructor(components: readonly SupervisedComponent[], options: SupervisorOptions = {}) {
		if (components.length === 0) {
			throw new Error("Supervisor 至少需要一个组件");
		}
		const names = new Set<string>();
		for (const component of components) {
			if (names.has(component.name)) {
				throw new Error(`Supervisor 组件名重复: ${component.name}`);
			}
			names.add(component.name);
		}
		this.entries = components.map((component) => ({
			component,
			state: "idle",
			attempts: 0,
			lastError: null,
			startedAtMs: null,
		}));
		this.policy = options.policy ?? DEFAULT_RESTART_POLICY;
		this.now = options.now ?? (() => Date.now());
		this.sleep =
			options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.log = options.log ?? (() => undefined);
	}

	/**
	 * 按声明顺序启动全部组件。
	 *
	 * 任一组件启动失败时，逆序停掉已经启动成功的组件再抛出：不允许留下
	 * “一半启动”的系统状态。
	 */
	async start(): Promise<void> {
		if (this.running) throw new Error("Supervisor 已经启动");
		const started: Entry[] = [];
		try {
			for (const entry of this.entries) {
				await entry.component.start();
				entry.state = "running";
				entry.attempts = 0;
				entry.lastError = null;
				entry.startedAtMs = this.now();
				started.push(entry);
				this.log(`[supervisor] ${entry.component.name} 已启动`);
			}
			this.running = true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : "启动失败";
			this.log(`[supervisor] 启动失败，正在回滚: ${reason}`);
			for (const entry of [...started].reverse()) {
				try {
					await entry.component.stop();
				} catch {
					// 回滚必须尽力而为，不能因为停止失败而掩盖原始错误。
				}
				entry.state = "stopped";
			}
			throw error;
		}
	}

	/** 逆序停止全部组件；可重复调用。 */
	async stop(): Promise<void> {
		this.running = false;
		for (const entry of [...this.entries].reverse()) {
			if (entry.state === "stopped" || entry.state === "idle") continue;
			try {
				await entry.component.stop();
			} catch {
				// 停止失败不阻塞其它组件的停止。
			}
			entry.state = "stopped";
			this.log(`[supervisor] ${entry.component.name} 已停止`);
		}
	}

	/**
	 * 执行一轮健康检查并按策略恢复。
	 *
	 * 已放弃（`failed`）或已停止的组件会被跳过，不重复检查也不重复拉起。
	 */
	async runHealthCheck(): Promise<ComponentStatus[]> {
		for (const entry of this.entries) {
			if (!this.running) break;
			if (entry.state !== "running" && entry.state !== "restarting") continue;

			let reason: string | null;
			try {
				reason = await entry.component.check();
			} catch (error) {
				reason = error instanceof Error ? error.message : "健康检查失败";
			}
			if (reason === null) {
				entry.lastError = null;
				continue;
			}

			const ranForMs =
				entry.startedAtMs === null ? 0 : this.now() - entry.startedAtMs;
			const decision = decideRestart(this.policy, entry.attempts, ranForMs);
			if (decision.action === "give-up") {
				entry.state = "failed";
				entry.attempts = decision.attempt;
				entry.lastError = reason;
				this.log(
					`[supervisor] ${entry.component.name} 连续失败已达上限，放弃拉起: ${reason}`,
				);
				continue;
			}

			entry.state = "restarting";
			entry.attempts = decision.attempt;
			this.log(
				`[supervisor] ${entry.component.name} 不健康（第 ${decision.attempt} 次），${decision.delayMs}ms 后重启: ${reason}`,
			);
			await this.sleep(decision.delayMs);
			try {
				await entry.component.stop();
			} catch {
				// 已经退出的进程停止失败不影响重新拉起。
			}
			try {
				await entry.component.start();
			} catch (error) {
				const startReason = error instanceof Error ? error.message : "重启失败";
				entry.state = "failed";
				entry.lastError = startReason;
				this.log(`[supervisor] ${entry.component.name} 重启失败: ${startReason}`);
				continue;
			}
			entry.state = "running";
			entry.startedAtMs = this.now();
			entry.lastError = null;
		}
		return this.status();
	}

	/** 当前各组件状态快照。 */
	status(): ComponentStatus[] {
		return this.entries.map((entry) => ({
			name: entry.component.name,
			state: entry.state,
			attempts: entry.attempts,
			lastError: entry.lastError,
			startedAtMs: entry.startedAtMs,
		}));
	}
}
