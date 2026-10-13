/**
 * 更新编排器：Server 先更新，启动恢复后再逐台更新 Client。
 * 详见 docs/design/release-and-update.md。
 *
 * - startRelease：上传后触发服务端自更新（prepare → drain → 广播 → apply）
 * - resumeAfterStartup：服务启动时从 DB 恢复（launcher 回退判定 / 客户端阶段续跑）
 * - onClientRegistered / onUpdateFailed / onUpdateReady：来自网关的事件钩子
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	ReleaseClientState,
	ReleaseRetryErrorCode,
	ReleaseStatus,
	VERSION,
	platformFromOs,
	isReleaseArchiveAvailable,
	type ReleaseClientEntry,
	type ReleaseInfo,
	type ServerShutdownNotice,
	type UpdateRequest,
} from "@vcpdeck/shared";
import { ReleaseError, ReleaseService } from "./release.service.js";
import { GatewayUpdateChannel } from "./update-channel.js";
import { LauncherHttpClient } from "./launcher-client.js";

/** 瞬时失败允许的自动重试次数上限；耗尽后转为需人工处理。 */
export const CLIENT_RETRY_ATTEMPTS_LIMIT = 3;

/** 递增退避：第 N 次失败后需等待的时长（毫秒）。超出长度时沿用最后一段。 */
const CLIENT_RETRY_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/**
 * 判断某个客户端在当前目标版本下是否还可自动重试。
 *
 * 这是补更重试的唯一判据，`triggerCatchUp` 与客户端更新循环必须共用它，
 * 避免出现第二套规则。每次重试都会产生一次完整构件下载，因此次数上限
 * 同时是带宽与磁盘开销的约束。
 *
 * @param entry 该客户端在当前版本中的更新条目；`undefined` 表示从未失败过
 * @param now 当前时间，便于测试注入
 * @param attemptsLimit 尝试次数上限
 * @returns 是否允许再次触发补更
 */
export function canRetryClientUpdate(
	entry: ReleaseClientEntry | undefined,
	now: Date,
	attemptsLimit: number = CLIENT_RETRY_ATTEMPTS_LIMIT,
): boolean {
	if (!entry) return true;
	// 永久失败（平台不受支持或构件缺失）重试只会重复失败。
	if (entry.kind === "permanent") return false;
	const attempts = entry.attempts ?? 0;
	if (attempts >= attemptsLimit) return false;
	const backoff =
		CLIENT_RETRY_BACKOFF_MS[
			Math.min(attempts, CLIENT_RETRY_BACKOFF_MS.length - 1)
		] ?? 0;
	const at = Date.parse(entry.at);
	// 时间不可解析时不阻塞重试：宁可多试一次，也不要让客户端永久掉队。
	if (!Number.isFinite(at)) return true;
	return now.getTime() - at >= backoff;
}
import { ServerDrain } from "../job/server-drain.js";
import { ReleaseCleanupService } from "./release-cleanup.service.js";

/** 向客户端发送更新事件与查询在线客户端（由网关适配器实现） */
export interface ClientUpdateChannel {
	/** 在线客户端及其版本与注册 os（用于选择对应平台的更新包） */
	listOnlineClients(): Promise<
		Array<{ clientId: string; clientVersion: string; os: string }>
	>;
	sendUpdateRequest(clientId: string, req: UpdateRequest): void;
	broadcastShutdown(notice: ServerShutdownNotice): void;
}

/** 本机 launcher 控制通道客户端（B6 实现） */
export interface LauncherClient {
	/** 第一阶段：launcher 下载/校验/解压新版本（服务端此时仍在运行） */
	prepareUpdate(input: {
		version: string;
		url: string;
		sha256: string;
	}): Promise<void>;
	/** 第二阶段：launcher 停掉本进程并切换版本（正常情况不会返回） */
	applyUpdate(): Promise<void>;
}

/** 优雅停机协调（B4 实现）：停派发并等待 job 收敛 */
export interface DrainCoordinator {
	drain(timeoutMs?: number): Promise<void>;
	/** 失败路径显式解除闸门，恢复 Job 派发（进程不死则闸门常在） */
	release(): void;
}

export interface ReleaseOrchestratorOptions {
	/** 服务端自身版本（默认取 @vcpdeck/shared 构建注入值） */
	serverVersion?: string;
	/** 单客户端更新等待上限（ms），默认 10 分钟 */
	clientTimeoutMs?: number;
}

const DEFAULT_CLIENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 客户端更新等待器（注册回执/超时/失败事件三选一解决；timer 由闭包持有） */
interface ClientWaiter {
	targetVersion: string;
	request: UpdateRequest;
	retryCount: number;
	resolve: (outcome: "done" | "failed", reason?: string) => void;
}

@Injectable()
export class ReleaseOrchestrator {
	private readonly serverVersion: string;
	private readonly clientTimeoutMs: number;
	private activePhase: Promise<void> | null = null;
	private pendingClients = new Map<string, ClientWaiter>();
	private readonly queuedCatchUpClients = new Set<string>();

	constructor(
		@Inject(ReleaseService) private readonly releases: ReleaseService,
		@Inject(GatewayUpdateChannel)
		private readonly channel: ClientUpdateChannel,
		@Inject(LauncherHttpClient) private readonly launcher: LauncherClient,
		@Inject(ServerDrain) private readonly drain: DrainCoordinator,
		@Optional()
		@Inject(ReleaseCleanupService)
		private readonly cleanup?: ReleaseCleanupService,
		// 可调参数不是 DI 依赖
		@Optional() options: ReleaseOrchestratorOptions = {},
	) {
		this.serverVersion = options.serverVersion ?? VERSION;
		this.clientTimeoutMs =
			options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
	}

	/**
	 * 上传后触发：uploaded → updating_server。
	 * 服务端按本机平台选择构件；applyUpdate 正常返回（launcher 未接管）视为失败。
	 */
	async startRelease(version: string): Promise<void> {
		const release = await this.releases.findByVersion(version);
		if (!release) {
			throw new ReleaseError("RELEASE_NOT_FOUND", `release ${version} 不存在`);
		}
		const active = await this.releases.getActiveRelease();
		if (active) {
			throw new ReleaseError(
				"RELEASE_ORCHESTRATOR_BUSY",
				`已有进行中的 release ${active.version}`,
			);
		}
		const serverPlatform = platformFromOs(process.platform);
		const serverArchive = serverPlatform
			? release.archives[serverPlatform]
			: undefined;
		if (!serverPlatform || !isReleaseArchiveAvailable(serverArchive)) {
			await this.releases.markFailed(
				version,
				`缺少 ${serverPlatform ?? "未知平台"} 构件，无法更新服务端`,
			);
			return;
		}
		await this.releases.transitionStatus(version, ReleaseStatus.UPDATING_SERVER);
		try {
			await this.launcher.prepareUpdate({
				version,
				url: `/api/releases/${version}/file?platform=${serverPlatform}`,
				sha256: serverArchive.sha256,
			});
			await this.drain.drain();
			this.channel.broadcastShutdown({ expectedVersion: version });
			await this.launcher.applyUpdate();
			// apply 后本进程应被 launcher 停止；连接被掐断与「进程仍存活」无法
			// 可靠区分，不在此落库失败——终局以新进程重启后的版本对账为准。
		} catch (e) {
			// 闸门是进程内状态：编排器失败（含 drain 成功后 broadcastShutdown/
			// applyUpdate 抛错）时进程仍存活，不解除闸门就会永久拒绝派发，
			// 只有重启才能恢复（2026-10-07 生产事故）。
			this.drain.release();
			const message = e instanceof Error ? e.message : String(e);
			await this.releases.markFailed(version, `服务端更新失败: ${message}`);
		}
	}

	/** 服务启动时恢复编排状态（由 main 引导调用） */
	async resumeAfterStartup(): Promise<void> {
		const active = await this.releases.getActiveRelease();
		if (!active) return;
		if (active.status === ReleaseStatus.UPDATING_SERVER) {
			if (this.serverVersion !== active.version) {
				await this.releases.markFailed(
					active.version,
					"服务端更新后版本不符（launcher 已回退）",
				);
				return;
			}
			await this.releases.transitionStatus(
				active.version,
				ReleaseStatus.UPDATING_CLIENTS,
			);
			await this.runClientPhase(active.version);
		} else if (active.status === ReleaseStatus.UPDATING_CLIENTS) {
			await this.runClientPhase(active.version);
		}
	}

	/** 网关注册钩子：推进等待中的客户端，或触发离线补更 */
	onClientRegistered(clientId: string, clientVersion: string): void {
		const waiter = this.pendingClients.get(clientId);
		if (waiter) {
			if (clientVersion === waiter.targetVersion) {
				waiter.resolve("done");
			} else if (waiter.retryCount < 1) {
				// Server 重启期间，旧 Client 可能先以旧版本重连；重发一次，避免
				// 更新请求落在已断开的旧 Socket 上就被误判为回退。
				waiter.retryCount++;
				this.channel.sendUpdateRequest(clientId, waiter.request);
			} else {
				waiter.resolve("failed", "注册版本不符（launcher 已回退）");
			}
			return;
		}
		void this.triggerCatchUp(clientId, clientVersion).catch((e) => {
			console.error(`[release] 客户端补更触发失败: ${e}`);
		});
	}

	/** 客户端明确上报更新失败（等待中的立即失败，其余仅记录） */
	onUpdateFailed(clientId: string, _version: string, reason: string): void {
		const waiter = this.pendingClients.get(clientId);
		if (waiter) {
			const safeReason = reason.slice(0, 200) || "未知原因";
			console.warn(`[release] 客户端 ${clientId} 更新失败: ${safeReason}`);
			waiter.resolve("failed", safeReason);
		}
	}

	/** 客户端优雅停机完成、launcher 即将接管（终局信号是重连注册，这里仅记录） */
	onUpdateReady(clientId: string, version: string): void {
		console.log(`[release] 客户端 ${clientId} 已就绪，等待 launcher 接管 ${version}`);
	}

	/**
	 * 人工强制重试：自动重试耗尽或退避未到期时的唯一兜底。
	 *
	 * 忽略退避与次数上限，但仍拒绝永久失败（重试只会重复失败）；仍会记录尝试次数。
	 * 复用同一条客户端阶段链路与互斥入口，不新开更新循环。
	 */
	async retryClient(
		version: string,
		clientId: string,
	): Promise<{ version: string; clientId: string }> {
		const release = await this.releases.findByVersion(version);
		if (!release) {
			throw new ReleaseError(
				ReleaseRetryErrorCode.NOT_FOUND,
				`release ${version} 不存在`,
			);
		}
		const entry = release.clientStates[clientId];
		if (entry?.kind === "permanent") {
			throw new ReleaseError(
				ReleaseRetryErrorCode.RETRY_NOT_ALLOWED,
				`客户端 ${clientId} 属于永久失败（${entry.reason ?? "构件或平台不受支持"}），重试不会成功`,
			);
		}
		const online = await this.channel.listOnlineClients();
		if (!online.some((client) => client.clientId === clientId) && !entry) {
			throw new ReleaseError(
				ReleaseRetryErrorCode.CLIENT_NOT_FOUND,
				`release ${version} 中不存在客户端 ${clientId}，且该机器当前不在线`,
			);
		}
		await this.runClientPhase(version, clientId);
		return { version, clientId };
	}

	/**
	 * 周期对账：对当前补更目标重跑一次客户端阶段。
	 *
	 * 这是「客户端重连注册」之外的第二驱动力，用于救回失败后持续在线、不再重连的
	 * 客户端。过滤（`canRetryClientUpdate`）与互斥（`runClientPhase`）都在本类内，
	 * 因此与注册钩子共用同一条更新链路，不会并发开启第二条循环。
	 */
	async sweepCatchUp(): Promise<void> {
		const target = await this.releases.getLatestActiveTarget();
		if (!target) return;
		await this.runClientPhase(target.version);
	}

	/** 离线补更：落后客户端注册后触发客户端阶段 */
	private async triggerCatchUp(
		clientId: string,
		clientVersion: string,
	): Promise<void> {
		const target = (await this.releases.getLatestActiveTarget()) ?? null;
		if (!target || clientVersion === target.version) return;
		if (!canRetryClientUpdate(target.clientStates[clientId], new Date()))
			return;
		if (this.activePhase) {
			this.queuedCatchUpClients.add(clientId);
			return;
		}
		await this.runClientPhase(target.version);
	}

	/** 客户端阶段互斥入口（重入时复用进行中的循环） */
	private runClientPhase(
		version: string,
		forcedClientId?: string,
	): Promise<void> {
		if (!this.activePhase) {
			this.activePhase = this.runClientPhaseLoop(version, forcedClientId);
		}
		return this.activePhase;
	}

	/** 阶段收尾后在同一个 Promise 中消费登记的补更 Client。 */
	private async runClientPhaseLoop(
		version: string,
		forcedClientId?: string,
	): Promise<void> {
		try {
			let currentVersion = version;
			while (true) {
				await this.runClientLoop(currentVersion, forcedClientId);
				// 强制重试只作用于本轮，避免后续循环继续绕过退避
				forcedClientId = undefined;
				const queued = [...this.queuedCatchUpClients];
				this.queuedCatchUpClients.clear();
				if (queued.length === 0) return;

				const target = await this.releases.getLatestActiveTarget();
				if (!target) return;
				if (
					queued.every(
						(clientId) =>
							target.clientStates[clientId]?.state ===
							ReleaseClientState.FAILED,
					)
				)
					return;
				currentVersion = target.version;
			}
		} catch (e) {
			console.error(`[release] 客户端更新循环失败: ${e}`);
		} finally {
			this.activePhase = null;
			this.pendingClients.clear();
		}
	}

	/** 全量依次更新：逐个等待「重连注册新版本 / 超时 / 失败」；按客户端 os 选择平台包 */
	private async runClientLoop(
		version: string,
		forcedClientId?: string,
	): Promise<void> {
		const processedClientIds = new Set<string>();
		while (true) {
			const release = await this.releases.findByVersion(version);
			if (!release) return;
			const online = await this.channel.listOnlineClients();
			const now = new Date();
			const outdated = online.filter((client) => {
				if (client.clientVersion === version) return false;
				if (processedClientIds.has(client.clientId)) return false;
				const entry = release.clientStates[client.clientId];
				// 人工强制重试绕过退避与次数上限，但永久失败仍拒绝重试。
				if (client.clientId === forcedClientId) {
					return entry?.kind !== "permanent";
				}
				return canRetryClientUpdate(entry, now);
			});
			if (outdated.length === 0) {
				if (this.queuedCatchUpClients.size > 0) {
					this.queuedCatchUpClients.clear();
					continue;
				}
				if (release.status === ReleaseStatus.UPDATING_CLIENTS) {
					await this.releases.transitionStatus(
						version,
						ReleaseStatus.DONE,
					);
					void this.cleanup?.runAutomatic("release_done");
				}
				return;
			}
			for (const client of outdated) {
				processedClientIds.add(client.clientId);
				await this.updateOneClient(version, release, client);
			}
		}
	}

	private async updateOneClient(
		version: string,
		release: ReleaseInfo,
		client: { clientId: string; clientVersion: string; os: string },
	): Promise<void> {
		if (!release) return;
		const platform = platformFromOs(client.os);
		const clientArchive = platform ? release.archives[platform] : undefined;
		if (!platform || !isReleaseArchiveAvailable(clientArchive)) {
			await this.releases.markClientState(
				version,
				client.clientId,
				ReleaseClientState.FAILED,
				`平台不受支持或构件缺失: ${client.os || "unknown"}`,
				{ kind: "permanent" },
			);
			return;
		}
		await this.releases.markClientState(
			version,
			client.clientId,
			ReleaseClientState.UPDATING,
		);
		const request: UpdateRequest = {
			releaseVersion: version,
			url: `/api/releases/${version}/file?platform=${platform}`,
			sha256: clientArchive.sha256,
			timeoutMs: this.clientTimeoutMs,
		};
		const outcomePromise = this.waitClientOutcome(
			client.clientId,
			version,
			request,
		);
		try {
			// 先登记 waiter，再发事件，避免重连竞态丢失更新请求。
			this.channel.sendUpdateRequest(client.clientId, request);
		} catch (e) {
			this.onUpdateFailed(
				client.clientId,
				version,
				e instanceof Error ? e.message : String(e),
			);
		}
		const outcome = await outcomePromise;
		if (outcome.outcome === "done") {
			await this.releases.markClientState(
				version,
				client.clientId,
				ReleaseClientState.DONE,
				outcome.reason,
			);
			return;
		}
		// 等待重连注册超时、注册版本不符与客户端上报失败都可能是暂时性的，
		// 统一按瞬时失败处理，交由退避与次数上限收敛。
		await this.releases.markClientState(
			version,
			client.clientId,
			ReleaseClientState.FAILED,
			outcome.reason,
			{ kind: "transient" },
		);
	}

	private waitClientOutcome(
		clientId: string,
		targetVersion: string,
		request: UpdateRequest,
	): Promise<{ outcome: "done" | "failed"; reason?: string }> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingClients.delete(clientId);
				resolve({
					outcome: "failed",
					reason: "等待重连注册超时",
				});
			}, this.clientTimeoutMs);
			this.pendingClients.set(clientId, {
				targetVersion,
				request,
				retryCount: 0,
				resolve: (outcome, reason) => {
					clearTimeout(timer);
					this.pendingClients.delete(clientId);
					resolve({ outcome, ...(reason ? { reason } : {}) });
				},
			});
		});
	}
}
