"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const constants_1 = require("@nestjs/common/constants");
const release_upload_controller_js_1 = require("./release-upload.controller.js");
const release_upload_service_js_1 = require("./release-upload.service.js");
const actor = {
    identityId: "identity-1",
    displayName: "Operator",
    isAdmin: false,
    credentialId: "credential-1",
    sessionId: null,
    source: "cli",
    requestId: "request-1",
};
function service() {
    return {
        createSession: vitest_1.vi.fn(async () => ({ mode: "server" })),
        refreshParts: vitest_1.vi.fn(async () => ({
            parts: [{ partNumber: 1, url: "https://provider.invalid/secret" }],
        })),
        completeSession: vitest_1.vi.fn(async () => ({ release: { version: "0.2.1" } })),
    };
}
async function catchHttpError(promise) {
    try {
        await promise;
        throw new Error("预期请求失败");
    }
    catch (error) {
        return error;
    }
}
(0, vitest_1.describe)("ReleaseUploadController", () => {
    (0, vitest_1.it)("严格解析创建输入并传递 actor", async () => {
        const mock = service();
        const controller = new release_upload_controller_js_1.ReleaseUploadController(mock);
        const body = {
            version: "0.2.1",
            platform: "linux-x64",
            sha256: "a".repeat(64),
            size: 123,
        };
        await controller.create(body, actor);
        (0, vitest_1.expect)(mock.createSession).toHaveBeenCalledWith(body, actor);
        const error = await catchHttpError(controller.create({ ...body, providerUrl: "secret" }, actor));
        (0, vitest_1.expect)(error.getStatus()).toBe(400);
        (0, vitest_1.expect)(mock.createSession).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("刷新分片严格拒绝重复编号", async () => {
        const mock = service();
        const controller = new release_upload_controller_js_1.ReleaseUploadController(mock);
        const error = await catchHttpError(controller.refreshParts("session-1", { partNumbers: [1, 1] }));
        (0, vitest_1.expect)(error.getStatus()).toBe(400);
        (0, vitest_1.expect)(mock.refreshParts).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("完成字节数不匹配映射稳定 400 错误", async () => {
        const mock = service();
        mock.completeSession.mockRejectedValue(new release_upload_service_js_1.ReleaseUploadError("RELEASE_UPLOAD_SIZE_MISMATCH", "上传字节数与声明值不一致"));
        const controller = new release_upload_controller_js_1.ReleaseUploadController(mock);
        const error = await catchHttpError(controller.complete("session-1", { uploadedBytes: 123 }));
        (0, vitest_1.expect)(error.getStatus()).toBe(400);
        (0, vitest_1.expect)(error.getResponse()).toEqual({
            code: "RELEASE_UPLOAD_SIZE_MISMATCH",
            message: "上传字节数与声明值不一致",
        });
    });
    (0, vitest_1.it)("Provider 失败只返回安全摘要", async () => {
        const mock = service();
        mock.refreshParts.mockRejectedValue(new release_upload_service_js_1.ReleaseUploadError("RELEASE_UPLOAD_PROVIDER_FAILED", "外部存储操作失败，请稍后重试"));
        const controller = new release_upload_controller_js_1.ReleaseUploadController(mock);
        const error = await catchHttpError(controller.refreshParts("session-1", { partNumbers: [1] }));
        (0, vitest_1.expect)(error.getStatus()).toBe(502);
        (0, vitest_1.expect)(JSON.stringify(error.getResponse())).not.toContain("provider.invalid");
    });
    (0, vitest_1.it)("创建、刷新、完成响应均声明 no-store", () => {
        for (const method of [
            release_upload_controller_js_1.ReleaseUploadController.prototype.create,
            release_upload_controller_js_1.ReleaseUploadController.prototype.refreshParts,
            release_upload_controller_js_1.ReleaseUploadController.prototype.complete,
        ]) {
            (0, vitest_1.expect)(Reflect.getMetadata(constants_1.HEADERS_METADATA, method)).toContainEqual({
                name: "Cache-Control",
                value: "no-store",
            });
        }
    });
});
