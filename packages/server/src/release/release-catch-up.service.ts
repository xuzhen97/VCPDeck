import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ReleaseOrchestrator } from "./release.orchestrator.js";

/** 周期对账调度依赖（测试注入；缺省用真实 setInterval 与 Logger）。 */
export interface ReleaseCatchUpOptions {
	/** 对账间隔(ms)；缺省 5 分钟，传 0 禁用周期任务。 */
	sweepIntervalMs?: number;
	/** 定时器注入（测试用）；缺省使用真实 setInterval。 */
	schedule?: (delayMs: number, run: () => void) => CatchUpScheduleHandle;
	/** 日志注入（测试用）；缺省使用 Logger。 */
	log?: (msg: string) => void;
}

/** 可取消的定时器句柄。 */
export interface CatchUpScheduleHandle {
	cancel(): void;
}

/** 周期对账默认间隔：5 分钟。 */
export const RELEASE_CATCH_UP_INTERVAL_MS = 5 * 60_000;

/**
 * 客户端补更的周期对账。
 *
 * 补更原先只由「客户端重连注册」触发，因此一台失败后持续在线、不再重连的客户端
 * 永远不会被重试。本服务提供第二个驱动力：周期性对当前补更目标重跑客户端阶段。
 *
 * 过滤与互斥都在编排器内（`canRetryClientUpdate` 与 `runClientPhase`），本服务
 * 只负责节奏与生命周期，不重复实现判定规则。
 */
@Injectable()
export class ReleaseCatchUpService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(ReleaseCatchUpService.name);
	private readonly intervalMs: number;
	private readonly schedule: (
		delayMs: number,
		run: () => void,
	) => CatchUpScheduleHandle;
	private readonly log: (msg: string) => void;
	private timer: CatchUpScheduleHandle | null = null;

	constructor(
		@Inject(ReleaseOrchestrator)
		private readonly orchestrator: ReleaseOrchestrator,
		@Optional() options: ReleaseCatchUpOptions = {},
	) {
		this.intervalMs = options.sweepIntervalMs ?? RELEASE_CATCH_UP_INTERVAL_MS;
		this.schedule =
			options.schedule ??
			((delayMs, run) => {
				const timer = setInterval(run, delayMs);
				// 不阻止进程退出。
				(timer as { unref?: () => void }).unref?.();
				return { cancel: () => clearInterval(timer) };
			});
		this.log = options.log ?? ((msg) => this.logger.log(msg));
	}

	onModuleInit(): void {
		if (this.intervalMs <= 0) return;
		this.timer = this.schedule(this.intervalMs, () => {
			void this.sweep();
		});
	}

	onModuleDestroy(): void {
		this.timer?.cancel();
		this.timer = null;
	}

	/** 执行一次对账；任何异常只记录日志，不影响 Server 主流程与后续周期。 */
	async sweep(): Promise<void> {
		try {
			await this.orchestrator.sweepCatchUp();
		} catch (e) {
			this.log(
				`客户端补更对账失败: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}
}
