"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELEASE_CLEANUP_POLICY = void 0;
exports.computeReleaseCleanupPlan = computeReleaseCleanupPlan;
exports.summarizeCleanupCandidates = summarizeCleanupCandidates;
const shared_1 = require("@vcpdeck/shared");
/** Release 正文和上传会话的固定清理策略。 */
exports.RELEASE_CLEANUP_POLICY = {
    successfulReleaseCount: 3,
    minimumAgeDays: 30,
    uploadSessionGraceHours: 24,
};
const DAY_MS = 24 * 60 * 60 * 1_000;
const PLATFORMS = ["win-x64", "linux-x64"];
function isOldEnough(createdAt, now) {
    return now.getTime() - new Date(createdAt).getTime() >= DAY_MS * exports.RELEASE_CLEANUP_POLICY.minimumAgeDays;
}
function isProtectedRelease(release, protectedVersions, oldEnough, recentDone) {
    if (protectedVersions.has(release.version))
        return true;
    if (release.status === shared_1.ReleaseStatus.DONE) {
        return !oldEnough || recentDone.has(release.version);
    }
    return (release.status !== shared_1.ReleaseStatus.FAILED &&
        release.status !== shared_1.ReleaseStatus.UPLOADED) || !oldEnough;
}
function providerState(archive, backendKind) {
    const provider = archive.storage?.provider ?? "local";
    return provider === backendKind ? "ready" : "provider_unavailable";
}
/** 计算 Release archive 的可清理平台候选，不执行任何外部副作用。 */
function computeReleaseCleanupPlan(input) {
    const done = input.releases
        .filter((release) => release.status === shared_1.ReleaseStatus.DONE)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const recentDone = new Set(done.slice(0, exports.RELEASE_CLEANUP_POLICY.successfulReleaseCount).map((release) => release.version));
    const protectedVersions = new Set([
        input.currentServerVersion,
        input.latestTargetVersion,
        input.activeReleaseVersion,
    ].filter((version) => Boolean(version)));
    const candidates = [];
    const deleting = [];
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
        const hasAllArchives = PLATFORMS.every((platform) => (0, shared_1.isReleaseArchiveAvailable)(release.archives[platform]));
        if (release.status === shared_1.ReleaseStatus.UPLOADED && hasAllArchives)
            continue;
        for (const platform of PLATFORMS) {
            const archive = release.archives[platform];
            if (!archive)
                continue;
            if (archive.availability === "deleting") {
                deleting.push({ version: release.version, platform });
                continue;
            }
            if (archive.availability === "cleaned")
                continue;
            const availableArchive = {
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
function summarizeCleanupCandidates(candidates) {
    const grouped = new Map();
    for (const candidate of candidates) {
        const current = grouped.get(candidate.version) ?? {
            version: candidate.version,
            status: candidate.status,
            archives: [],
            bytes: 0,
            reason: "retention_policy",
        };
        current.archives.push({
            platform: candidate.platform,
            bytes: candidate.providerState === "ready" ? candidate.archive.size : 0,
            providerState: candidate.providerState,
        });
        if (candidate.providerState === "ready")
            current.bytes += candidate.archive.size;
        grouped.set(candidate.version, current);
    }
    return [...grouped.values()];
}
