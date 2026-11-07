/**
 * 服务端优雅停机闸门:停止新派发并等待运行中 Job 与 Agent Run 收敛。
 * 详见 docs/design/release-and-update.md 与 ADR-0041。
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
	 * 置闸门并等待所有 running job 收敛为终态。
	 *
	 * 收敛集合只算 `running`：
	 * - `waiting_input` 是「上传会话等调用方补齐字节」的业务等待，从未派发、
	 *   不占 Client，也不会有 Job 侧回调推进它；算进集合会让一条被弃置的上传
	 *   会话无限期拖住发布（2026-11-06 生产：一条 11-02 创建的 file.import 停在
	 *   waiting_input，直接卡死 0.22.3 的服务端更新，最后靠人工 cancel 才解开）。
	 * - AgentRun 不计 `disconnected`：该状态表示 Client 已离线，不会自行收敛，
	 *   由对账流程收尾；留在集合里只会永久阻塞。
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
				// 普通 Job 与 Agent Run 都要收敛:解耦后 Agent 执行不再写 Job,
				// 只查 Job 会让发布在活跃 Agent 回合上直接切换。
				const [runningJobs, runningRuns] = await Promise.all([
					this.prisma.job.count({ where: { status: "running" } }),
					this.prisma.agentRun.count({
						where: { status: { in: ["pending", "running", "waiting_input"] } },
					}),
				]);
				const running = runningJobs + runningRuns;
				if (running === 0) return;
				if (Date.now() >= deadline) {
					// 带上现场再抛：只报数字时排障得自己翻库。2026-11-03 与
					// 2026-11-06 两次发版都卡在这里，靠人工 jobs list 才定位到僵尸。
					const detail = await this.describeBlockers(runningJobs);
					throw new Error(
						`等待 job 收敛超时(仍有 ${running} 个运行中)${detail}`,
					);
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

	/** 超时现场：最多 5 条 running Job 的 id/类型/Client/已运行时长。 */
	private async describeBlockers(runningJobs: number): Promise<string> {
		const jobs = await this.prisma.job.findMany({
			where: { status: "running" },
			select: {
				id: true,
				type: true,
				clientId: true,
				startedAt: true,
				createdAt: true,
			},
			orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
			take: 5,
		});
		if (jobs.length === 0) return "";
		const now = Date.now();
		const rows = jobs.map((job) => {
			const since = (job.startedAt ?? job.createdAt).getTime();
			const minutes = Math.max(0, Math.round((now - since) / 60_000));
			return `${job.id}(${job.type}@${job.clientId}, 已运行 ${minutes} 分钟)`;
		});
		const suffix = runningJobs > jobs.length ? " 等" : "";
		return `: ${rows.join("、")}${suffix}`;
	}
}
