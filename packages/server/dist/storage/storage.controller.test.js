"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const storage_controller_js_1 = require("./storage.controller.js");
function makeController() {
    const storageService = {
        createDownloadToken: vitest_1.vi.fn(),
    };
    return {
        controller: new storage_controller_js_1.StorageController(storageService),
        storageService,
    };
}
function makeResponse() {
    return {
        status: vitest_1.vi.fn(),
        setHeader: vitest_1.vi.fn(),
        end: vitest_1.vi.fn(),
    };
}
(0, vitest_1.describe)("StorageController", () => {
    (0, vitest_1.it)("每次请求都签发 fresh URL 并返回不可缓存的 302", async () => {
        const { controller, storageService } = makeController();
        storageService.createDownloadToken
            .mockResolvedValueOnce({
            url: "https://download.example/one",
            expiresAt: 1,
        })
            .mockResolvedValueOnce({
            url: "https://download.example/two",
            expiresAt: 2,
        });
        const first = makeResponse();
        const second = makeResponse();
        await controller.redirectDownload("aliyun-file", first);
        await controller.redirectDownload("aliyun-file", second);
        (0, vitest_1.expect)(storageService.createDownloadToken).toHaveBeenCalledTimes(2);
        (0, vitest_1.expect)(storageService.createDownloadToken).toHaveBeenNthCalledWith(1, "aliyun-file");
        (0, vitest_1.expect)(first.status).toHaveBeenCalledWith(302);
        (0, vitest_1.expect)(first.setHeader).toHaveBeenCalledWith("Location", "https://download.example/one");
        (0, vitest_1.expect)(second.setHeader).toHaveBeenCalledWith("Location", "https://download.example/two");
        (0, vitest_1.expect)(first.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        (0, vitest_1.expect)(first.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
        (0, vitest_1.expect)(first.end).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("local 签名地址同样通过稳定入口跳转", async () => {
        const { controller, storageService } = makeController();
        storageService.createDownloadToken.mockResolvedValue({
            url: "/api/storage/download/local-key?expires=123&sig=abc",
            expiresAt: 123,
        });
        const response = makeResponse();
        await controller.redirectDownload("local-key", response);
        (0, vitest_1.expect)(response.setHeader).toHaveBeenCalledWith("Location", "/api/storage/download/local-key?expires=123&sig=abc");
    });
});
