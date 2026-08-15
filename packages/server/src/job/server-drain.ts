/**
 * 服务端优雅停机闸门：停止新派发并等待运行中 job 收敛。
 * 详见 docs/self-update-release-design.md §7.4。
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
	 * 置闸门并等待所有 running/waiting_input job 收敛为终态。
	 * 超时抛错（不解除闸门；此时进程即将被 launcher 接管）。
	 */
	async drain(timeoutMs = this.timeoutMs): Promise<void> {
		this.draining = true;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const running = await this.prisma.job.count({
				where: { status: { in: ["running", "waiting_input"] } },
			});
			if (running === 0) return;
			if (Date.now() >= deadline) {
				throw new Error(`等待 job 收敛超时（仍有 ${running} 个运行中）`);
			}
			await sleep(this.pollIntervalMs);
		}
	}
}
