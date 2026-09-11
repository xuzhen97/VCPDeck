import { ReleaseStatus, type ReleaseArchiveStorage, type ReleaseCleanupArchiveCandidate, type ReleaseInfo, type ReleasePlatform } from "@vcpdeck/shared";
type AvailableArchive = {
    sha256: string;
    size: number;
    fileName: string;
    availability?: "available";
    storage?: ReleaseArchiveStorage;
};
/** Release 正文和上传会话的固定清理策略。 */
export declare const RELEASE_CLEANUP_POLICY: {
    readonly successfulReleaseCount: 3;
    readonly minimumAgeDays: 30;
    readonly uploadSessionGraceHours: 24;
};
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
    deleting: Array<{
        version: string;
        platform: ReleasePlatform;
    }>;
}
/** 计算 Release archive 的可清理平台候选，不执行任何外部副作用。 */
export declare function computeReleaseCleanupPlan(input: ReleaseCleanupPolicyInput): ReleaseCleanupPlan;
/** 将平台候选聚合为页面预览使用的版本摘要。 */
export declare function summarizeCleanupCandidates(candidates: PlannedArchiveDeletion[]): ReleaseCleanupArchiveCandidate[];
export {};
