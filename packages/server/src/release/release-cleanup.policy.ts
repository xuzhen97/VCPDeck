import {
	ReleaseStatus,
	isReleaseArchiveAvailable,
	type ReleaseArchiveStorage,
	type ReleaseCleanupArchiveCandidate,
	type ReleaseInfo,
	type ReleasePlatform,
} from "@vcpdeck/shared";

type AvailableArchive = {
	sha256: string;
	size: number;
	fileName: string;
	availability?: "available";
	storage?: ReleaseArchiveStorage;
};

/** Release 正文和上传会话的固定清理策略。 */
export const RELEASE_CLEANUP_POLICY = {
	successfulReleaseCount: 3,
	minimumAgeDays: 30,
	uploadSessionGraceHours: 24,
} as const;

const DAY_MS = 24 * 60 * 60 * 1_000;
const PLATFORMS: ReleasePlatform[] = ["win-x64", "linux-x64"];

export interface ReleaseCleanupPolicyInput {
	releases: ReleaseInfo[];
	now: Date;
	currentServerVersion: string;
	latestTargetVersion: string | null;
	activeReleaseVersion: string | null;
	backendKind: string;
}

export interface PlannedArchiveDeletion {
	version: string;
	status: ReleaseStatus;
	platform: ReleasePlatform;
	archive: AvailableArchive;
	providerState: "ready" | "provider_unavailable";
}

export interface ReleaseCleanupPlan {
	candidates: PlannedArchiveDeletion[];
	deleting: Array<{ version: string; platform: ReleasePlatform }>;
}

function isOldEnough(createdAt: string, now: Date): boolean {
	return now.getTime() - new Date(createdAt).getTime() >= DAY_MS * RELEASE_CLEANUP_POLICY.minimumAgeDays;
}

function isProtectedRelease(
	release: ReleaseInfo,
	protectedVersions: ReadonlySet<string>,
	oldEnough: boolean,
	recentDone: ReadonlySet<string>,
): boolean {
	if (protectedVersions.has(release.version)) return true;
	if (release.status === ReleaseStatus.DONE) {
		return !oldEnough || recentDone.has(release.version);
	}
	return (
		release.status !== ReleaseStatus.FAILED &&
		release.status !== ReleaseStatus.UPLOADED
	) || !oldEnough;
}

function providerState(
	archive: AvailableArchive,
	backendKind: string,
): "ready" | "provider_unavailable" {
	const provider = archive.storage?.provider ?? "local";
	return provider === backendKind ? "ready" : "provider_unavailable";
}

/** 计算 Release archive 的可清理平台候选，不执行任何外部副作用。 */
export function computeReleaseCleanupPlan(
	input: ReleaseCleanupPolicyInput,
): ReleaseCleanupPlan {
	const done = input.releases
		.filter((release) => release.status === ReleaseStatus.DONE)
		.sort(
			(a, b) =>
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	const recentDone = new Set(
		done.slice(0, RELEASE_CLEANUP_POLICY.successfulReleaseCount).map(
			(release) => release.version,
		),
	);
	const protectedVersions = new Set(
		[
			input.currentServerVersion,
			input.latestTargetVersion,
			input.activeReleaseVersion,
		].filter((version): version is string => Boolean(version)),
	);
	const candidates: PlannedArchiveDeletion[] = [];
	const deleting: ReleaseCleanupPlan["deleting"] = [];

	for (const release of input.releases) {
		const oldEnough = isOldEnough(release.createdAt, input.now);
		if (isProtectedRelease(release, protectedVersions, oldEnough, recentDone)) {
			for (const platform of PLATFORMS) {
				const archive = release.archives[platform];
				if (archive?.availability === "deleting") {
					deleting.push({ version: release.version, platform });
				}
			}
			continue;
		}
		const hasAllArchives = PLATFORMS.every((platform) =>
			isReleaseArchiveAvailable(release.archives[platform]),
		);
		if (release.status === ReleaseStatus.UPLOADED && hasAllArchives) continue;
		for (const platform of PLATFORMS) {
			const archive = release.archives[platform];
			if (!archive) continue;
			if (archive.availability === "deleting") {
				deleting.push({ version: release.version, platform });
				continue;
			}
			if (archive.availability === "cleaned") continue;
			const availableArchive: AvailableArchive = {
				sha256: archive.sha256,
				size: archive.size,
				fileName: archive.fileName,
				...(archive.storage ? { storage: archive.storage } : {}),
			};
			const state = providerState(availableArchive, input.backendKind);
			candidates.push({
				version: release.version,
				status: release.status,
				platform,
				archive: availableArchive,
				providerState: state,
			});
		}
	}
	return { candidates, deleting };
}

/** 将平台候选聚合为页面预览使用的版本摘要。 */
export function summarizeCleanupCandidates(
	candidates: PlannedArchiveDeletion[],
): ReleaseCleanupArchiveCandidate[] {
	const grouped = new Map<string, ReleaseCleanupArchiveCandidate>();
	for (const candidate of candidates) {
		const current = grouped.get(candidate.version) ?? {
			version: candidate.version,
			status: candidate.status,
			archives: [],
			bytes: 0,
			reason: "retention_policy" as const,
		};
		current.archives.push({
			platform: candidate.platform,
			bytes: candidate.providerState === "ready" ? candidate.archive.size : 0,
			providerState: candidate.providerState,
		});
		if (candidate.providerState === "ready") current.bytes += candidate.archive.size;
		grouped.set(candidate.version, current);
	}
	return [...grouped.values()];
}
