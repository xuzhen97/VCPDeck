import { describe, expect, it } from "vitest";
import { ReleaseStatus, type ReleaseInfo } from "@vcpdeck/shared";
import {
	RELEASE_CLEANUP_POLICY,
	computeReleaseCleanupPlan,
} from "./release-cleanup.policy.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const oldDate = "2026-07-01T00:00:00.000Z";
const recentDate = "2026-08-20T00:00:00.000Z";
const archive = (platform: "win-x64" | "linux-x64", availability?: string) => ({
	sha256: "a".repeat(64),
	size: platform === "win-x64" ? 100 : 200,
	fileName: `${platform}.zip`,
	...(availability ? { availability } : {}),
});
function release(
	version: string,
	status: ReleaseStatus,
	createdAt = oldDate,
	archives: Record<string, unknown> = {
		"win-x64": archive("win-x64"),
		"linux-x64": archive("linux-x64"),
	},
): ReleaseInfo {
	return {
		version,
		status,
		archives: archives as ReleaseInfo["archives"],
		createdAt,
		updatedAt: createdAt,
		clientStates: {},
	};
}

describe("computeReleaseCleanupPlan", () => {
	it("保留最近三个 done 和三十天内的 done", () => {
		const releases = [
			release("1.0.3", ReleaseStatus.DONE, recentDate),
			release("1.0.2", ReleaseStatus.DONE, oldDate),
			release("1.0.1", ReleaseStatus.DONE, oldDate),
			release("1.0.0", ReleaseStatus.DONE, oldDate),
			release("0.9.9", ReleaseStatus.DONE, oldDate),
		];
		const plan = computeReleaseCleanupPlan({
			releases,
			now,
			currentServerVersion: "9.9.9",
			latestTargetVersion: null,
			activeReleaseVersion: null,
			backendKind: "local",
		});
		expect(plan.candidates.map((x) => `${x.version}:${x.platform}`)).toEqual([
			"1.0.0:win-x64",
			"1.0.0:linux-x64",
			"0.9.9:win-x64",
			"0.9.9:linux-x64",
		]);
		expect(plan.candidates[0]?.platform).toBe("win-x64");
		expect(plan.candidates[0]?.archive.size).toBe(100);
	});

	it("失败和不完整 uploaded 满三十天可清理，完整 uploaded 不清理", () => {
		const plan = computeReleaseCleanupPlan({
			releases: [
			release("1.0.3", ReleaseStatus.FAILED),
			release("1.0.2", ReleaseStatus.UPLOADED, oldDate, {
				"win-x64": archive("win-x64"),
			}),
			release("1.0.1", ReleaseStatus.UPLOADED),
		],
			now,
		currentServerVersion: "9.9.9",
		latestTargetVersion: null,
		activeReleaseVersion: null,
		backendKind: "local",
	});
		expect(plan.candidates.map((x) => `${x.version}:${x.platform}`)).toEqual([
			"1.0.3:win-x64",
			"1.0.3:linux-x64",
			"1.0.2:win-x64",
		]);
	});

	it("保护当前版本、活动版本和最新目标，并跳过 cleaned/deleting", () => {
		const plan = computeReleaseCleanupPlan({
			releases: [
			release("9.9.9", ReleaseStatus.FAILED),
			release("9.9.8", ReleaseStatus.UPDATING_CLIENTS),
			release("9.9.7", ReleaseStatus.DONE),
			release("9.9.6", ReleaseStatus.FAILED, oldDate, {
				"win-x64": archive("win-x64", "deleting"),
				"linux-x64": archive("linux-x64", "cleaned"),
			}),
		],
		now,
		currentServerVersion: "9.9.9",
		latestTargetVersion: "9.9.7",
		activeReleaseVersion: "9.9.8",
		backendKind: "local",
	});
		expect(plan.candidates).toEqual([]);
		expect(RELEASE_CLEANUP_POLICY).toEqual({
			successfulReleaseCount: 3,
			minimumAgeDays: 30,
			uploadSessionGraceHours: 24,
		});
	});

	it("Provider 不匹配时标记不可用且不计入可回收空间", () => {
		const plan = computeReleaseCleanupPlan({
			releases: [
			release("1.0.0", ReleaseStatus.FAILED, oldDate, {
				"win-x64": {
					...archive("win-x64"),
					storage: { provider: "alibaba", key: "secret", mode: "direct" },
				},
			}),
		],
		now,
		currentServerVersion: "9.9.9",
		latestTargetVersion: null,
		activeReleaseVersion: null,
		backendKind: "local",
	});
		expect(plan.candidates[0]?.providerState).toBe("provider_unavailable");
		expect(plan.candidates[0]?.archive.size).toBe(100);
	});
});
