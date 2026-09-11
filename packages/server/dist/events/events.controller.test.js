"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const events_controller_js_1 = require("./events.controller.js");
const public_decorator_js_1 = require("../auth/public.decorator.js");
const TEST_PSK = "test-client-psk";
function makeController() {
    const jobService = {
        createUploadSession: vitest_1.vi.fn(),
        completeUploadSession: vitest_1.vi.fn(),
    };
    const clientService = {
        rename: vitest_1.vi.fn(),
    };
    const gateway = {
        sendDispatch: vitest_1.vi.fn(),
    };
    const storageService = {
        createExportSession: vitest_1.vi.fn(),
        completeExportUpload: vitest_1.vi.fn(),
        refreshDirectPartUrls: vitest_1.vi.fn(),
        updateUploadProgress: vitest_1.vi.fn(),
    };
    return {
        controller: new events_controller_js_1.EventsController(jobService, clientService, gateway, storageService),
        jobService: jobService,
        gateway: gateway,
        storageService: storageService,
        clientService: clientService,
    };
}
(0, vitest_1.describe)("EventsController upload sessions", () => {
    (0, vitest_1.it)("把创建会话请求交给 JobService", async () => {
        const { controller, jobService } = makeController();
        const body = {
            clientId: "client-1",
            rootDir: "D:\\",
            targetPath: "report.txt",
            filename: "report.txt",
            size: 5,
        };
        const actor = { identityId: "identity-1", source: "web" };
        const expected = {
            jobId: "job-1",
            fileId: "file-1",
            status: "waiting_input",
        };
        jobService.createUploadSession.mockResolvedValue(expected);
        await (0, vitest_1.expect)(controller.createUploadSession(body, actor)).resolves.toBe(expected);
        (0, vitest_1.expect)(jobService.createUploadSession).toHaveBeenCalledWith(body, actor);
    });
    (0, vitest_1.it)("完成会话时转发 dispatch 但只返回结果", async () => {
        const { controller, jobService, gateway } = makeController();
        const result = { jobId: "job-1", status: "running", type: "file.import" };
        const dispatch = {
            jobId: "job-1",
            clientId: "client-1",
            type: "file.import",
            payload: {},
        };
        jobService.completeUploadSession.mockResolvedValue({ result, dispatch });
        await (0, vitest_1.expect)(controller.completeUploadSession("job-1", {})).resolves.toBe(result);
        (0, vitest_1.expect)(gateway.sendDispatch).toHaveBeenCalledWith(dispatch);
    });
    (0, vitest_1.it)("没有 dispatch 时不发送 Client 消息", async () => {
        const { controller, jobService, gateway } = makeController();
        const result = { jobId: "job-1", status: "pending", type: "file.import" };
        jobService.completeUploadSession.mockResolvedValue({
            result,
            dispatch: null,
        });
        await controller.completeUploadSession("job-1", {});
        (0, vitest_1.expect)(gateway.sendDispatch).not.toHaveBeenCalled();
    });
    (0, vitest_1.describe)("导出直传会话端点", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.stubEnv("VCPDECK_PSK", TEST_PSK);
        });
        (0, vitest_1.afterEach)(() => {
            vitest_1.vi.unstubAllEnvs();
        });
        (0, vitest_1.it)("创建导出直传会话", async () => {
            const { controller, storageService } = makeController();
            const session = {
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 64,
                parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
            };
            storageService.createExportSession.mockResolvedValue(session);
            await (0, vitest_1.expect)(controller.createExportSession({ jobId: "j1", size: 100 })).resolves.toBe(session);
            (0, vitest_1.expect)(storageService.createExportSession).toHaveBeenCalledWith("j1", 100);
        });
        (0, vitest_1.it)("完成导出直传并返回 key", async () => {
            const { controller, storageService } = makeController();
            storageService.completeExportUpload.mockResolvedValue({
                key: "aliyun-file",
            });
            await (0, vitest_1.expect)(controller.completeExportSession("j1", { uploadedBytes: 100 })).resolves.toEqual({ key: "aliyun-file" });
            (0, vitest_1.expect)(storageService.completeExportUpload).toHaveBeenCalledWith("j1", 100);
        });
        (0, vitest_1.it)("续期分片 URL", async () => {
            const { controller, storageService } = makeController();
            storageService.refreshDirectPartUrls.mockResolvedValue([
                { partNumber: 2, url: "https://oss.example/p2-new" },
            ]);
            await (0, vitest_1.expect)(controller.refreshPartUrls("j1", { partNumbers: [2] })).resolves.toEqual([
                { partNumber: 2, url: "https://oss.example/p2-new" },
            ]);
            (0, vitest_1.expect)(storageService.refreshDirectPartUrls).toHaveBeenCalledWith("j1", [2]);
        });
        (0, vitest_1.it)("上报直传进度", async () => {
            const { controller, storageService } = makeController();
            storageService.updateUploadProgress.mockResolvedValue(undefined);
            await (0, vitest_1.expect)(controller.updateProgress("j1", { loaded: 64 })).resolves.toBeUndefined();
            (0, vitest_1.expect)(storageService.updateUploadProgress).toHaveBeenCalledWith("j1", 64);
        });
        vitest_1.it.each([
            [
                "createClientExportSession",
                (controller, psk) => controller.createClientExportSession(psk, {
                    jobId: "j1",
                    size: 100,
                }),
            ],
            [
                "completeClientExportSession",
                (controller, psk) => controller.completeClientExportSession("j1", psk, {
                    uploadedBytes: 100,
                }),
            ],
            [
                "refreshClientExportPartUrls",
                (controller, psk) => controller.refreshClientExportPartUrls("j1", psk, {
                    partNumbers: [1],
                }),
            ],
        ])("%s 缺失 PSK时返回稳定 401", async (_name, call) => {
            const { controller, storageService } = makeController();
            await (0, vitest_1.expect)(call(controller)).rejects.toMatchObject({
                status: 401,
                response: {
                    code: "CLIENT_AUTH_REQUIRED",
                    message: "Client authentication required",
                },
            });
            (0, vitest_1.expect)(storageService.createExportSession).not.toHaveBeenCalled();
            (0, vitest_1.expect)(storageService.completeExportUpload).not.toHaveBeenCalled();
            (0, vitest_1.expect)(storageService.refreshDirectPartUrls).not.toHaveBeenCalled();
        });
        vitest_1.it.each([
            [
                "createClientExportSession",
                (controller) => controller.createClientExportSession("wrong-client-psk", {
                    jobId: "j1",
                    size: 100,
                }),
            ],
            [
                "completeClientExportSession",
                (controller) => controller.completeClientExportSession("j1", "wrong-client-psk", {
                    uploadedBytes: 100,
                }),
            ],
            [
                "refreshClientExportPartUrls",
                (controller) => controller.refreshClientExportPartUrls("j1", "wrong-client-psk", {
                    partNumbers: [1],
                }),
            ],
        ])("%s 错误 PSK时返回稳定 401", async (_name, call) => {
            const { controller, storageService } = makeController();
            await (0, vitest_1.expect)(call(controller)).rejects.toMatchObject({
                status: 401,
                response: {
                    code: "CLIENT_AUTH_REQUIRED",
                    message: "Client authentication required",
                },
            });
            (0, vitest_1.expect)(storageService.createExportSession).not.toHaveBeenCalled();
            (0, vitest_1.expect)(storageService.completeExportUpload).not.toHaveBeenCalled();
            (0, vitest_1.expect)(storageService.refreshDirectPartUrls).not.toHaveBeenCalled();
        });
        vitest_1.it.each([
            "createClientExportSession",
            "completeClientExportSession",
            "refreshClientExportPartUrls",
        ])("%s 标记为 Public", (name) => {
            const method = events_controller_js_1.EventsController.prototype[name];
            (0, vitest_1.expect)(Reflect.getMetadata(public_decorator_js_1.IS_PUBLIC_KEY, method)).toBe(true);
        });
        (0, vitest_1.it)("旧 SDK export-session 方法保持非 Public", () => {
            (0, vitest_1.expect)(Reflect.getMetadata(public_decorator_js_1.IS_PUBLIC_KEY, events_controller_js_1.EventsController.prototype.createExportSession)).not.toBe(true);
            (0, vitest_1.expect)(Reflect.getMetadata(public_decorator_js_1.IS_PUBLIC_KEY, events_controller_js_1.EventsController.prototype.completeExportSession)).not.toBe(true);
        });
        (0, vitest_1.it)("正确 PSK创建 Client export session并复用 StorageService", async () => {
            const { controller, storageService } = makeController();
            const session = {
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 64,
                parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
            };
            storageService.createExportSession.mockResolvedValue(session);
            await (0, vitest_1.expect)(controller.createClientExportSession(TEST_PSK, {
                jobId: "j1",
                size: 100,
            })).resolves.toBe(session);
            (0, vitest_1.expect)(storageService.createExportSession).toHaveBeenCalledWith("j1", 100);
        });
        (0, vitest_1.it)("正确 PSK完成 Client export upload并复用 StorageService", async () => {
            const { controller, storageService } = makeController();
            storageService.completeExportUpload.mockResolvedValue({
                key: "aliyun-file",
            });
            await (0, vitest_1.expect)(controller.completeClientExportSession("j1", TEST_PSK, {
                uploadedBytes: 100,
            })).resolves.toEqual({ key: "aliyun-file" });
            (0, vitest_1.expect)(storageService.completeExportUpload).toHaveBeenCalledWith("j1", 100);
        });
        (0, vitest_1.it)("正确 PSK续期 Client export 分片 URL", async () => {
            const { controller, storageService } = makeController();
            storageService.refreshDirectPartUrls.mockResolvedValue([
                { partNumber: 2, url: "https://oss.example/p2-new" },
            ]);
            await (0, vitest_1.expect)(controller.refreshClientExportPartUrls("j1", TEST_PSK, {
                partNumbers: [2],
            })).resolves.toEqual([
                { partNumber: 2, url: "https://oss.example/p2-new" },
            ]);
            (0, vitest_1.expect)(storageService.refreshDirectPartUrls).toHaveBeenCalledWith("j1", [2]);
        });
        vitest_1.it.each([
            [[]],
            [[0]],
            [[-1]],
            [[1.5]],
            [[1, 1]],
        ])("Client export 续期拒绝非法分片编号 %j", async (partNumbers) => {
            const { controller, storageService } = makeController();
            await (0, vitest_1.expect)(controller.refreshClientExportPartUrls("j1", TEST_PSK, {
                partNumbers,
            })).rejects.toMatchObject({ status: 400 });
            (0, vitest_1.expect)(storageService.refreshDirectPartUrls).not.toHaveBeenCalled();
        });
    });
});
(0, vitest_1.describe)("EventsController renameClient", () => {
    (0, vitest_1.it)("把改名请求交给 ClientService", async () => {
        const { controller, clientService } = makeController();
        const expected = { clientId: "c1", name: "new-name" };
        clientService.rename.mockResolvedValue(expected);
        await (0, vitest_1.expect)(controller.renameClient("c1", "new-name")).resolves.toBe(expected);
        (0, vitest_1.expect)(clientService.rename).toHaveBeenCalledWith("c1", "new-name");
    });
    (0, vitest_1.it)("空名直接拒绝 400", async () => {
        const { controller, clientService } = makeController();
        await (0, vitest_1.expect)(controller.renameClient("c1", "  ")).rejects.toMatchObject({
            status: 400,
        });
        (0, vitest_1.expect)(clientService.rename).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("服务层冲突错误映射为 409 HttpException", async () => {
        const { controller, clientService } = makeController();
        clientService.rename.mockRejectedValue(Object.assign(new Error("already taken"), {
            code: "CLIENT_NAME_TAKEN",
            statusCode: 409,
        }));
        await (0, vitest_1.expect)(controller.renameClient("c1", "c2-name")).rejects.toMatchObject({
            status: 409,
            response: { code: "CLIENT_NAME_TAKEN" },
        });
    });
});
