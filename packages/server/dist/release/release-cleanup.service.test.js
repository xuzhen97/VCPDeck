"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const release_cleanup_service_js_1 = require("./release-cleanup.service.js");
const now = new Date("2026-08-29T00:00:00.000Z");
const archive = (platform, availability = "available") => ({
    sha256: "a".repeat(64),
    size: platform === "win-x64" ? 100 : 200,
    fileName: `${platform}.zip`,
    availability,
});
function release(overrides = {}) {
    return {
        version: "1.0.0",
        status: shared_1.ReleaseStatus.FAILED,
        archives: {
            "win-x64": archive("win-x64"),
            "linux-x64": archive("linux-x64"),
        },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        clientStates: {},
        ...overrides,
    };
}
function fixture(releases = [release()], options = {}) {
    const backend = options.backend ?? "local";
    const rows = [
        {
            id: "session-1",
            version: "9.0.0",
            platform: "win-x64",
            size: 50,
            provider: options.sessionProvider ?? backend,
            providerKey: "provider-key",
            providerUploadId: "upload-1",
            partSize: 10,
            status: "pending",
            expiresAt: new Date("2026-07-01T00:00:00.000Z"),
        },
    ];
    const prisma = {
        releaseUploadSession: {
            findMany: vitest_1.vi.fn(async () => rows),
            delete: vitest_1.vi.fn(async ({ where }) => {
                const index = rows.findIndex((row) => row.id === where.id);
                if (index >= 0)
                    rows.splice(index, 1);
            }),
        },
    };
    const releaseService = {
        listForCleanup: vitest_1.vi.fn(async () => releases),
        findByVersion: vitest_1.vi.fn(async (version) => releases.find((item) => item.version === version) ?? null),
        findByVersionWithStorage: vitest_1.vi.fn(async (version) => releases.find((item) => item.version === version) ?? null),
        getLatestActiveTarget: vitest_1.vi.fn(async () => null),
        getActiveRelease: vitest_1.vi.fn(async () => null),
        claimArchiveForCleanup: vitest_1.vi.fn(async (version, platform) => {
            const item = releases.find((value) => value.version === version);
            const current = item?.archives[platform];
            if (!current || current.availability === "cleaned")
                return null;
            current.availability = "deleting";
            return current;
        }),
        finishArchiveCleanup: vitest_1.vi.fn(async (version, platform) => {
            const item = releases.find((value) => value.version === version);
            const current = item?.archives[platform];
            if (!current || current.availability !== "deleting")
                return false;
            current.availability = "cleaned";
            return true;
        }),
        restoreArchiveAfterCleanup: vitest_1.vi.fn(async (version, platform) => {
            const item = releases.find((value) => value.version === version);
            const current = item?.archives[platform];
            if (!current || current.availability !== "deleting")
                return false;
            current.availability = "available";
            return true;
        }),
    };
    const storage = {
        getBackendConfig: vitest_1.vi.fn(async () => ({ kind: backend, updatedAt: null })),
        delete: vitest_1.vi.fn(async () => undefined),
    };
    const removeLocal = vitest_1.vi.fn(async () => undefined);
    const service = new release_cleanup_service_js_1.ReleaseCleanupService(prisma, releaseService, storage, { now: () => now, removeLocal });
    return { service, prisma, releaseService, storage, removeLocal, rows };
}
(0, vitest_1.describe)("ReleaseCleanupService", () => {
    (0, vitest_1.it)("preview 按平台聚合候选并隐藏 Provider key", async () => {
        const { service } = fixture();
        const preview = await service.preview();
        (0, vitest_1.expect)(preview.candidates).toEqual([
            {
                version: "1.0.0",
                status: shared_1.ReleaseStatus.FAILED,
                archives: [
                    { platform: "win-x64", bytes: 100, providerState: "ready" },
                    { platform: "linux-x64", bytes: 200, providerState: "ready" },
                ],
                bytes: 300,
                reason: "retention_policy",
            },
        ]);
        (0, vitest_1.expect)(JSON.stringify(preview)).not.toContain("provider-key");
        (0, vitest_1.expect)(preview.expiredUploadSessions).toEqual({ count: 1, bytes: 50 });
        (0, vitest_1.expect)(preview.estimatedReclaimableBytes).toBe(350);
    });
    (0, vitest_1.it)("Local run 按 claim → 删除 → finish 顺序执行", async () => {
        const { service, releaseService, removeLocal } = fixture();
        const result = await service.run();
        (0, vitest_1.expect)(removeLocal).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(releaseService.claimArchiveForCleanup).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(releaseService.finishArchiveCleanup).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(result.cleanedItems).toBe(3);
        (0, vitest_1.expect)(result.cleanedBytes).toBe(350);
    });
    (0, vitest_1.it)("删除失败恢复 available 并报告可重试错误", async () => {
        const { service, releaseService, removeLocal } = fixture();
        removeLocal.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
        const result = await service.run();
        (0, vitest_1.expect)(releaseService.restoreArchiveAfterCleanup).toHaveBeenCalledWith("1.0.0", "win-x64");
        (0, vitest_1.expect)(result.failed).toBe(1);
        (0, vitest_1.expect)(result.retryable).toBe(true);
        (0, vitest_1.expect)(result.issues[0]).toEqual({
            version: "1.0.0",
            platform: "win-x64",
            code: "RELEASE_CLEANUP_DELETE_FAILED",
        });
    });
    (0, vitest_1.it)("过期上传会话先删除 Provider 对象再删除 DB 记录", async () => {
        const { service, storage, prisma } = fixture([], { backend: "alibaba" });
        await service.run();
        (0, vitest_1.expect)(storage.delete).toHaveBeenCalledWith("provider-key");
        (0, vitest_1.expect)(prisma.releaseUploadSession.delete).toHaveBeenCalledWith({
            where: { id: "session-1" },
        });
    });
    (0, vitest_1.it)("上传会话 Provider 不匹配时不删除对象、不删除 DB 记录", async () => {
        const { service, storage, prisma, rows } = fixture([], {
            backend: "local",
            sessionProvider: "alibaba",
        });
        const result = await service.run();
        (0, vitest_1.expect)(storage.delete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(prisma.releaseUploadSession.delete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(result.providerUnavailable).toBe(1);
        (0, vitest_1.expect)(result.issues).toContainEqual({
            version: "9.0.0",
            code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
        });
        (0, vitest_1.expect)(rows).toHaveLength(1);
    });
    (0, vitest_1.it)("archive Provider 不匹配时不删除、不清除 key", async () => {
        const item = release({
            archives: {
                "win-x64": {
                    ...archive("win-x64"),
                    storage: { provider: "alibaba", key: "provider-key", mode: "direct" },
                },
            },
        });
        const { service, storage, rows } = fixture([item]);
        rows.splice(0);
        const preview = await service.preview();
        const result = await service.run();
        (0, vitest_1.expect)(preview.candidates[0]?.archives[0]?.providerState).toBe("provider_unavailable");
        (0, vitest_1.expect)(storage.delete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(result.providerUnavailable).toBe(1);
    });
    (0, vitest_1.it)("并发 run 返回 RELEASE_CLEANUP_BUSY", async () => {
        const { service, removeLocal } = fixture();
        let releaseDelete = () => undefined;
        let startedResolve = () => undefined;
        const started = new Promise((resolve) => {
            startedResolve = resolve;
        });
        let firstDelete = true;
        removeLocal.mockImplementation(() => {
            if (!firstDelete)
                return Promise.resolve(undefined);
            firstDelete = false;
            return new Promise((resolve) => {
                startedResolve();
                releaseDelete = () => resolve(undefined);
            });
        });
        const first = service.run();
        await started;
        await (0, vitest_1.expect)(service.run()).rejects.toMatchObject({
            code: "RELEASE_CLEANUP_BUSY",
        });
        releaseDelete();
        await first;
    });
});
