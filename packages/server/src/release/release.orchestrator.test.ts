import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseClientState, ReleaseStatus } from "@vcpdeck/shared";
import type { ReleaseInfo } from "@vcpdeck/shared";
import { ReleaseOrchestrator } from "./release.orchestrator.js";

function releaseInfo(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
	return {
		version: "1.2.1",
		sha256: "a".repeat(64),
		size: 1024,
		status: ReleaseStatus.UPLOADED,
		errorMessage: null,
		createdAt: "2026-06-15T00:00:00.000Z",
		updatedAt: "2026-06-15T00:00:00.000Z",
		clientStates: {},
		...overrides,
	};
}

function mockReleases() {
	return {
		findByVersion: vi.fn(),
		transitionStatus: vi.fn(),
		markClientState: vi.fn(),
		markFailed: vi.fn(),
		getActiveRelease: vi.fn(),
		getLatestActiveTarget: vi.fn(),
	};
}

function mockChannel() {
	return {
		listOnlineClients: vi.fn(),
		sendUpdateRequest: vi.fn(),
		broadcastShutdown: vi.fn(),
	};
}

function mockLauncher() {
	return {
		prepareUpdate: vi.fn(),
		applyUpdate: vi.fn(),
	};
}

function mockDrain() {
	return {
		drain: vi.fn(),
	};
}

type OrchestratorDeps = {
	releases: ReturnType<typeof mockReleases>;
	channel: ReturnType<typeof mockChannel>;
	launcher: ReturnType<typeof mockLauncher>;
	drain: ReturnType<typeof mockDrain>;
};

function createOrchestrator(deps: OrchestratorDeps, opts = {}) {
	return new ReleaseOrchestrator(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		deps.releases as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		deps.channel as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		deps.launcher as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		deps.drain as any,
		{ serverVersion: "1.2.1", clientTimeoutMs: 60_000, ...opts },
	);
}

/** 客户端循环运行期间 findByVersion 需返回目标 release */
function mockLoopRelease(deps: OrchestratorDeps, status: ReleaseStatus) {
	const info = releaseInfo({ status });
	deps.releases.findByVersion.mockResolvedValue(info);
	return info;
}

describe("ReleaseOrchestrator", () => {
	let deps: OrchestratorDeps;
	let orchestrator: ReleaseOrchestrator;

	beforeEach(() => {
		deps = {
			releases: mockReleases(),
			channel: mockChannel(),
			launcher: mockLauncher(),
			drain: mockDrain(),
		};
		orchestrator = createOrchestrator(deps);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("startRelease", () => {
		it("按序执行：prepare → drain → 广播 → apply；apply 正常返回视为失败", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(null);

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.UPDATING_SERVER,
			);
			expect(deps.launcher.prepareUpdate).toHaveBeenCalledWith({
				version: "1.2.1",
				url: "/api/releases/1.2.1/file",
				sha256: "a".repeat(64),
			});
			expect(deps.drain.drain).toHaveBeenCalled();
			expect(deps.channel.broadcastShutdown).toHaveBeenCalledWith({
				expectedVersion: "1.2.1",
			});
			expect(deps.launcher.applyUpdate).toHaveBeenCalled();
			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("applyUpdate"),
			);
		});

		it("已有活动 release 时抛 RELEASE_ORCHESTRATOR_BUSY，不动 launcher", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);

			await expect(orchestrator.startRelease("1.2.1")).rejects.toMatchObject({
				code: "RELEASE_ORCHESTRATOR_BUSY",
			});
			expect(deps.launcher.prepareUpdate).not.toHaveBeenCalled();
			expect(deps.releases.transitionStatus).not.toHaveBeenCalled();
		});

		it("prepare 失败时标记 failed", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(null);
			deps.launcher.prepareUpdate.mockRejectedValue(new Error("下载失败"));

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("下载失败"),
			);
			expect(deps.channel.broadcastShutdown).not.toHaveBeenCalled();
		});
	});

	describe("resumeAfterStartup", () => {
		it("updating_server 且版本匹配 → 进入客户端阶段并逐个更新", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_SERVER }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_SERVER);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0" },
				{ clientId: "c2", clientVersion: "1.1.0" },
				{ clientId: "c3", clientVersion: "1.2.1" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			// c1 收到更新请求后重连注册新版本 → 轮到 c2
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			});
			orchestrator.onClientRegistered("c2", "1.2.1");
			await phase;

			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.UPDATING_CLIENTS,
			);
			expect(deps.channel.sendUpdateRequest).toHaveBeenNthCalledWith(
				1,
				"c1",
				expect.objectContaining({
					releaseVersion: "1.2.1",
					url: "/api/releases/1.2.1/file",
				}),
			);
			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c1",
				"done",
				undefined,
			);
			// c3 已是最新，不参与更新
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalledWith(
				"c3",
				expect.anything(),
			);
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});

		it("updating_server 且版本不匹配（launcher 回退）→ 标记 failed", async () => {
			const reverted = createOrchestrator(deps, { serverVersion: "1.1.0" });
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_SERVER }),
			);

			await reverted.resumeAfterStartup();

			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("版本不符"),
			);
		});

		it("updating_clients（崩溃恢复）→ 直接续跑客户端阶段", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([]);

			await orchestrator.resumeAfterStartup();

			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});

		it("无活动 release 时不做事", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(null);

			await orchestrator.resumeAfterStartup();

			expect(deps.channel.listOnlineClients).not.toHaveBeenCalled();
		});
	});

	describe("客户端循环", () => {
		it("超时的客户端标记 failed 并继续下一台", async () => {
			vi.useFakeTimers();
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0" },
				{ clientId: "c2", clientVersion: "1.1.0" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			// c1 超时 → 轮到 c2
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			});
			orchestrator.onClientRegistered("c2", "1.2.1");
			await phase;

			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c1",
				"failed",
				"等待重连注册超时",
			);
			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c2",
				"done",
				undefined,
			);
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});

		it("onUpdateFailed 立即标记 failed 并继续", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onUpdateFailed("c1", "1.2.1", "校验失败");
			await phase;

			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c1",
				"failed",
				"校验失败",
			);
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});
	});

	describe("离线补更", () => {
		it("旧版本客户端注册时触发补更（failed 的客户端不再重试）", async () => {
			const target = releaseInfo({
				status: ReleaseStatus.DONE,
				clientStates: {
					c2: {
						state: ReleaseClientState.FAILED,
						reason: "回退",
						at: "2026-08-15T04:00:00.000Z",
					},
				},
			});
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			orchestrator.onClientRegistered("c1", "1.1.0");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await vi.waitFor(() => {
				expect(deps.releases.markClientState).toHaveBeenCalledWith(
					"1.2.1",
					"c1",
					"done",
					undefined,
				);
			});

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
				"c1",
				expect.objectContaining({ releaseVersion: "1.2.1" }),
			);
			// 循环结束，仅 c1 被更新过（c2 已 failed，不重试）
			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
		});

		it("已是最新版本的客户端注册不触发更新", () => {
			deps.releases.getLatestActiveTarget.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.DONE }),
			);

			orchestrator.onClientRegistered("c1", "1.2.1");

			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
		});
	});
});
