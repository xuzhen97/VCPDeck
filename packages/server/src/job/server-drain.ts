/**
 * 服务端优雅停机闸门：停止新派发并等待运行中 job 收敛。
 * 详见 docs/design/release-and-update.md。
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

export interface ServerDrainOptions {
	/** 轮询间隔（ms），默认 1000 */
	pollIntervalMs?: number;
	/** 收敛等待上限（ms），默认 10 分钟 */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class ServerDrain {
	private draining = false;
	/** 标记本次 drain 因超时失败,finally 中据此解除闸门(成功路径保持)。 */
	private failedToConverge = false;
	private readonly pollIntervalMs: number;
	private readonly timeoutMs: number;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		// 可调参数不是 DI 依赖
		@Optional() options: ServerDrainOptions = {},
	) {
		this.pollIntervalMs = options.pollIntervalMs ?? 1000;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** 是否处于停机收敛中（JobScheduler 据此拒绝新派发） */
	isDraining(): boolean {
		return this.draining;
	}

	/**
	 * 显式解除闸门，恢复 Job 派发。
	 *
	 * 供编排器在 drain 成功后的后续步骤（broadcastShutdown/applyUpdate）
	 * 失败时调用：进程仍存活，闸门不解除就会永久拒绝派发。
	 */
	release(): void {
		this.draining = false;
		this.failedToConverge = false;
	}

	/**
	 * 置闸门并等待所有 running/waiting_input job 收敛为终态。
	 *
	 * 优雅停机是「临时状态」，不是「失败状态」：drain 只应该在成功返回时
	 * 保持闸门（此时进程即将被 launcher 接管，闸门无意义）。超时抛错时
	 * **必须自动解除闸门**，否则编排器只把 Release 标为 failed、进程继续
	 * 存活，`JobScheduler.tryDispatch` 会永远拒绝派发 —— Server 进入只有
	 * 重启才能恢复的降级态（2026-10-07 生产事故：发布失败后全部 Job 静默
	 * 卡在 pending）。
	 */
	async drain(timeoutMs = this.timeoutMs): Promise<void> {
		this.draining = true;
		try {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const running = await this.prisma.job.count({
					where: { status: { in: ["running", "waiting_input"] } },
				});
				if (running === 0) return;
				if (Date.now() >= deadline) {
					throw new Error(`等待 job 收敛超时(仍有 ${running} 个运行中)`);
				}
				await sleep(this.pollIntervalMs);
			}
		} catch (e) {
			// 任何失败出口(超时、DB 查询异常等)都要在 finally 里恢复派发;
			// 成功 return 不经过这里,闸门保持给 apply 前的停止窗口。
			this.failedToConverge = true;
			throw e;
		} finally {
			// 抛错路径（超时或意外异常）必须恢复派发：闸门是进程内状态，
			// 进程不死它就一直在。成功返回时闸门保持 —— 编排器在成功后
			// 立即 broadcastShutdown + applyUpdate，闸门仍需在停止前拒绝新 Job。
			if (this.failedToConverge) this.release();
		}
	}
}
