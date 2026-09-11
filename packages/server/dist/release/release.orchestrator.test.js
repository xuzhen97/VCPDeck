"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const release_orchestrator_js_1 = require("./release.orchestrator.js");
/** 测试机自身平台（断言下载 URL 用，避免依赖测试运行环境） */
const currentPlatform = (0, shared_1.platformFromOs)(process.platform) ?? "win-x64";
function releaseInfo(overrides = {}) {
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
        status: shared_1.ReleaseStatus.UPLOADED,
        errorMessage: null,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
        clientStates: {},
        ...overrides,
    };
}
function mockReleases() {
    return {
        findByVersion: vitest_1.vi.fn(),
        transitionStatus: vitest_1.vi.fn(),
        markClientState: vitest_1.vi.fn(),
        markFailed: vitest_1.vi.fn(),
        getActiveRelease: vitest_1.vi.fn(),
        getLatestActiveTarget: vitest_1.vi.fn(),
    };
}
function mockChannel() {
    return {
        listOnlineClients: vitest_1.vi.fn(),
        sendUpdateRequest: vitest_1.vi.fn(),
        broadcastShutdown: vitest_1.vi.fn(),
    };
}
function mockLauncher() {
    return {
        prepareUpdate: vitest_1.vi.fn(),
        applyUpdate: vitest_1.vi.fn(),
    };
}
function mockDrain() {
    return {
        drain: vitest_1.vi.fn(),
    };
}
function createOrchestrator(deps, opts = {}) {
    return new release_orchestrator_js_1.ReleaseOrchestrator(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.releases, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.channel, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.launcher, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.drain, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.cleanup, { serverVersion: "1.2.1", clientTimeoutMs: 60_000, ...opts });
}
/** 客户端循环运行期间 findByVersion 需返回目标 release */
function mockLoopRelease(deps, status) {
    const info = releaseInfo({ status });
    deps.releases.findByVersion.mockResolvedValue(info);
    return info;
}
(0, vitest_1.describe)("ReleaseOrchestrator", () => {
    let deps;
    let orchestrator;
    (0, vitest_1.beforeEach)(() => {
        deps = {
            releases: mockReleases(),
            channel: mockChannel(),
            launcher: mockLauncher(),
            drain: mockDrain(),
            cleanup: { runAutomatic: vitest_1.vi.fn().mockResolvedValue(undefined) },
        };
        orchestrator = createOrchestrator(deps);
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.describe)("startRelease", () => {
        (0, vitest_1.it)("按序执行：prepare → drain → 广播 → apply；apply 返回不再重复落库失败", async () => {
            deps.releases.findByVersion.mockResolvedValue(releaseInfo());
            deps.releases.getActiveRelease.mockResolvedValue(null);
            await orchestrator.startRelease("1.2.1");
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.UPDATING_SERVER);
            (0, vitest_1.expect)(deps.launcher.prepareUpdate).toHaveBeenCalledWith({
                version: "1.2.1",
                url: `/api/releases/1.2.1/file?platform=${currentPlatform}`,
                sha256: releaseInfo().archives[currentPlatform].sha256,
            });
            (0, vitest_1.expect)(deps.drain.drain).toHaveBeenCalled();
            (0, vitest_1.expect)(deps.channel.broadcastShutdown).toHaveBeenCalledWith({
                expectedVersion: "1.2.1",
            });
            (0, vitest_1.expect)(deps.launcher.applyUpdate).toHaveBeenCalled();
            (0, vitest_1.expect)(deps.releases.markFailed).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("缺少本机平台构件时直接标记 failed，不进入更新阶段", async () => {
            deps.releases.findByVersion.mockResolvedValue(releaseInfo({
                archives: { "linux-x64": releaseInfo().archives["linux-x64"] },
            }));
            deps.releases.getActiveRelease.mockResolvedValue(null);
            await orchestrator.startRelease("1.2.1");
            (0, vitest_1.expect)(deps.releases.markFailed).toHaveBeenCalledWith("1.2.1", vitest_1.expect.stringContaining("构件"));
            (0, vitest_1.expect)(deps.releases.transitionStatus).not.toHaveBeenCalled();
            (0, vitest_1.expect)(deps.launcher.prepareUpdate).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("已有活动 release 时抛 RELEASE_ORCHESTRATOR_BUSY，不动 launcher", async () => {
            deps.releases.findByVersion.mockResolvedValue(releaseInfo());
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            await (0, vitest_1.expect)(orchestrator.startRelease("1.2.1")).rejects.toMatchObject({
                code: "RELEASE_ORCHESTRATOR_BUSY",
            });
            (0, vitest_1.expect)(deps.launcher.prepareUpdate).not.toHaveBeenCalled();
            (0, vitest_1.expect)(deps.releases.transitionStatus).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("prepare 失败时标记 failed", async () => {
            deps.releases.findByVersion.mockResolvedValue(releaseInfo());
            deps.releases.getActiveRelease.mockResolvedValue(null);
            deps.launcher.prepareUpdate.mockRejectedValue(new Error("下载失败"));
            await orchestrator.startRelease("1.2.1");
            (0, vitest_1.expect)(deps.releases.markFailed).toHaveBeenCalledWith("1.2.1", vitest_1.expect.stringContaining("下载失败"));
            (0, vitest_1.expect)(deps.channel.broadcastShutdown).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("resumeAfterStartup", () => {
        (0, vitest_1.it)("updating_server 且版本匹配 → 进入客户端阶段并逐个更新", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_SERVER }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
                { clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
                { clientId: "c3", clientVersion: "1.2.1", os: "win32 10.0.26200" },
            ]);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            // c1 收到更新请求后重连注册新版本 → 轮到 c2
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            orchestrator.onClientRegistered("c1", "1.2.1");
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
            });
            orchestrator.onClientRegistered("c2", "1.2.1");
            await phase;
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.UPDATING_CLIENTS);
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenNthCalledWith(1, "c1", vitest_1.expect.objectContaining({
                releaseVersion: "1.2.1",
                url: "/api/releases/1.2.1/file?platform=win-x64",
                sha256: releaseInfo().archives["win-x64"].sha256,
            }));
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenNthCalledWith(2, "c2", vitest_1.expect.objectContaining({
                url: "/api/releases/1.2.1/file?platform=linux-x64",
                sha256: releaseInfo().archives["linux-x64"].sha256,
            }));
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", "done", undefined);
            // c3 已是最新，不参与更新
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).not.toHaveBeenCalledWith("c3", vitest_1.expect.anything());
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("updating_server 且版本不匹配（launcher 回退）→ 标记 failed", async () => {
            const reverted = createOrchestrator(deps, { serverVersion: "1.1.0" });
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_SERVER }));
            await reverted.resumeAfterStartup();
            (0, vitest_1.expect)(deps.releases.markFailed).toHaveBeenCalledWith("1.2.1", vitest_1.expect.stringContaining("版本不符"));
        });
        (0, vitest_1.it)("updating_clients（崩溃恢复）→ 直接续跑客户端阶段", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([]);
            await orchestrator.resumeAfterStartup();
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("无活动 release 时不做事", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(null);
            await orchestrator.resumeAfterStartup();
            (0, vitest_1.expect)(deps.channel.listOnlineClients).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("客户端循环", () => {
        (0, vitest_1.it)("超时的客户端标记 failed 并继续下一台", async () => {
            vitest_1.vi.useFakeTimers();
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
                { clientId: "c2", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ]);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            // c1 超时 → 轮到 c2
            await vitest_1.vi.advanceTimersByTimeAsync(60_000);
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
            });
            orchestrator.onClientRegistered("c2", "1.2.1");
            await phase;
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", "failed", "等待重连注册超时");
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c2", "done", undefined);
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("onUpdateFailed 立即标记 failed 并继续", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ]);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            orchestrator.onUpdateFailed("c1", "1.2.1", "校验失败");
            await phase;
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", "failed", "校验失败");
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("其他 Client 更新期间上线的旧版本 Client 在当前循环结束后补更", async () => {
            const target = mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.releases.getActiveRelease.mockResolvedValue(target);
            deps.releases.getLatestActiveTarget.mockResolvedValue(target);
            let online = [
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ];
            deps.channel.listOnlineClients.mockImplementation(async () => online);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledWith("c1", vitest_1.expect.objectContaining({ releaseVersion: "1.2.1" }));
            });
            online = [
                ...online,
                { clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
            ];
            orchestrator.onClientRegistered("c2", "1.1.0");
            online[0] = { ...online[0], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c1", "1.2.1");
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledWith("c2", vitest_1.expect.objectContaining({
                    releaseVersion: "1.2.1",
                    url: "/api/releases/1.2.1/file?platform=linux-x64",
                }));
            });
            online[1] = { ...online[1], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c2", "1.2.1");
            await phase;
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c2", shared_1.ReleaseClientState.DONE, undefined);
        });
        (0, vitest_1.it)("补更 Client 重复注册只创建一个更新流程", async () => {
            const target = mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.releases.getActiveRelease.mockResolvedValue(target);
            deps.releases.getLatestActiveTarget.mockResolvedValue(target);
            let online = [
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ];
            deps.channel.listOnlineClients.mockImplementation(async () => online);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            online = [
                ...online,
                { clientId: "c2", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ];
            orchestrator.onClientRegistered("c2", "1.1.0");
            orchestrator.onClientRegistered("c2", "1.1.0");
            online[0] = { ...online[0], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c1", "1.2.1");
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
            });
            online[1] = { ...online[1], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c2", "1.2.1");
            await phase;
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
        });
        (0, vitest_1.it)("FAILED Client 后续以旧版本注册不再自动重试", async () => {
            const target = mockLoopRelease(deps, shared_1.ReleaseStatus.DONE);
            target.clientStates.c1 = {
                state: shared_1.ReleaseClientState.FAILED,
                reason: "回退",
                at: "2026-08-15T04:00:00.000Z",
            };
            deps.releases.getLatestActiveTarget.mockResolvedValue(target);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ]);
            orchestrator.onClientRegistered("c1", "1.1.0");
            await Promise.resolve();
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("Server 重启期间旧版本重连会重发一次更新请求", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ]);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            orchestrator.onClientRegistered("c1", "1.1.0");
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(2);
            orchestrator.onClientRegistered("c1", "1.2.1");
            await phase;
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", shared_1.ReleaseClientState.DONE, undefined);
        });
        (0, vitest_1.it)("不支持平台的客户端标记 failed 且不发送更新请求", async () => {
            deps.releases.getActiveRelease.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS }));
            mockLoopRelease(deps, shared_1.ReleaseStatus.UPDATING_CLIENTS);
            deps.channel.listOnlineClients.mockResolvedValue([
                { clientId: "c1", clientVersion: "1.1.0", os: "darwin 24.0" },
            ]);
            deps.releases.markClientState.mockResolvedValue({});
            await orchestrator.resumeAfterStartup();
            (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", "failed", vitest_1.expect.stringContaining("平台不受支持"));
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
    });
    (0, vitest_1.describe)("离线补更", () => {
        (0, vitest_1.it)("旧版本客户端注册时触发补更（failed 的客户端不再重试）", async () => {
            const target = releaseInfo({
                status: shared_1.ReleaseStatus.DONE,
                clientStates: {
                    c2: {
                        state: shared_1.ReleaseClientState.FAILED,
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
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            orchestrator.onClientRegistered("c1", "1.2.1");
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.releases.markClientState).toHaveBeenCalledWith("1.2.1", "c1", "done", undefined);
            });
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledWith("c1", vitest_1.expect.objectContaining({ releaseVersion: "1.2.1" }));
            // 循环结束，仅 c1 被更新过（c2 已 failed，不重试）
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(deps.releases.transitionStatus).not.toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("原循环收尾后上线的旧版本 Client 仍会补更，且 DONE Release 不重复流转", async () => {
            const target = releaseInfo({ status: shared_1.ReleaseStatus.UPDATING_CLIENTS });
            deps.releases.getActiveRelease.mockResolvedValue(target);
            deps.releases.getLatestActiveTarget.mockResolvedValue(target);
            deps.releases.findByVersion.mockResolvedValue(target);
            let online = [
                { clientId: "c1", clientVersion: "1.1.0", os: "win32 10.0.26200" },
            ];
            deps.channel.listOnlineClients.mockImplementation(async () => online);
            deps.releases.markClientState.mockResolvedValue({});
            const phase = orchestrator.resumeAfterStartup();
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledTimes(1);
            });
            online[0] = { ...online[0], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c1", "1.2.1");
            await phase;
            target.status = shared_1.ReleaseStatus.DONE;
            online = [
                ...online,
                { clientId: "c2", clientVersion: "1.1.0", os: "linux 6.8 x64" },
            ];
            orchestrator.onClientRegistered("c2", "1.1.0");
            await vitest_1.vi.waitFor(() => {
                (0, vitest_1.expect)(deps.channel.sendUpdateRequest).toHaveBeenCalledWith("c2", vitest_1.expect.objectContaining({
                    releaseVersion: "1.2.1",
                    url: "/api/releases/1.2.1/file?platform=linux-x64",
                }));
            });
            online[1] = { ...online[1], clientVersion: "1.2.1" };
            orchestrator.onClientRegistered("c2", "1.2.1");
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(deps.releases.transitionStatus).toHaveBeenCalledWith("1.2.1", shared_1.ReleaseStatus.DONE);
        });
        (0, vitest_1.it)("已是最新版本的客户端注册不触发更新", () => {
            deps.releases.getLatestActiveTarget.mockResolvedValue(releaseInfo({ status: shared_1.ReleaseStatus.DONE }));
            orchestrator.onClientRegistered("c1", "1.2.1");
            (0, vitest_1.expect)(deps.channel.sendUpdateRequest).not.toHaveBeenCalled();
        });
    });
});
