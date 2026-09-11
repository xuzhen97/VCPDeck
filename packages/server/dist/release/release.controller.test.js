"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_stream_1 = require("node:stream");
const vitest_1 = require("vitest");
const release_controller_js_1 = require("./release.controller.js");
const release_service_js_1 = require("./release.service.js");
function mockService() {
    const findByVersion = vitest_1.vi.fn();
    return {
        create: vitest_1.vi.fn(),
        addArchive: vitest_1.vi.fn(),
        hasAllArchives: vitest_1.vi.fn(),
        list: vitest_1.vi.fn(),
        findByVersion,
        findByVersionWithStorage: findByVersion,
        verifyZipSha256: vitest_1.vi.fn(),
    };
}
function mockRes() {
    return {
        sendFile: vitest_1.vi.fn(),
        redirect: vitest_1.vi.fn(),
        status: vitest_1.vi.fn().mockReturnValue({ json: vitest_1.vi.fn() }),
    };
}
function mockOrchestrator() {
    return { startRelease: vitest_1.vi.fn() };
}
function mockStorage() {
    return {
        getBackendConfig: vitest_1.vi
            .fn()
            .mockResolvedValue({ kind: "local", updatedAt: null }),
        supportsDirectDownload: vitest_1.vi.fn().mockReturnValue(false),
        getDirectDownloadUrl: vitest_1.vi.fn(),
        uploadStream: vitest_1.vi.fn(),
    };
}
/** 捕获 Promise 拒绝并断言 HTTP 错误形态 */
async function catchHttpError(p) {
    try {
        await p;
        throw new Error("预期被拒绝，但调用成功了");
    }
    catch (e) {
        return e;
    }
}
(0, vitest_1.describe)("ReleaseController", () => {
    let service;
    let orchestrator;
    let storage;
    let controller;
    let dir;
    let releasesDir;
    (0, vitest_1.beforeEach)(async () => {
        service = mockService();
        service.findByVersionWithStorage = service.findByVersion;
        orchestrator = mockOrchestrator();
        orchestrator.startRelease.mockResolvedValue(undefined);
        storage = mockStorage();
        dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "release-ctrl-"));
        releasesDir = (0, node_path_1.join)(dir, "releases");
        process.env.VCPDECK_RELEASES_DIR = releasesDir;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        controller = new release_controller_js_1.ReleaseController(service, orchestrator, storage);
    });
    (0, vitest_1.afterEach)(async () => {
        vitest_1.vi.useRealTimers();
        delete process.env.VCPDECK_RELEASES_DIR;
        await (0, promises_1.rm)(dir, { recursive: true, force: true });
    });
    (0, vitest_1.describe)("upload", () => {
        const zipBytes = Buffer.from("zip-bytes");
        const fakeReq = () => node_stream_1.Readable.from([zipBytes]);
        (0, vitest_1.it)("校验通过后落盘并创建 release（无 actor 时操作者为空）", async () => {
            service.verifyZipSha256.mockResolvedValue(true);
            service.findByVersion.mockResolvedValue(null);
            service.hasAllArchives.mockReturnValue(false);
            service.create.mockResolvedValue({ version: "1.2.1" });
            const result = await controller.upload(fakeReq(), "1.2.1", "win-x64", "a".repeat(64));
            (0, vitest_1.expect)(service.verifyZipSha256).toHaveBeenCalledWith(vitest_1.expect.stringContaining("vcpdeck-release-upload"), "a".repeat(64));
            (0, vitest_1.expect)(service.create).toHaveBeenCalledWith({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        sha256: "a".repeat(64),
                        fileName: "vcpdeck-1.2.1-win-x64.zip",
                        size: zipBytes.length,
                    },
                },
                createdByName: undefined,
                createdVia: undefined,
            });
            (0, vitest_1.expect)(result.release).toEqual({ version: "1.2.1" });
            // 已移动到最终存储路径（按平台命名）
            await (0, vitest_1.expect)((0, promises_1.access)((0, release_controller_js_1.releaseZipPath)("1.2.1", "win-x64"))).resolves.toBeUndefined();
            // 单平台构件未齐，不触发编排
            (0, vitest_1.expect)(orchestrator.startRelease).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("第二个平台上传后补充构件并触发编排", async () => {
            service.verifyZipSha256.mockResolvedValue(true);
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        sha256: "a".repeat(64),
                        size: 1,
                        fileName: "vcpdeck-1.2.1-win-x64.zip",
                    },
                },
            });
            service.addArchive.mockResolvedValue({ version: "1.2.1" });
            service.hasAllArchives.mockReturnValue(true);
            const result = await controller.upload(fakeReq(), "1.2.1", "linux-x64", "b".repeat(64));
            (0, vitest_1.expect)(service.addArchive).toHaveBeenCalledWith("1.2.1", "linux-x64", {
                sha256: "b".repeat(64),
                fileName: "vcpdeck-1.2.1-linux-x64.zip",
                size: zipBytes.length,
            });
            (0, vitest_1.expect)(result.release).toEqual({ version: "1.2.1" });
            (0, vitest_1.expect)(orchestrator.startRelease).toHaveBeenCalledWith("1.2.1");
        });
        (0, vitest_1.it)("sha256 不匹配返回 400 RELEASE_SHA256_MISMATCH", async () => {
            service.verifyZipSha256.mockResolvedValue(false);
            const err = await catchHttpError(controller.upload(fakeReq(), "1.2.1", "win-x64", "a".repeat(64)));
            (0, vitest_1.expect)(err.getStatus()).toBe(400);
            (0, vitest_1.expect)(err.getResponse()).toMatchObject({
                code: "RELEASE_SHA256_MISMATCH",
            });
            (0, vitest_1.expect)(service.create).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("版本号格式非法返回 400", async () => {
            const err = await catchHttpError(controller.upload(fakeReq(), "not-a-version", "win-x64", "a".repeat(64)));
            (0, vitest_1.expect)(err.getStatus()).toBe(400);
            (0, vitest_1.expect)(service.create).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("平台参数非法返回 400", async () => {
            const err = await catchHttpError(controller.upload(fakeReq(), "1.2.1", "darwin-x64", "a".repeat(64)));
            (0, vitest_1.expect)(err.getStatus()).toBe(400);
            (0, vitest_1.expect)(service.create).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("版本重复返回 409 RELEASE_DUPLICATE_VERSION", async () => {
            service.verifyZipSha256.mockResolvedValue(true);
            service.findByVersion.mockResolvedValue(null);
            service.create.mockRejectedValue(new release_service_js_1.ReleaseError("RELEASE_DUPLICATE_VERSION", "版本已存在"));
            const err = await catchHttpError(controller.upload(fakeReq(), "1.2.1", "win-x64", "a".repeat(64)));
            (0, vitest_1.expect)(err.getStatus()).toBe(409);
            (0, vitest_1.expect)(err.getResponse()).toMatchObject({
                code: "RELEASE_DUPLICATE_VERSION",
            });
        });
        (0, vitest_1.it)("actor 注入时记录操作者", async () => {
            service.verifyZipSha256.mockResolvedValue(true);
            service.findByVersion.mockResolvedValue(null);
            service.hasAllArchives.mockReturnValue(false);
            service.create.mockResolvedValue({ version: "1.2.1" });
            const actor = {
                identityId: "i1",
                displayName: "Admin",
                isAdmin: true,
                credentialId: null,
                sessionId: "s1",
                source: "web",
                requestId: "r1",
            };
            await controller.upload(fakeReq(), "1.2.1", "win-x64", "a".repeat(64), actor);
            (0, vitest_1.expect)(service.create).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                createdByName: "Admin",
                createdVia: "web",
            }));
        });
        (0, vitest_1.it)("Alibaba 后端在读取 raw body 前拒绝旧上传入口（ADR-0019）", async () => {
            storage.getBackendConfig.mockResolvedValue({
                kind: "alibaba",
                updatedAt: null,
            });
            const req = fakeReq();
            const iterator = vitest_1.vi.spyOn(req, Symbol.asyncIterator);
            const err = await catchHttpError(controller.upload(req, "1.2.1", "win-x64", "a".repeat(64)));
            (0, vitest_1.expect)(err.getStatus()).toBe(409);
            (0, vitest_1.expect)(err.getResponse()).toMatchObject({
                code: "RELEASE_DIRECT_UPLOAD_REQUIRED",
            });
            (0, vitest_1.expect)(iterator).not.toHaveBeenCalled();
            (0, vitest_1.expect)(service.verifyZipSha256).not.toHaveBeenCalled();
            (0, vitest_1.expect)(storage.uploadStream).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("list", () => {
        (0, vitest_1.it)("page/pageSize 解析并做边界收敛", async () => {
            service.list.mockResolvedValue({ data: [], total: 0 });
            await controller.list("0", "999");
            (0, vitest_1.expect)(service.list).toHaveBeenCalledWith(1, 100);
        });
        (0, vitest_1.it)("缺省参数透传 undefined", async () => {
            service.list.mockResolvedValue({ data: [], total: 0 });
            await controller.list(undefined, undefined);
            (0, vitest_1.expect)(service.list).toHaveBeenCalledWith(undefined, undefined);
        });
    });
    (0, vitest_1.describe)("download", () => {
        const winArchive = {
            sha256: "a".repeat(64),
            size: 1,
            fileName: "vcpdeck-1.2.1-win-x64.zip",
        };
        (0, vitest_1.it)("release 不存在返回 404", async () => {
            service.findByVersion.mockResolvedValue(null);
            const err = await catchHttpError(controller.download("9.9.9", mockRes(), "win-x64"));
            (0, vitest_1.expect)(err.getStatus()).toBe(404);
        });
        (0, vitest_1.it)("platform 非法返回 400", async () => {
            const err = await catchHttpError(controller.download("1.2.1", mockRes(), "darwin-x64"));
            (0, vitest_1.expect)(err.getStatus()).toBe(400);
        });
        (0, vitest_1.it)("缺少对应平台构件返回 404", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: { "win-x64": winArchive },
            });
            const err = await catchHttpError(controller.download("1.2.1", mockRes(), "linux-x64"));
            (0, vitest_1.expect)(err.getStatus()).toBe(404);
        });
        (0, vitest_1.it)("deleting archive 返回清理中的稳定冲突错误", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": { ...winArchive, availability: "deleting" },
                },
            });
            const res = mockRes();
            const err = await catchHttpError(controller.download("1.2.1", res, "win-x64"));
            (0, vitest_1.expect)(err.getStatus()).toBe(409);
            (0, vitest_1.expect)(err.getResponse()).toMatchObject({
                code: "RELEASE_ARCHIVE_CLEANING",
            });
            (0, vitest_1.expect)(res.sendFile).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("cleaned archive 返回不可恢复的稳定错误", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        availability: "cleaned",
                        cleanedAt: "2026-08-29T00:00:00.000Z",
                        cleanupReason: "retention_policy",
                    },
                },
            });
            const res = mockRes();
            const err = await catchHttpError(controller.download("1.2.1", res, "win-x64"));
            (0, vitest_1.expect)(err.getStatus()).toBe(410);
            (0, vitest_1.expect)(err.getResponse()).toMatchObject({
                code: "RELEASE_ARCHIVE_CLEANED",
            });
            (0, vitest_1.expect)(res.sendFile).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("存在时 sendFile 到对应平台存储路径", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: { "win-x64": winArchive },
            });
            const res = mockRes();
            await controller.download("1.2.1", res, "win-x64");
            (0, vitest_1.expect)(res.sendFile).toHaveBeenCalledWith((0, release_controller_js_1.releaseZipPath)("1.2.1", "win-x64"), vitest_1.expect.objectContaining({
                headers: vitest_1.expect.objectContaining({
                    "content-type": "application/zip",
                }),
            }), vitest_1.expect.any(Function));
        });
        (0, vitest_1.it)("外部存储构件（mode=direct）302 到临时直链（ADR-0016）", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                },
            });
            storage.getDirectDownloadUrl.mockResolvedValue({
                url: "https://storage.example/x",
                expiresAt: Date.now() + 900_000,
            });
            const res = mockRes();
            await controller.download("1.2.1", res, "win-x64");
            await controller.download("1.2.1", res, "win-x64");
            (0, vitest_1.expect)(res.redirect).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(res.redirect).toHaveBeenCalledWith(302, "https://storage.example/x");
            // 短时缓存命中：只换取一次
            (0, vitest_1.expect)(storage.getDirectDownloadUrl).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(res.sendFile).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("直链换取失败且无本地构件时返回 502", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                },
            });
            storage.getDirectDownloadUrl.mockResolvedValue(null);
            const res = mockRes();
            await controller.download("1.2.1", res, "win-x64");
            (0, vitest_1.expect)(res.status).toHaveBeenCalledWith(502);
            (0, vitest_1.expect)(res.redirect).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("直链换取瞬时失败后重试并成功返回 302", async () => {
            vitest_1.vi.useFakeTimers();
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                },
            });
            storage.getDirectDownloadUrl
                .mockRejectedValueOnce(new TypeError("fetch failed"))
                .mockResolvedValueOnce({
                url: "https://storage.example/recovered",
                expiresAt: Date.now() + 900_000,
            });
            const res = mockRes();
            const request = controller.download("1.2.1", res, "win-x64");
            await vitest_1.vi.runAllTimersAsync();
            await request;
            (0, vitest_1.expect)(storage.getDirectDownloadUrl).toHaveBeenCalledTimes(2);
            (0, vitest_1.expect)(res.redirect).toHaveBeenCalledWith(302, "https://storage.example/recovered");
        });
        (0, vitest_1.it)("直链换取连续瞬时失败达到上限后返回安全 502", async () => {
            vitest_1.vi.useFakeTimers();
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                },
            });
            storage.getDirectDownloadUrl.mockRejectedValue(new Error("HTTP 502"));
            const res = mockRes();
            const request = controller.download("1.2.1", res, "win-x64");
            await vitest_1.vi.runAllTimersAsync();
            await request;
            (0, vitest_1.expect)(storage.getDirectDownloadUrl).toHaveBeenCalledTimes(3);
            (0, vitest_1.expect)(res.status).toHaveBeenCalledWith(502);
            (0, vitest_1.expect)(res.redirect).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("直链换取确定性失败不重试", async () => {
            service.findByVersion.mockResolvedValue({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        ...winArchive,
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                },
            });
            storage.getDirectDownloadUrl.mockRejectedValue(new Error("HTTP 404"));
            const res = mockRes();
            await controller.download("1.2.1", res, "win-x64");
            (0, vitest_1.expect)(storage.getDirectDownloadUrl).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(res.status).toHaveBeenCalledWith(502);
        });
    });
});
