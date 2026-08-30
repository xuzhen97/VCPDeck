import {
	Inject,
	Injectable,
	Logger,
	Optional,
	type OnModuleDestroy,
	type OnModuleInit,
} from "@nestjs/common";
import {
	VERSION,
	type ReleaseCleanupPreview,
	type ReleaseCleanupRunResult,
	type ReleasePlatform,
} from "@vcpdeck/shared";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ReleaseError, ReleaseService } from "./release.service.js";
import { releaseZipPath } from "./release-paths.js";
import {
	RELEASE_CLEANUP_POLICY,
	computeReleaseCleanupPlan,
	summarizeCleanupCandidates,
	type PlannedArchiveDeletion,
} from "./release-cleanup.policy.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";

type UploadSessionRow = {
	id: string;
	version: string;
	platform: string;
	size: number;
	provider: string;
	providerKey: string;
	status: string;
	expiresAt: Date;
};

type UploadSessionDelegate = {
	findMany(args?: unknown): Promise<UploadSessionRow[]>;
	delete(args: { where: { id: string } }): Promise<unknown>;
};

type PrismaWithUploadSessions = PrismaService & {
	releaseUploadSession: UploadSessionDelegate;
};

export interface ReleaseCleanupServiceOptions {
	now?: () => Date;
	removeLocal?: (path: string) => Promise<void>;
}

/** Server Release archive 与直传会话清理协调器。 */
@Injectable()
export class ReleaseCleanupService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(ReleaseCleanupService.name);
	private readonly now: () => Date;
	private readonly removeLocal: (path: string) => Promise<void>;
	private running: Promise<ReleaseCleanupRunResult> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		@Inject(PrismaService) private readonly prisma: PrismaService,
		@Inject(ReleaseService) private readonly releases: ReleaseService,
		@Inject(StorageService) private readonly storage: StorageService,
		@Optional() options: ReleaseCleanupServiceOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
		this.removeLocal = options.removeLocal ?? ((path) => rm(path, { force: true }));
	}

	private get uploadSessions(): UploadSessionDelegate {
		return (this.prisma as PrismaWithUploadSessions).releaseUploadSession;
	}

	/** Server 启动后执行一次，并以每日扫描作为失败重试兜底。 */
	onModuleInit(): void {
		void this.runAutomatic("startup");
		this.timer = setInterval(() => {
			void this.runAutomatic("scheduled");
		}, 24 * 60 * 60 * 1_000);
	}

	/** 停止清理定时器；已经开始的 Provider 删除交给 lifecycle 恢复。 */
	onModuleDestroy(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** 计算当前固定策略下的可清理候选，不执行删除。 */
	async preview(): Promise<ReleaseCleanupPreview> {
		const [releases, latestTarget, active, backend, sessions] = await Promise.all([
			this.releases.listForCleanup(),
			this.releases.getLatestActiveTarget(),
			this.releases.getActiveRelease(),
			this.storage.getBackendConfig(),
			this.uploadSessions.findMany(),
		]);
		const plan = computeReleaseCleanupPlan({
			releases,
			now: this.now(),
			currentServerVersion: VERSION,
			latestTargetVersion: latestTarget?.version ?? null,
			activeReleaseVersion: active?.version ?? null,
			backendKind: backend.kind,
		});
		const candidates = summarizeCleanupCandidates(plan.candidates);
		const expiredUploadSessions = sessions.filter(
			(session) =>
				session.status === "pending" &&
				session.provider === backend.kind &&
				session.expiresAt.getTime() +
					RELEASE_CLEANUP_POLICY.uploadSessionGraceHours * 60 * 60 * 1_000 <=
					this.now().getTime(),
		);
		const sessionBytes = expiredUploadSessions.reduce(
			(total, session) => total + session.size,
			0,
		);
		return {
			policy: RELEASE_CLEANUP_POLICY,
			candidates,
			expiredUploadSessions: {
				count: expiredUploadSessions.length,
				bytes: sessionBytes,
			},
			estimatedReclaimableBytes:
				candidates.reduce((total, candidate) => total + candidate.bytes, 0) +
				sessionBytes,
		};
	}

	/** 按固定策略执行一次清理；执行时重新 claim，不信任旧预览。 */
	async run(): Promise<ReleaseCleanupRunResult> {
		if (this.running) {
			throw new ReleaseError(
				"RELEASE_CLEANUP_BUSY",
				"Release 清理任务正在运行",
			);
		}
		const task = this.executeRun();
		this.running = task;
		void task.then(
			() => {
				if (this.running === task) this.running = null;
			},
			() => {
				if (this.running === task) this.running = null;
			},
		);
		return task;
	}

	/** 自动触发入口；清理失败只记录日志，不改变 Release 状态。 */
	async runAutomatic(
		trigger: "startup" | "release_done" | "scheduled",
	): Promise<void> {
		try {
			await this.run();
		} catch (error) {
			if (error instanceof ReleaseError && error.code === "RELEASE_CLEANUP_BUSY") {
				return;
			}
			this.logger.warn(`Release cleanup failed (trigger=${trigger})`);
		}
	}

	private async executeRun(): Promise<ReleaseCleanupRunResult> {
		const startedAt = this.now().toISOString();
		const result: ReleaseCleanupRunResult = {
			startedAt,
			finishedAt: startedAt,
			cleanedItems: 0,
			cleanedBytes: 0,
			alreadyMissing: 0,
			failed: 0,
			skipped: 0,
			providerUnavailable: 0,
			retryable: false,
			issues: [],
		};
		const [releases, latestTarget, active, backend] = await Promise.all([
			this.releases.listForCleanup(),
			this.releases.getLatestActiveTarget(),
			this.releases.getActiveRelease(),
			this.storage.getBackendConfig(),
		]);
		const plan = computeReleaseCleanupPlan({
			releases,
			now: this.now(),
			currentServerVersion: VERSION,
			latestTargetVersion: latestTarget?.version ?? null,
			activeReleaseVersion: active?.version ?? null,
			backendKind: backend.kind,
		});

		await this.recoverDeleting(plan.deleting, backend.kind, result);
		for (const candidate of plan.candidates) {
			if (candidate.providerState === "provider_unavailable") {
				result.providerUnavailable++;
				result.issues.push({
					version: candidate.version,
					platform: candidate.platform,
					code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
				});
				continue;
			}
			await this.cleanCandidate(candidate, result);
		}
		await this.cleanUploadSessions(backend.kind, result);
		result.finishedAt = this.now().toISOString();
		return result;
	}

	private async cleanCandidate(
		candidate: PlannedArchiveDeletion,
		result: ReleaseCleanupRunResult,
	): Promise<void> {
		const claimed = await this.releases.claimArchiveForCleanup(
			candidate.version,
			candidate.platform,
		);
		if (!claimed) {
			result.skipped++;
			return;
		}
		const localPath = releaseZipPath(candidate.version, candidate.platform);
		try {
			if (claimed.storage) {
				await this.storage.delete(claimed.storage.key);
			} else {
				if (!existsSync(localPath)) result.alreadyMissing++;
				await this.removeLocal(localPath);
			}
			const finished = await this.releases.finishArchiveCleanup(
				candidate.version,
				candidate.platform,
				this.now().toISOString(),
			);
			if (!finished) {
				result.skipped++;
				return;
			}
			result.cleanedItems++;
			result.cleanedBytes += candidate.archive.size;
		} catch {
			await this.releases.restoreArchiveAfterCleanup(
				candidate.version,
				candidate.platform,
			);
			result.failed++;
			result.retryable = true;
			result.issues.push({
				version: candidate.version,
				platform: candidate.platform,
				code: "RELEASE_CLEANUP_DELETE_FAILED",
			});
		}
	}

	private async recoverDeleting(
		entries: Array<{ version: string; platform: ReleasePlatform }>,
		backendKind: string,
		result: ReleaseCleanupRunResult,
	): Promise<void> {
		for (const entry of entries) {
			const release = await this.releases.findByVersionWithStorage(entry.version);
			const archive = release?.archives[entry.platform];
			if (!archive || archive.availability !== "deleting") {
				result.skipped++;
				continue;
			}
			const provider = archive.storage?.provider ?? "local";
			if (provider !== backendKind) {
				result.providerUnavailable++;
				result.issues.push({
					version: entry.version,
					platform: entry.platform,
					code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
				});
				continue;
			}
			try {
				if (archive.storage) {
					await this.storage.delete(archive.storage.key);
				} else {
					await this.removeLocal(releaseZipPath(entry.version, entry.platform));
				}
				if (
					await this.releases.finishArchiveCleanup(
						entry.version,
						entry.platform,
						this.now().toISOString(),
					)
				) {
					result.cleanedItems++;
					result.cleanedBytes += archive.size;
				}
			} catch {
				await this.releases.restoreArchiveAfterCleanup(
					entry.version,
					entry.platform,
				);
				result.failed++;
				result.retryable = true;
				result.issues.push({
					version: entry.version,
					platform: entry.platform,
					code: "RELEASE_CLEANUP_DELETE_FAILED",
				});
			}
		}
	}

	private async cleanUploadSessions(
		backendKind: string,
		result: ReleaseCleanupRunResult,
	): Promise<void> {
		const sessions = await this.uploadSessions.findMany();
		const cutoff = this.now().getTime();
		for (const session of sessions) {
			if (
				session.status !== "pending" ||
				session.expiresAt.getTime() +
					RELEASE_CLEANUP_POLICY.uploadSessionGraceHours * 60 * 60 * 1_000 >
					cutoff
			) {
				continue;
			}
			if (session.provider !== backendKind) {
				result.providerUnavailable++;
				result.issues.push({
					version: session.version,
					code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
				});
				continue;
			}
			try {
				await this.storage.delete(session.providerKey);
				await this.uploadSessions.delete({ where: { id: session.id } });
				result.cleanedItems++;
				result.cleanedBytes += session.size;
			} catch {
				result.failed++;
				result.retryable = true;
				result.issues.push({
					version: session.version,
					code: "RELEASE_UPLOAD_SESSION_DELETE_FAILED",
				});
			}
		}

		for (const session of sessions) {
			if (session.status !== "completed") continue;
			const release = await this.releases.findByVersion(session.version);
			const archive = release?.archives[session.platform as ReleasePlatform];
			if (archive?.availability !== "cleaned") continue;
			try {
				await this.uploadSessions.delete({ where: { id: session.id } });
				result.cleanedItems++;
			} catch {
				result.failed++;
				result.retryable = true;
				result.issues.push({
					version: session.version,
					code: "RELEASE_UPLOAD_SESSION_DELETE_FAILED",
				});
			}
		}
	}
}
