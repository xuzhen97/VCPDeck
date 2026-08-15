/**
 * 更新编排器：全自动状态机（详见 docs/self-update-release-design.md §7.3）。
 *
 * - startRelease：上传后触发服务端自更新（prepare → drain → 广播 → apply）
 * - resumeAfterStartup：服务启动时从 DB 恢复（launcher 回退判定 / 客户端阶段续跑）
 * - onClientRegistered / onUpdateFailed / onUpdateReady：来自网关的事件钩子
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
	ReleaseClientState,
	ReleaseStatus,
	VERSION,
	type ServerShutdownNotice,
	type UpdateRequest,
} from "@vcpdeck/shared";
import { ReleaseError, ReleaseService } from "./release.service.js";
import { GatewayUpdateChannel } from "./update-channel.js";
import { LauncherHttpClient } from "./launcher-client.js";
import { ServerDrain } from "../job/server-drain.js";

/** 向客户端发送更新事件与查询在线客户端（由网关适配器实现） */
export interface ClientUpdateChannel {
	/** 在线客户端及其版本 */
	listOnlineClients(): Promise<
		Array<{ clientId: string; clientVersion: string }>
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
	resolve: (outcome: "done" | "failed", reason?: string) => void;
}

@Injectable()
export class ReleaseOrchestrator {
	private readonly serverVersion: string;
	private readonly clientTimeoutMs: number;
	private activePhase: Promise<void> | null = null;
	private pendingClients = new Map<string, ClientWaiter>();

	constructor(
		@Inject(ReleaseService) private readonly releases: ReleaseService,
		@Inject(GatewayUpdateChannel)
		private readonly channel: ClientUpdateChannel,
		@Inject(LauncherHttpClient) private readonly launcher: LauncherClient,
		@Inject(ServerDrain) private readonly drain: DrainCoordinator,
		// 可调参数不是 DI 依赖
		@Optional() options: ReleaseOrchestratorOptions = {},
	) {
		this.serverVersion = options.serverVersion ?? VERSION;
		this.clientTimeoutMs =
			options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
	}

	/**
	 * 上传后触发：uploaded → updating_server。
	 * applyUpdate 正常返回（launcher 未接管）视为失败。
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
		await this.releases.transitionStatus(version, ReleaseStatus.UPDATING_SERVER);
		try {
			await this.launcher.prepareUpdate({
				version,
				url: `/api/releases/${version}/file`,
				sha256: release.sha256,
			});
			await this.drain.drain();
			this.channel.broadcastShutdown({ expectedVersion: version });
			await this.launcher.applyUpdate();
			await this.releases.markFailed(
				version,
				"launcher applyUpdate 返回但服务进程未被接管",
			);
		} catch (e) {
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
			} else {
				waiter.resolve("failed", "注册版本不符（launcher 已回退）");
			}
		}
		void this.triggerCatchUp(clientId, clientVersion);
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

	/** 离线补更：落后客户端注册后触发客户端阶段 */
	private async triggerCatchUp(
		clientId: string,
		clientVersion: string,
	): Promise<void> {
		const target = (await this.releases.getLatestActiveTarget()) ?? null;
		if (!target || clientVersion === target.version) return;
		if (target.clientStates[clientId]?.state === ReleaseClientState.FAILED)
			return;
		if (this.activePhase) return; // 进行中的循环会自行覆盖在线客户端
		await this.runClientPhase(target.version);
	}

	/** 客户端阶段互斥入口（重入时复用进行中的循环） */
	private runClientPhase(version: string): Promise<void> {
		if (!this.activePhase) {
			this.activePhase = this.runClientLoop(version)
				.catch((e) => {
					console.error(`[release] 客户端更新循环失败: ${e}`);
				})
				.finally(() => {
					this.activePhase = null;
					this.pendingClients.clear();
				});
		}
		return this.activePhase;
	}

	/** 全量依次更新：逐个等待「重连注册新版本 / 超时 / 失败」 */
	private async runClientLoop(version: string): Promise<void> {
		const release = await this.releases.findByVersion(version);
		if (!release) return;
		const online = await this.channel.listOnlineClients();
		const outdated = online.filter((c) => c.clientVersion !== version);
		for (const client of outdated) {
			await this.releases.markClientState(
				version,
				client.clientId,
				ReleaseClientState.UPDATING,
			);
			this.channel.sendUpdateRequest(client.clientId, {
				releaseVersion: version,
				url: `/api/releases/${version}/file`,
				sha256: release.sha256,
				timeoutMs: this.clientTimeoutMs,
			});
			const outcome = await this.waitClientOutcome(client.clientId, version);
			await this.releases.markClientState(
				version,
				client.clientId,
				outcome.outcome === "done"
					? ReleaseClientState.DONE
					: ReleaseClientState.FAILED,
				outcome.reason,
			);
		}
		await this.releases.transitionStatus(version, ReleaseStatus.DONE);
	}

	private waitClientOutcome(
		clientId: string,
		targetVersion: string,
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
				resolve: (outcome, reason) => {
					clearTimeout(timer);
					this.pendingClients.delete(clientId);
					resolve({ outcome, ...(reason ? { reason } : {}) });
				},
			});
		});
	}
}
