import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ReleaseClientState,
	ReleaseStatus,
	platformFromOs,
} from "@vcpdeck/shared";
import type { ReleaseClientEntry, ReleaseInfo } from "@vcpdeck/shared";
import {
	canRetryClientUpdate,
	ReleaseOrchestrator,
} from "./release.orchestrator.js";

/** 测试机自身平台（断言下载 URL 用，避免依赖测试运行环境） */
const currentPlatform = platformFromOs(process.platform) ?? "win-x64";

function releaseInfo(overrides: Partial<ReleaseInfo> = {}): ReleaseInfo {
	return {
		version: "1.2.1",
		archives: {
			"win-x64": {
				sha256: "a".repeat(64),
				size: 1024,
				fileName: "vcpdeck-1.2.1-win-x64.zip",
			},
			"linux-x64": {
				sha256: "b".repeat(64),
				size: 2048,
				fileName: "vcpdeck-1.2.1-linux-x64.zip",
			},
		},
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
		release: vi.fn(),
	};
}

type OrchestratorDeps = {
	releases: ReturnType<typeof mockReleases>;
	channel: ReturnType<typeof mockChannel>;
	launcher: ReturnType<typeof mockLauncher>;
	drain: ReturnType<typeof mockDrain>;
	cleanup: { runAutomatic: ReturnType<typeof vi.fn> };
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		deps.cleanup as any,
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
			cleanup: { runAutomatic: vi.fn().mockResolvedValue(undefined) },
		};
		orchestrator = createOrchestrator(deps);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("startRelease", () => {
		it("按序执行：prepare → drain → 广播 → apply；apply 返回不再重复落库失败", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(null);

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.UPDATING_SERVER,
			);
			expect(deps.launcher.prepareUpdate).toHaveBeenCalledWith({
				version: "1.2.1",
				url: `/api/releases/1.2.1/file?platform=${currentPlatform}`,
				sha256: releaseInfo().archives[currentPlatform]!.sha256,
			});
			expect(deps.drain.drain).toHaveBeenCalled();
			expect(deps.channel.broadcastShutdown).toHaveBeenCalledWith({
				expectedVersion: "1.2.1",
			});
			expect(deps.launcher.applyUpdate).toHaveBeenCalled();
			expect(deps.releases.markFailed).not.toHaveBeenCalled();
		});

		it("缺少本机平台构件时直接标记 failed，不进入更新阶段", async () => {
			deps.releases.findByVersion.mockResolvedValue(
				releaseInfo({
					archives: { "linux-x64": releaseInfo().archives["linux-x64"] },
				}),
			);
			deps.releases.getActiveRelease.mockResolvedValue(null);

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("构件"),
			);
			expect(deps.releases.transitionStatus).not.toHaveBeenCalled();
			expect(deps.launcher.prepareUpdate).not.toHaveBeenCalled();
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

		it("drain 超时失败后显式解除闸门，恢复 Job 派发(回归:2026-10-07 生产死锁)", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(null);
			deps.drain.drain.mockRejectedValue(
				new Error("等待 job 收敛超时(仍有 1 个运行中)"),
			);

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("收敛超时"),
			);
			expect(deps.drain.release).toHaveBeenCalledTimes(1);
			expect(deps.channel.broadcastShutdown).not.toHaveBeenCalled();
		});

		it("drain 成功后 applyUpdate 失败同样解除闸门(进程不死则闸门常在)", async () => {
			deps.releases.findByVersion.mockResolvedValue(releaseInfo());
			deps.releases.getActiveRelease.mockResolvedValue(null);
			deps.drain.drain.mockResolvedValue(undefined);
			deps.launcher.applyUpdate.mockRejectedValue(new Error("apply 失败"));

			await orchestrator.startRelease("1.2.1");

			expect(deps.releases.markFailed).toHaveBeenCalledWith(
				"1.2.1",
				expect.stringContaining("apply 失败"),
			);
			expect(deps.drain.release).toHaveBeenCalledTimes(1);
		});
	});

	describe("resumeAfterStartup", () => {
		it("updating_server 且版本匹配 → 进入客户端阶段并逐个更新", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_SERVER }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
				{ clientId: "c3", clientVersion: "1.2.1", os: "win32 10.0.26200" },
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
					url: "/api/releases/1.2.1/file?platform=win-x64",
					sha256: releaseInfo().archives["win-x64"]!.sha256,
				}),
			);
			expect(deps.channel.sendUpdateRequest).toHaveBeenNthCalledWith(
				2,
				"c2",
				expect.objectContaining({
					url: "/api/releases/1.2.1/file?platform=linux-x64",
					sha256: releaseInfo().archives["linux-x64"]!.sha256,
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
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
				{ clientId: "c2", clientVersion: "1.1.0", os: "win32 10.0.26200" },
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
				{ kind: "transient" },
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
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
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
				{ kind: "transient" },
			);
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});

		it("其他 Client 更新期间上线的旧版本 Client 在当前循环结束后补更", async () => {
			const target = mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			let online = [
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			];
			deps.channel.listOnlineClients.mockImplementation(async () => online);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
					"c1",
					expect.objectContaining({ releaseVersion: "1.2.1" }),
				);
			});

			online = [
				...online,
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
			];
			orchestrator.onClientRegistered("c2", "1.1.0");
			online[0] = { ...online[0], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c1", "1.2.1");

			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
					"c2",
					expect.objectContaining({
						releaseVersion: "1.2.1",
						url: "/api/releases/1.2.1/file?platform=linux-x64",
					}),
				);
			});
			online[1] = { ...online[1], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c2", "1.2.1");
			await phase;

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c2",
				ReleaseClientState.DONE,
				undefined,
			);
		});

		it("补更 Client 重复注册只创建一个更新流程", async () => {
			const target = mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			let online = [
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			];
			deps.channel.listOnlineClients.mockImplementation(async () => online);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			online = [
				...online,
				{ clientId: "c2", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			];
			orchestrator.onClientRegistered("c2", "1.1.0");
			orchestrator.onClientRegistered("c2", "1.1.0");
			online[0] = { ...online[0], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c1", "1.2.1");

			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			});
			online[1] = { ...online[1], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c2", "1.2.1");
			await phase;

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
		});

		it("FAILED Client 后续以旧版本注册不再自动重试", async () => {
			const target = mockLoopRelease(deps, ReleaseStatus.DONE);
			target.clientStates.c1 = {
				state: ReleaseClientState.FAILED,
				reason: "回退",
				at: "2026-08-15T04:00:00.000Z",
			};
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			]);

			orchestrator.onClientRegistered("c1", "1.1.0");
			await Promise.resolve();

			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
		});

		it("Server 重启期间旧版本重连会重发一次更新请求", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});

			orchestrator.onClientRegistered("c1", "1.1.0");
			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			orchestrator.onClientRegistered("c1", "1.2.1");
			await phase;

			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c1",
				ReleaseClientState.DONE,
				undefined,
			);
		});

		it("不支持平台的客户端标记 failed 且不发送更新请求", async () => {
			deps.releases.getActiveRelease.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS }),
			);
			mockLoopRelease(deps, ReleaseStatus.UPDATING_CLIENTS);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "darwin 24.0" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			await orchestrator.resumeAfterStartup();

			expect(deps.releases.markClientState).toHaveBeenCalledWith(
				"1.2.1",
				"c1",
				"failed",
				expect.stringContaining("平台不受支持"),
				{ kind: "permanent" },
			);
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});
	});

	describe("补更重试判定", () => {
		const now = new Date("2026-10-14T12:00:00.000Z");

		/** 构造失败条目；at 以「距今多少分钟」表示，便于表达退避边界。 */
		function failed(
			minutesAgo: number,
			overrides: Partial<ReleaseClientEntry> = {},
		): ReleaseClientEntry {
			return {
				state: ReleaseClientState.FAILED,
				at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
				...overrides,
			};
		}

		it("从未失败过的客户端可重试", () => {
			expect(canRetryClientUpdate(undefined, now)).toBe(true);
		});

		it("永久失败在任何情况下都不可重试", () => {
			expect(
				canRetryClientUpdate(
					failed(10_000, { kind: "permanent", attempts: 0 }),
					now,
				),
			).toBe(false);
		});

		it("达到尝试上限后不可重试", () => {
			expect(
				canRetryClientUpdate(failed(10_000, { attempts: 2 }), now),
			).toBe(true);
			expect(
				canRetryClientUpdate(failed(10_000, { attempts: 3 }), now),
			).toBe(false);
		});

		it("退避未到期不可重试，恰好到期可重试", () => {
			// 第 0 次失败后等待 15 分钟
			expect(canRetryClientUpdate(failed(14, { attempts: 0 }), now)).toBe(
				false,
			);
			expect(canRetryClientUpdate(failed(15, { attempts: 0 }), now)).toBe(
				true,
			);
			// 第 1 次失败后等待 1 小时
			expect(canRetryClientUpdate(failed(30, { attempts: 1 }), now)).toBe(
				false,
			);
			expect(canRetryClientUpdate(failed(60, { attempts: 1 }), now)).toBe(
				true,
			);
			// 第 2 次失败后等待 6 小时
			expect(canRetryClientUpdate(failed(120, { attempts: 2 }), now)).toBe(
				false,
			);
			expect(canRetryClientUpdate(failed(360, { attempts: 2 }), now)).toBe(
				true,
			);
		});

		it("存量记录缺类别与次数时按瞬时失败与首段退避处理", () => {
			const legacy: ReleaseClientEntry = {
				state: ReleaseClientState.FAILED,
				reason: "等待重连注册超时",
				at: "2026-08-15T04:00:00.000Z",
			};
			expect(canRetryClientUpdate(legacy, now)).toBe(true);
			expect(
				canRetryClientUpdate(
					{ ...legacy, at: new Date(now.getTime() - 60_000).toISOString() },
					now,
				),
			).toBe(false);
		});

		it("可重试的 failed 客户端会被重新纳入补更", async () => {
			const target = releaseInfo({
				status: ReleaseStatus.UPDATING_CLIENTS,
				clientStates: {
					c2: {
						state: ReleaseClientState.FAILED,
						reason: "等待重连注册超时",
						at: "2026-08-15T04:00:00.000Z",
						kind: "transient",
						attempts: 1,
					},
				},
			});
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			// 更新循环串行：先派发 c1，等其重连后才轮到 c2
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
					"c2",
					expect.objectContaining({ releaseVersion: "1.2.1" }),
				);
			});
			orchestrator.onClientRegistered("c2", "1.2.1");
			await phase;
		});

		it("永久失败与超过上限的客户端不会被补更", async () => {
			const target = releaseInfo({
				status: ReleaseStatus.UPDATING_CLIENTS,
				clientStates: {
					c2: {
						state: ReleaseClientState.FAILED,
						at: "2026-08-15T04:00:00.000Z",
						kind: "permanent",
						attempts: 1,
					},
					c3: {
						state: ReleaseClientState.FAILED,
						at: "2026-08-15T04:00:00.000Z",
						kind: "transient",
						attempts: 3,
					},
				},
			});
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
				{ clientId: "c3", clientVersion: "1.1.0", os: "linux 6.8 x64" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await phase;

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
				"c1",
				expect.objectContaining({ releaseVersion: "1.2.1" }),
			);
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalledWith(
				"c2",
				expect.anything(),
			);
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalledWith(
				"c3",
				expect.anything(),
			);
		});
		it("周期对账与进行中的阶段共用互斥，不并发开启第二条循环", async () => {
			const target = releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS });
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			// 阶段进行中：对账必须复用同一条循环而不是新开一条
			const sweeps = [
				orchestrator.sweepCatchUp(),
				orchestrator.sweepCatchUp(),
			];
			orchestrator.onClientRegistered("c1", "1.2.1");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
			});
			orchestrator.onClientRegistered("c2", "1.2.1");
			await Promise.all([phase, ...sweeps]);

			// 每台机器只被派发一次，没有重复循环
			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
		});

		it("周期对账在无补更目标时不派发任何请求", async () => {
			deps.releases.getLatestActiveTarget.mockResolvedValue(null);

			await orchestrator.sweepCatchUp();

			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
		});
	});

	describe("人工强制重试", () => {
		const overLimit = {
			state: ReleaseClientState.FAILED,
			reason: "等待重连注册超时",
			at: "2026-10-14T00:00:00.000Z",
			kind: "transient" as const,
			attempts: 3,
		};

		it("已超过次数上限的瞬时失败客户端仍可被强制重试", async () => {
			const target = releaseInfo({
				status: ReleaseStatus.UPDATING_CLIENTS,
				clientStates: { c1: overLimit },
			});
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const retry = orchestrator.retryClient("1.2.1", "c1");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await expect(retry).resolves.toEqual({
				version: "1.2.1",
				clientId: "c1",
			});

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
				"c1",
				expect.objectContaining({ releaseVersion: "1.2.1" }),
			);
		});

		it("永久失败即使人工强制也不重试", async () => {
			deps.releases.findByVersion.mockResolvedValue(
				releaseInfo({
					status: ReleaseStatus.DONE,
					clientStates: {
						c1: {
							state: ReleaseClientState.FAILED,
							reason: "平台不受支持或构件缺失: darwin",
							at: "2026-10-14T00:00:00.000Z",
							kind: "permanent",
							attempts: 1,
						},
					},
				}),
			);

			await expect(
				orchestrator.retryClient("1.2.1", "c1"),
			).rejects.toMatchObject({ code: "RELEASE_RETRY_NOT_ALLOWED" });
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
		});

		it("未知版本与未知机器分别返回稳定错误码", async () => {
			deps.releases.findByVersion.mockResolvedValue(null);
			await expect(
				orchestrator.retryClient("9.9.9", "c1"),
			).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });

			deps.releases.findByVersion.mockResolvedValue(
				releaseInfo({ status: ReleaseStatus.DONE }),
			);
			deps.channel.listOnlineClients.mockResolvedValue([]);
			await expect(
				orchestrator.retryClient("1.2.1", "c9"),
			).rejects.toMatchObject({ code: "RELEASE_CLIENT_NOT_FOUND" });
			expect(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
		});
	});

	describe("周期对账直接捞起失败客户端", () => {
		it("可重试的 failed 客户端在退避到期后由对账重新派发", async () => {
			const target = releaseInfo({
				status: ReleaseStatus.DONE,
				clientStates: {
					c1: {
						state: ReleaseClientState.FAILED,
						reason: "等待重连注册超时",
						at: "2026-08-15T00:00:00.000Z",
						kind: "transient",
						attempts: 1,
					},
				},
			});
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			deps.channel.listOnlineClients.mockResolvedValue([
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			const sweep = orchestrator.sweepCatchUp();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			orchestrator.onClientRegistered("c1", "1.2.1");
			await sweep;

			expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
				"c1",
				expect.objectContaining({ releaseVersion: "1.2.1" }),
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
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			]);
			deps.releases.markClientState.mockResolvedValue({});

			orchestrator.onClientRegistered("c2", "1.1.0");
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
			expect(deps.releases.transitionStatus).not.toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
		});

		it("原循环收尾后上线的旧版本 Client 仍会补更，且 DONE Release 不重复流转", async () => {
			const target = releaseInfo({ status: ReleaseStatus.UPDATING_CLIENTS });
			deps.releases.getActiveRelease.mockResolvedValue(target);
			deps.releases.getLatestActiveTarget.mockResolvedValue(target);
			deps.releases.findByVersion.mockResolvedValue(target);
			let online = [
				{ clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
			];
			deps.channel.listOnlineClients.mockImplementation(async () => online);
			deps.releases.markClientState.mockResolvedValue({});

			const phase = orchestrator.resumeAfterStartup();
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
			});
			online[0] = { ...online[0], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c1", "1.2.1");
			await phase;

			target.status = ReleaseStatus.DONE;
			online = [
				...online,
				{ clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
			];
			orchestrator.onClientRegistered("c2", "1.1.0");
			await vi.waitFor(() => {
				expect(deps.channel.sendUpdateRequest).toHaveBeenCalledWith(
					"c2",
					expect.objectContaining({
						releaseVersion: "1.2.1",
						url: "/api/releases/1.2.1/file?platform=linux-x64",
					}),
				);
			});
			online[1] = { ...online[1], clientVersion: "1.2.1" };
			orchestrator.onClientRegistered("c2", "1.2.1");

			expect(deps.releases.transitionStatus).toHaveBeenCalledTimes(1);
			expect(deps.releases.transitionStatus).toHaveBeenCalledWith(
				"1.2.1",
				ReleaseStatus.DONE,
			);
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
