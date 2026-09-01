/** @file FRP 恢复编排服务 — Server/Client/Dashboard 三方比较与有限恢复（system:frp-reconcile） */

import {
	Inject,
	Injectable,
	Optional,
	type OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
	parseFrpCapabilityStatus,
	parseFrpReconcileResult,
	parseFrpRuntimeStateReport,
	type DispatchPayload,
	type FrpMappingStatus,
	type FrpReconcilePayload,
	type FrpReconcileResult,
	type FrpRuntimeStateAck,
	type FrpRuntimeStateReport,
} from "@vcpdeck/shared";
import { PrismaService } from "../prisma/prisma.service.js";
import { FrpsInstancesService } from "./frp-instances.service.js";

/** 参与自动恢复的映射状态（provisioning/deleting/error 永远排除）。 */
const RECOVERABLE_STATUSES: readonly string[] = ["active", "inactive", "reconciling"];
const EXCLUDED_STATUSES: readonly string[] = ["provisioning", "deleting", "error"];
/** reconcile Job 超时（秒）；与重试槽位 5s/30s 共同约束单轮周期。 */
const RECONCILE_JOB_TIMEOUT_SECONDS = 30;
/** 安全失败信息（不泄露 Token/TOML/stderr/原始外部响应）。 */
const SAFE_RECONCILE_FAILED_MESSAGE = "FRP 映射恢复未通过双重确认";

/** 定时器句柄（真实 setTimeout 句柄；测试注入环境可为 undefined）。 */
type ScheduleHandle = ReturnType<typeof setTimeout> | undefined;

/** reconcile 调度依赖（测试注入；缺省用真实 setTimeout 与 console）。 */
interface ReconcileScheduleDeps {
	/** 重试延迟（ms）：[0, 5000, 30000]（首次立即，之后 5s/30s 两个槽位）。 */
	delays?: [number, number, number];
	/** 定时器注入（测试用）；缺省使用真实 setTimeout。 */
	schedule?: (delayMs: number, run: () => void) => ScheduleHandle;
	/** 日志注入（测试用）；缺省使用 console。 */
	log?: (msg: string) => void;
	/** 双重确认有界等待预算（ms）；覆盖 frpc 建连窗口，缺省 3000。 */
	confirmWaitMs?: number;
}

/** FrpMapping 行的最小读模型（避免耦合生成类型字段全集）。 */
interface FrpMappingRow {
	id: string;
	clientId: string;
	frpsInstanceId: string | null;
	name: string;
	proxyType: string;
	localIp: string;
	localPort: number;
	remotePort: number | null;
	customDomain: string | null;
	status: string;
	errorCode: string | null;
	errorMessage: string | null;
}

/** reconcile 目标（取自 SQLite 期望集合的完整配置，用于构造 TOML 快照）。 */
interface ReconcileTarget {
	id: string;
	name: string;
	proxyType: string;
	localIp: string;
	localPort: number;
	remotePort: number | null;
	customDomain: string | null;
}

/** 每 Client 的恢复周期上下文（socket lease 内）。 */
interface ReconcileContext {
	clientId: string;
	socketId: string;
	connectionGeneration: string;
	owner: "server" | "client";
	frpsInstanceId: string;
	/** 本轮目标（期望集合，不含排除状态）。 */
	targets: ReconcileTarget[];
	/** 当前在途 reconcile Job（owner=server 时）。 */
	currentJobId: string | null;
	/** 最近一次 Client 本地成功（running）结果的 runtime generation。 */
	lastRunningGeneration: number | null;
	/** 首次尝试的期望 runtime generation（触发上报的 generation + 1）。 */
	baseExpectedGeneration: number;
	/** 已通过 Dashboard 双重确认的目标 id。 */
	confirmedIds: string[];
	/** 已派发尝试次数（attempt = min(dispatchCount, 2)）。 */
	dispatchCount: number;
	/** 重试槽位 timer（5s/30s）。 */
	slots: ScheduleHandle[];
}

function mappingKey(name: string, localPort: number, remotePort: number | null): string {
	return `${name}@${localPort}:${remotePort ?? "-"}`;
}

@Injectable()
export class FrpReconciliationService implements OnModuleDestroy {
	private readonly contexts = new Map<string, ReconcileContext>();
	private readonly leases = new Map<string, { connectionGeneration: string }>();
	private readonly delays: [number, number, number];
	private readonly schedule: (delayMs: number, run: () => void) => ScheduleHandle;
	private readonly log: (msg: string) => void;
	private readonly confirmWaitMs: number;
	private dispatcher: ((socketId: string, dispatch: DispatchPayload) => void) | null =
		null;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(FrpsInstancesService)
		private readonly instances: FrpsInstancesService,
		@Optional() deps: ReconcileScheduleDeps = {},
	) {
		this.delays = deps.delays ?? [0, 5_000, 30_000];
		this.schedule =
			deps.schedule ??
			((delayMs, run) => {
				const timer = setTimeout(run, delayMs);
				// 不阻止进程退出。
				(timer as { unref?: () => void }).unref?.();
				return timer;
			});
		this.log = deps.log ?? ((msg) => console.log(`[frp-reconcile] ${msg}`));
		this.confirmWaitMs = deps.confirmWaitMs ?? 3_000;
	}

	onModuleDestroy(): void {
		for (const ctx of this.contexts.values()) this.cancelSlots(ctx);
		this.contexts.clear();
		this.leases.clear();
	}

	/** 绑定精确 socketId 派发通道（gateway afterInit 注入）。 */
	bindDispatcher(dispatcher: (socketId: string, dispatch: DispatchPayload) => void): void {
		this.dispatcher = dispatcher;
	}

	/** 该 Client 是否处于恢复周期（create/delete 据此稳定返回 409）。 */
	isBusy(clientId: string): boolean {
		return this.contexts.has(clientId);
	}

	/** create/delete 前置守卫：恢复期间拒绝写操作（FRP_RECONCILE_BUSY / 409）。 */
	assertWritable(clientId: string): void {
		if (this.isBusy(clientId)) {
			throw Object.assign(new Error("FRP 映射正在恢复"), {
				code: "FRP_RECONCILE_BUSY",
				statusCode: 409,
			});
		}
	}

	/** Server 启动恢复：把中断遗留的 reconciling 映射回到 inactive（不读 Client、不创建 Job）。 */
	async recoverInterrupted(): Promise<void> {
		await this.prisma.frpMapping.updateMany({
			where: { status: "reconciling" },
			data: { status: "inactive", operationJobId: null, errorCode: null, errorMessage: null },
		});
	}

	/** 处理 Client → Server 的 FRP 状态上报；返回严格确认 ack。 */
	async handleState(
		clientId: string,
		socketId: string,
		raw: unknown,
	): Promise<FrpRuntimeStateAck> {
		let report: FrpRuntimeStateReport;
		try {
			report = parseFrpRuntimeStateReport(raw);
		} catch {
			const safeGen = this.extractGeneration(raw);
			this.log(`拒绝无效 FRP 状态上报 (client=${clientId})`);
			return { connectionGeneration: safeGen, accepted: false, action: "stale" };
		}
		if (report.clientId !== clientId) {
			return {
				connectionGeneration: report.connectionGeneration,
				accepted: false,
				action: "stale",
			};
		}

		// 连接代次租约：不同代次 = 新连接接管（旧周期安全终止，旧 Job 安全失败）；
		// 同代次重复上报继续处理。旧 socket 的结果/Job 在下方按租约与 currentJobId 双重校验拒绝。
		const lease = this.leases.get(clientId);
		if (lease && lease.connectionGeneration !== report.connectionGeneration) {
			this.cancelCycle(clientId, "connection-generation-takeover");
		}
		this.leases.set(clientId, { connectionGeneration: report.connectionGeneration });

		// capability 门：只有 protocol v1 且可用的 Client 进入新流程。
		const client = await this.prisma.client.findUnique({
			where: { id: clientId },
		});
		if (!this.hasReconcileCapability(client)) {
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}

		// 同代次已有在途 Server 周期（Job 未结算）：不重启新周期 ——
		// 等待在途 Job 结果（handleLocalResult 确认）/ 重试槽位 / 断连收敛，
		// 避免“派发→Client 重启 frpc→状态上报→再派发”的循环（frpc 重启窗口内上报会误判未确认）。
		const inFlightServer = this.contexts.get(clientId);
		if (
			inFlightServer &&
			inFlightServer.owner === "server" &&
			inFlightServer.connectionGeneration === report.connectionGeneration
		) {
			return {
				connectionGeneration: report.connectionGeneration,
				accepted: true,
				action: "server-reconciling",
			};
		}

		// Client 在线崩溃自愈（owner=client）：只标 reconciling + Dashboard 确认，不派发 Server 重试。
		if (report.status === "retrying" && report.recoveryOwner === "client") {
			return this.handleClientOwnedRetry(clientId, socketId, report);
		}
		if (
			(this.contexts.get(clientId)?.owner ?? "server") === "client" &&
			(report.status === "running" || report.status === "failed")
		) {
			return this.settleClientOwnedCycle(clientId, report);
		}

		// Client 自愈周期未终局（等待 running/failed 终局上报）时不启动 Server 派发，避免嵌套重试：
		// 同代次 client-owned 在途期间，任何未在上文路由的状态都不进入三方比较。
		const existing = this.contexts.get(clientId);
		if (
			existing &&
			existing.owner === "client" &&
			existing.connectionGeneration === report.connectionGeneration
		) {
			return {
				connectionGeneration: report.connectionGeneration,
				accepted: true,
				action: "none",
			};
		}

		// 三方比较（Server/SQLite × Client runtime × FRPS Dashboard）。
		// SAFETY: FrpMapping 行结构上包含 FrpMappingRow 全部字段（Prisma 生成类型是超集）。
		const mappings = (await this.prisma.frpMapping.findMany({
			where: { clientId },
		})) as unknown as FrpMappingRow[];
		const recoverable = mappings.filter(
			(m) =>
				RECOVERABLE_STATUSES.includes(m.status) &&
				!EXCLUDED_STATUSES.includes(m.status) &&
				m.frpsInstanceId !== null,
		);

		// 同一 Client 多个 FRPS 实例：本轮失败关闭（不派发）。
		const instanceIds = new Set(recoverable.map((m) => m.frpsInstanceId as string));
		if (instanceIds.size > 1) {
			this.log(`client=${clientId} 存在多个 FRPS 实例，本轮恢复失败关闭`);
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}
		const instanceId = instanceIds.size === 1 ? [...instanceIds][0] : null;
		if (!instanceId) {
			// 无期望集合：三方一致（无可恢复映射）。
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}
		const instance = await this.instances.getById(instanceId);
		if (!instance) {
			this.log(`client=${clientId} 关联 FRPS 实例 ${instanceId} 不存在，本轮不派发`);
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}

		let dashboard: { list: { proxyType: string; name: string; remotePort: number | null; status: "online" | "offline" }[]; usedPorts: number[] };
		try {
			dashboard = (await this.instances.listDashboardProxies(instance)) as never;
		} catch (error) {
			// Dashboard 不可达：不中止本轮 —— 以“全部未确认”失败关闭继续有限重试周期，
			// 由重试槽位决定耗尽（映射回 inactive + FRP_RECONCILE_FAILED）或下轮再确认。
			const failure = error as { code?: string };
			this.log(`Dashboard 确认失败 (client=${clientId}, code=${failure.code ?? "UNKNOWN"})，按全部未确认继续本轮`);
			dashboard = { list: [], usedPorts: [] };
		}

		// runtime 快照只在 frpsEndpoint 与目标实例地址/端口一致时可信。
		const runtimeSet =
			report.frpsEndpoint &&
			report.frpsEndpoint.serverAddr === instance.serverAddr &&
			report.frpsEndpoint.serverPort === instance.serverPort
				? report.mappings
				: [];

		// 未知本地映射：无冲突 → preservedMappings；与期望冲突 → 本轮 FRP_RUNTIME_STATE_INVALID 失败关闭。
		const expectedRows = recoverable;
		const expectedKeys = new Set(
			expectedRows.map((m) => mappingKey(m.name, m.localPort, m.remotePort)),
		);
		const orphans = runtimeSet.filter(
			(s) => !expectedRows.some((m) => m.id === s.mappingId),
		);
		const conflict = orphans.some((s) => expectedKeys.has(mappingKey(s.name, s.localPort, s.remotePort)));
		if (conflict) {
			this.log(`client=${clientId} 本地快照与期望集合冲突（FRP_RUNTIME_STATE_INVALID），本轮失败关闭`);
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}

		// 一致性判定：active 且 runtime 一致且 Dashboard 按 type/name 确认 → 保持 active。
		const targets: ReconcileTarget[] = [];
		const demoted: string[] = [];
		const consistentWithErrors: string[] = [];
		for (const m of expectedRows) {
			const runtimeMatch = runtimeSet.some(
				(s) =>
					s.mappingId === m.id &&
					s.name === m.name &&
					s.proxyType === m.proxyType &&
					s.localIp === m.localIp &&
					s.localPort === m.localPort &&
					s.remotePort === m.remotePort &&
					s.customDomain === m.customDomain,
			);
			// 二次确认只认 online：offline 残留条目（frpc 已断开）不算在线。
			const confirmed = dashboard.list.some(
				(p) => p.proxyType === m.proxyType && p.name === m.name && p.status === "online",
			);
			if (m.status === "active" && runtimeMatch && confirmed) {
				if (m.errorCode !== null || m.errorMessage !== null) {
					consistentWithErrors.push(m.id);
				}
				continue;
			}
			if (m.status === "active") {
				// 不一致的 active 先降为 inactive，再作为目标进入 reconciling。
				demoted.push(m.id);
			}
			targets.push({
				id: m.id,
				name: m.name,
				proxyType: m.proxyType,
				localIp: m.localIp,
				localPort: m.localPort,
				remotePort: m.remotePort,
				customDomain: m.customDomain,
			});
		}

		if (demoted.length > 0) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: demoted } },
				data: { status: "inactive", operationJobId: null, errorCode: null, errorMessage: null },
			});
		}
		if (consistentWithErrors.length > 0) {
			// 三方一致：清除已知映射的恢复错误，保持 active。
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: consistentWithErrors } },
				data: { errorCode: null, errorMessage: null, operationJobId: null },
			});
		}

		if (targets.length === 0) {
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}

		const started = await this.beginServerCycle(clientId, socketId, report, instance, targets, orphans);
		return {
			connectionGeneration: report.connectionGeneration,
			accepted: true,
			action: started ? "server-reconciling" : "none",
		};
	}

	/** 处理 frp.reconcile Job 的本地结果（严格解析；旧代次/旧 Job 忽略）。 */
	async handleLocalResult(jobId: string, raw: unknown): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== "frp.reconcile") return;
		const ctx = this.contexts.get(job.clientId);
		if (!ctx || ctx.currentJobId !== jobId) return;
		if (ctx.owner !== "server") return;

		let result: FrpReconcileResult;
		try {
			result = parseFrpReconcileResult(raw);
		} catch {
			this.log(`拒绝无效 reconcile 结果 (job=${jobId})`);
			await this.settleJob(jobId, false, "FRP_RUNTIME_STATE_INVALID");
			return;
		}
		// 租约/代次校验：旧连接代次的结果不覆盖新周期。
				if (result.connectionGeneration !== ctx.connectionGeneration) return;
		let payload: { expectedRuntimeGeneration: number };
		try {
			payload = JSON.parse(job.payload) as typeof payload;
		} catch {
			await this.settleJob(jobId, false, "FRP_RUNTIME_STATE_INVALID");
			return;
		}
		if (result.runtimeGeneration !== payload.expectedRuntimeGeneration) {
			this.log(`reconcile 结果代次不匹配 (job=${jobId})，按 STALE 失败处理`);
			await this.settleJob(jobId, false, "FRP_RUNTIME_GENERATION_STALE");
			return;
		}

		await this.settleJob(jobId, true, null, {
			status: result.status,
			runtimeGeneration: result.runtimeGeneration,
			loadedMappingIds: result.loadedMappingIds,
		});
		if (result.status !== "running") {
			// 本地失败：留给重试槽位决定下一次尝试或耗尽。
			return;
		}
		ctx.lastRunningGeneration = result.runtimeGeneration;

		// 有界等待双重确认：Job 结果 "running" 只证明 frpc 进程已 spawn；
		// frpc→frps 登录建连通常 10ms~数秒，单次立即复检会落在连接窗口之前。
		// 轮询至全部确认或预算耗尽（Dashboard 不可达立即返回全未确认）。
		const instance = await this.instances.getById(ctx.frpsInstanceId);
		if (!instance) return;
		const perTarget = await this.waitForConfirmation(instance, ctx.targets);
		const allConfirmed = ctx.targets.every((t) => perTarget.get(t.id));
		if (!allConfirmed) {
			const unreachable = [...perTarget.values()].every((v) => !v);
			this.log(
				unreachable && ctx.targets.length > 0
					? `Dashboard 再确认失败 (client=${ctx.clientId})，本次尝试按 FRP_RECONCILE_FAILED 结算`
					: `再确认未全通过 (client=${ctx.clientId})，未确认目标交重试槽位`,
				);
			if (unreachable) {
				// Dashboard 不可达：本次尝试按失败结算（Job 终局），重试槽位决定下一次尝试或耗尽，
				// 避免目标永远停在 reconciling。
				await this.settleJob(jobId, false, "FRP_RECONCILE_FAILED");
				return;
			}
		}
		const confirmedNow: string[] = [];
		for (const target of ctx.targets) {
			// 二次确认只认 online：offline 残留条目不算在线。
			if (perTarget.get(target.id)) confirmedNow.push(target.id);
		}
		for (const id of confirmedNow) {
			if (!ctx.confirmedIds.includes(id)) ctx.confirmedIds.push(id);
		}
		if (confirmedNow.length > 0) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: confirmedNow } },
				data: { status: "active", operationJobId: null, errorCode: null, errorMessage: null },
			});
		}
		if (ctx.confirmedIds.length === ctx.targets.length) {
			// 全部确认：周期完成。
			this.finishCycle(ctx.clientId);
		}
	}

	/** 处理 frp.reconcile Job 的 Client 侧错误（安全错误码）。 */
	async handleLocalFailure(jobId: string, code: unknown): Promise<void> {
		const job = await this.prisma.job.findUnique({ where: { id: jobId } });
		if (!job || job.type !== "frp.reconcile") return;
		const ctx = this.contexts.get(job.clientId);
		if (!ctx || ctx.currentJobId !== jobId) return;
		const safeCode =
			typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "FRP_RECONCILE_FAILED";
		this.log(`reconcile Job 本地失败 (job=${jobId}, code=${safeCode})，交给重试槽位决定`);
		await this.settleJob(jobId, false, safeCode);
	}

	/** Client 断开：取消 timer，只回收匹配 socket 的租约（旧 socket 清理不能终止新周期）。 */
	disconnect(clientId: string, socketId: string): void {
		const ctx = this.contexts.get(clientId);
		if (ctx && ctx.socketId === socketId) {
			this.cancelCycle(clientId, "client-disconnect");
		}
	}

	// ── 内部编排 ──

	private async handleClientOwnedRetry(
		clientId: string,
		socketId: string,
		report: FrpRuntimeStateReport,
	): Promise<FrpRuntimeStateAck> {
		// SAFETY: FrpMapping 行结构上包含 FrpMappingRow 全部字段（Prisma 生成类型是超集）。
		const mappings = (await this.prisma.frpMapping.findMany({
			where: { clientId },
		})) as unknown as FrpMappingRow[];
		const known = mappings.filter(
			(m) => RECOVERABLE_STATUSES.includes(m.status) && m.frpsInstanceId !== null,
		);
		const ids = known
			.filter((m) => report.mappings.some((s) => s.mappingId === m.id))
			.map((m) => m.id);
		const instanceIds = new Set(known.map((m) => m.frpsInstanceId as string));
		const targetRows = known
			.filter((m) => ids.includes(m.id))
			.map((m) => ({
				id: m.id,
				name: m.name,
				proxyType: m.proxyType,
				localIp: m.localIp,
				localPort: m.localPort,
				remotePort: m.remotePort,
				customDomain: m.customDomain,
			}));
		if (ids.length > 0 && instanceIds.size === 1) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: ids } },
				data: { status: "reconciling", errorCode: null, errorMessage: null },
			});
		}
		if (ids.length > 0) {
			const existing = this.contexts.get(clientId);
			if (existing && existing.owner === "client" && existing.connectionGeneration === report.connectionGeneration) {
				existing.targets = targetRows;
			} else {
				// 同代次已有 Server 周期：先终止（不嵌套重试），再建立 Client-owned 周期。
				if (existing) this.cancelCycle(clientId, "client-owned-retry");
				this.contexts.set(clientId, {
					clientId,
					socketId,
					connectionGeneration: report.connectionGeneration,
					owner: "client",
					frpsInstanceId: [...instanceIds][0] ?? "",
					targets: targetRows,
					currentJobId: null,
					lastRunningGeneration: null,
					baseExpectedGeneration: report.runtimeGeneration,
					confirmedIds: [],
					dispatchCount: 0,
					slots: [],
				});
			}
		}
		return {
			connectionGeneration: report.connectionGeneration,
			accepted: true,
			action: "client-retrying",
		};
	}

	/** Client 在线恢复周期的终局：running 按 Dashboard 确认 active，failed 回到 inactive。 */
	private async settleClientOwnedCycle(
		clientId: string,
		report: FrpRuntimeStateReport,
	): Promise<FrpRuntimeStateAck> {
		const ctx = this.contexts.get(clientId);
		if (!ctx || ctx.owner !== "client" || ctx.connectionGeneration !== report.connectionGeneration) {
			return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
		}
		// SAFETY: FrpMapping 行结构上包含 FrpMappingRow 全部字段（Prisma 生成类型是超集）。
		const mappings = (await this.prisma.frpMapping.findMany({
			where: { clientId },
		})) as unknown as FrpMappingRow[];
		const byId = new Map(mappings.map((m) => [m.id, m]));
		const instanceIds = new Set(mappings.filter((m) => m.frpsInstanceId).map((m) => m.frpsInstanceId as string));
		let instance = null as null | Awaited<ReturnType<FrpsInstancesService["getById"]>>;
		if (instanceIds.size === 1) {
			instance = await this.instances.getById([...instanceIds][0]);
		}
		// 有界等待双重确认：Client 自愈重启 frpc 后 "running" 只证明进程已 spawn；
		// frpc→frps 建连需要 10ms~数秒，立即复检会落在建连窗口之前而误判失败。
		// 轮询至本轮目标全部 online 或预算耗尽；Dashboard 不可达立即保持全未确认。
		let confirmed = new Map<string, boolean>(mappings.map((m) => [m.id, false]));
		if (instance) {
			const deadline = Date.now() + this.confirmWaitMs;
			for (;;) {
				try {
					const dashboard = (await this.instances.listDashboardProxies(instance)) as {
						list: { proxyType: string; name: string; remotePort: number | null; status: "online" | "offline" }[];
					};
					confirmed = new Map(mappings.map((m) => [m.id, false]));
					for (const m of mappings) {
						if (m.frpsInstanceId === instance.id) {
							// 二次确认只认 online：offline 残留条目（frpc 已断开）不算在线。
							confirmed.set(
								m.id,
								dashboard.list.some(
									(p) => p.proxyType === m.proxyType && p.name === m.name && p.status === "online",
								),
							);
						}
					}
				} catch {
					break; // Dashboard 不可达：保持全未确认，落入 failed 路径。
				}
				const allTargetsConfirmed = ctx.targets.every((t) => confirmed.get(t.id));
				if (allTargetsConfirmed || Date.now() >= deadline) break;
				await new Promise((r) => setTimeout(r, 500));
			}
		}

		const activeIds: string[] = [];
		const failedIds: string[] = [];
		for (const s of report.mappings) {
			const m = byId.get(s.mappingId);
			if (!m) {
				// 未知本地映射：只记录 orphan，不自动导入、不自动删除。
				this.log(`Client 快照含 Server 未知映射 ${s.mappingId}（orphan，保留在 Client 本地）`);
				continue;
			}
			if (report.status === "running" && confirmed.get(m.id)) {
				activeIds.push(m.id);
			} else {
				failedIds.push(m.id);
			}
		}
		// 本轮目标中 Client 快照未覆盖的（如已删除的 DB 记录之外）按失败处理。
		for (const t of ctx.targets) {
			if (!report.mappings.some((s) => s.mappingId === t.id) && !failedIds.includes(t.id)) {
				failedIds.push(t.id);
			}
		}
		if (activeIds.length > 0) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: activeIds } },
				data: { status: "active", operationJobId: null, errorCode: null, errorMessage: null },
			});
		}
		if (failedIds.length > 0) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: failedIds } },
				data: {
					status: "inactive",
					operationJobId: null,
					errorCode: "FRP_RECONCILE_FAILED",
					errorMessage: SAFE_RECONCILE_FAILED_MESSAGE,
				},
			});
		}
		this.contexts.delete(clientId);
		this.leases.delete(clientId);
		return { connectionGeneration: report.connectionGeneration, accepted: true, action: "none" };
	}

	/** 启动 Server 独占恢复周期：创建 system Job、标记 reconciling、精确派发、排定 5s/30s 槽位。返回是否成功启动。 */
	private async beginServerCycle(
		clientId: string,
		socketId: string,
		report: FrpRuntimeStateReport,
		instance: Awaited<ReturnType<FrpsInstancesService["getById"]>>,
		targets: ReconcileTarget[],
		orphans: FrpReconcilePayload["mappings"],
	): Promise<boolean> {
		const ctx: ReconcileContext = {
			clientId,
			socketId,
			connectionGeneration: report.connectionGeneration,
			owner: "server",
			frpsInstanceId: instance!.id,
			targets,
			currentJobId: null,
			lastRunningGeneration: null,
			baseExpectedGeneration: report.runtimeGeneration + 1,
			confirmedIds: [],
			dispatchCount: 0,
			slots: [],
		};
		// 同代次已有 Server 周期：先终止旧周期（在途 Job 结算失败），避免旧 Job 与新周期并存。
		const previous = this.contexts.get(clientId);
		if (previous && previous !== ctx) this.cancelCycle(clientId, "cycle-restart");
		this.contexts.set(clientId, ctx);
		// 重试槽位：5s / 30s（相对周期开始）。槽位触发时若 Job 仍在途，按该次尝试失败处理。
		ctx.slots.push(this.schedule(this.delays[1], () => this.onRetrySlot(ctx)));
		ctx.slots.push(this.schedule(this.delays[2], () => this.onRetrySlot(ctx, true)));
		const started = await this.dispatchAttempt(ctx, orphans);
		if (!started) {
			this.cancelCycle(clientId, "dispatch-failed");
			return false;
		}
		return true;
	}

	/** 派发一次 reconcile 尝试（system Job + reconciling 标记 + 精确 socket 派发）。 */
	private async dispatchAttempt(
		ctx: ReconcileContext,
		orphans: FrpReconcilePayload["mappings"],
	): Promise<boolean> {
		const expectedGeneration =
			ctx.lastRunningGeneration !== null
				? ctx.lastRunningGeneration + 1
				: ctx.baseExpectedGeneration;
		const attempt = Math.min(ctx.dispatchCount, 2) as 0 | 1 | 2;
		ctx.dispatchCount += 1;
		const instance = await this.instances.getById(ctx.frpsInstanceId);
		if (!instance) {
			this.log(`FRPS 实例 ${ctx.frpsInstanceId} 不存在，本轮派发跳过`);
			return false;
		}
		{
			const jobId = randomUUID();
			const payload: FrpReconcilePayload = {
				connectionGeneration: ctx.connectionGeneration,
				expectedRuntimeGeneration: expectedGeneration,
				attempt,
				timeoutSeconds: RECONCILE_JOB_TIMEOUT_SECONDS,
				frpsInfo: {
					serverAddr: instance.serverAddr,
					serverPort: instance.serverPort,
					authToken: instance.authToken,
				},
				// 目标快照取自 SQLite 期望集合（权威配置）；orphan 原样保留在 Client 本地。
				mappings: ctx.targets.map((t) => ({
					mappingId: t.id,
					name: t.name,
					proxyType: t.proxyType as "tcp" | "http" | "https",
					localIp: t.localIp,
					localPort: t.localPort,
					remotePort: t.remotePort,
					customDomain: t.customDomain,
				})),
				preservedMappings: orphans,
			};
			try {
				await this.prisma.job.create({
					data: {
						id: jobId,
						clientId: ctx.clientId,
						type: "frp.reconcile",
						status: "running",
						startedAt: new Date(),
						payload: JSON.stringify(payload),
						timeout: RECONCILE_JOB_TIMEOUT_SECONDS,
						createdByIdentityId: null,
						createdByName: null,
						createdVia: "system:frp-reconcile",
					},
				});
			} catch (error) {
				this.log(`reconcile Job 创建失败 (client=${ctx.clientId}): ${(error as Error).message}`);
				return false;
			}
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: ctx.targets.map((t) => t.id) } },
				data: {
					status: "reconciling",
					operationJobId: jobId,
					errorCode: null,
					errorMessage: null,
				},
			});
			ctx.currentJobId = jobId;
			const dispatch: DispatchPayload = {
				jobId,
				clientId: ctx.clientId,
				type: "frp.reconcile",
				// SAFETY: FrpReconcilePayload 全部字段可 JSON 序列化，与 DispatchPayload 契约兼容。
				payload: payload as unknown as Record<string, unknown>,
				timeout: RECONCILE_JOB_TIMEOUT_SECONDS,
			};
			if (this.dispatcher) {
				this.dispatcher(ctx.socketId, dispatch);
			} else {
				this.log("dispatcher 未绑定，reconcile 仅落库不派发");
			}
			return true;
		}
	}

	/** 重试槽位触发：在途 Job 未结算按超时失败处理；最后槽位仍有未确认目标则耗尽周期。 */
	/**
	 * 有界等待双重确认：轮询 Dashboard 至全部目标 online 或预算耗尽（缺省 3s，500ms 间隔）。
	 * 覆盖 frpc→frps 登录建连窗口（10ms~数秒）；Dashboard 不可达立即返回全未确认。
	 */
	private async waitForConfirmation(
		instance: NonNullable<Awaited<ReturnType<FrpsInstancesService["getById"]>>>,
		targets: ReconcileTarget[],
	): Promise<Map<string, boolean>> {
		const deadline = Date.now() + this.confirmWaitMs;
		for (;;) {
			let dashboard: { list: { proxyType: string; name: string; remotePort: number | null; status: "online" | "offline" }[] };
			try {
				dashboard = (await this.instances.listDashboardProxies(instance)) as never;
			} catch {
				return new Map(targets.map((t) => [t.id, false]));
			}
			const perTarget = new Map<string, boolean>();
			let all = true;
			for (const t of targets) {
				const ok = dashboard.list.some(
					(p) => p.proxyType === t.proxyType && p.name === t.name && p.status === "online",
				);
				perTarget.set(t.id, ok);
				if (!ok) all = false;
			}
			if (all || Date.now() >= deadline) return perTarget;
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	/** 槽位时机按 Dashboard 复检未确认目标：online 即置 active；Dashboard 不可达则静默交由槽位既有逻辑。 */
	private async recheckDashboard(ctx: ReconcileContext): Promise<void> {
		const unconfirmed = ctx.targets.filter((t) => !ctx.confirmedIds.includes(t.id));
		if (unconfirmed.length === 0) return;
		let instance: Awaited<ReturnType<FrpsInstancesService["getById"]>> | null;
		try {
			instance = await this.instances.getById(ctx.frpsInstanceId);
		} catch {
			return;
		}
		if (!instance) return;
		let dashboard: { list: { proxyType: string; name: string; remotePort: number | null; status: "online" | "offline" }[] };
		try {
			dashboard = (await this.instances.listDashboardProxies(instance)) as never;
		} catch {
			// Dashboard 不可达：保持未确认，由槽位逻辑决定重试或耗尽结算。
			return;
		}
		for (const t of unconfirmed) {
			const ok = dashboard.list.some(
				(p) => p.proxyType === t.proxyType && p.name === t.name && p.status === "online",
			);
			if (ok) {
				ctx.confirmedIds.push(t.id);
				await this.prisma.frpMapping.update({
					where: { id: t.id },
					data: { status: "active", operationJobId: null, errorCode: null, errorMessage: null },
				});
				this.log(`槽位复检确认 (client=${ctx.clientId}, mapping=${t.name}) → active`);
			}
		}
	}

	private async onRetrySlot(ctx: ReconcileContext, isFinal = false): Promise<void> {
		if (this.contexts.get(ctx.clientId) !== ctx) return;
		if (ctx.currentJobId) {
			const job = await this.prisma.job.findUnique({ where: { id: ctx.currentJobId } });
			const settled = !job || job.status === "done" || job.status === "error";
			if (!settled) {
				this.log(`reconcile Job 未在槽位内结算 (job=${ctx.currentJobId})，按尝试失败处理`);
				await this.settleJob(ctx.currentJobId, false, "FRP_RECONCILE_TIMEOUT");
			}
		}
		// 槽位窗口内先按 Dashboard 复检：Job 结果 "running" 只证明 frpc 进程已 spawn，
		// frpc→frps 连接建立需要数秒；立即派发下一次尝试会重启 frpc 并重置连接进度，
		// 导致二次确认永远落在连接窗口之前。
		await this.recheckDashboard(ctx);
		const unconfirmed = ctx.targets.filter((t) => !ctx.confirmedIds.includes(t.id));
		if (unconfirmed.length === 0) {
			this.finishCycle(ctx.clientId);
			return;
		}
		if (isFinal) {
			await this.failUnconfirmed(ctx);
			return;
		}
		// 下一次尝试：目标收窄为未确认集合。
		ctx.targets = unconfirmed;
		ctx.currentJobId = null;
		this.dispatchAttempt(ctx, []);
	}

	/** 重试耗尽：未确认目标回到 inactive + FRP_RECONCILE_FAILED（安全信息）。 */
	private async failUnconfirmed(ctx: ReconcileContext): Promise<void> {
		const unconfirmed = ctx.targets.filter((t) => !ctx.confirmedIds.includes(t.id));
		if (unconfirmed.length > 0) {
			await this.prisma.frpMapping.updateMany({
				where: { id: { in: unconfirmed.map((t) => t.id) } },
				data: {
					status: "inactive",
					operationJobId: null,
					errorCode: "FRP_RECONCILE_FAILED",
					errorMessage: SAFE_RECONCILE_FAILED_MESSAGE,
				},
			});
		}
		this.finishCycle(ctx.clientId);
	}

	private cancelSlots(ctx: ReconcileContext): void {
		for (const timer of ctx.slots) {
			if (timer) clearTimeout(timer);
		}
		ctx.slots = [];
	}

	private cancelCycle(clientId: string, reason: string): void {
		const ctx = this.contexts.get(clientId);
		if (!ctx) {
			this.leases.delete(clientId);
			return;
		}
		this.cancelSlots(ctx);
		if (ctx.currentJobId) {
			void this.settleJob(ctx.currentJobId, false, "FRP_RECONCILE_FAILED");
		}
		this.contexts.delete(clientId);
		this.leases.delete(clientId);
		this.log(`client=${clientId} 恢复周期终止（${reason}）；映射保持 reconciling 待下轮上报或启动恢复`);
	}

	private finishCycle(clientId: string): void {
		const ctx = this.contexts.get(clientId);
		if (ctx) this.cancelSlots(ctx);
		this.contexts.delete(clientId);
	}

	private async settleJob(
		jobId: string,
		success: boolean,
		errorCode: string | null,
		/** 安全结果投影（mapping IDs/generation/status；不含 frpsInfo/payload 正文）。 */
		safeResult?: Record<string, unknown>,
	): Promise<void> {
		try {
			await this.prisma.job.update({
				where: { id: jobId },
				data: {
					status: success ? "done" : "error",
					errorCode,
					errorMessage: errorCode ? SAFE_RECONCILE_FAILED_MESSAGE : null,
					result: safeResult ? JSON.stringify(safeResult) : null,
					finishedAt: new Date(),
				},
			});
		} catch {
			// Job 行缺失/已终局：忽略（幂等结算）。
		}
	}

	private hasReconcileCapability(client: { capabilityDetails?: string } | null): boolean {
		if (!client?.capabilityDetails) return false;
		let details: Record<string, unknown>;
		try {
			details = JSON.parse(client.capabilityDetails) as Record<string, unknown>;
		} catch {
			return false;
		}
		if (!details || typeof details !== "object" || details.frp === undefined) return false;
		try {
			const frp = parseFrpCapabilityStatus(details.frp);
			return frp.available === true && frp.reconcileProtocolVersion === 1;
		} catch {
			return false;
		}
	}

	private extractGeneration(raw: unknown): string {
		if (typeof raw === "object" && raw !== null) {
			const value = (raw as Record<string, unknown>).connectionGeneration;
			if (typeof value === "string" && value.length > 0 && value.length <= 128) {
				return value;
			}
		}
		return "";
	}
}
