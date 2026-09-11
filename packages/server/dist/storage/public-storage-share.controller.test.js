"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const storage_provider_interface_js_1 = require("./providers/storage-provider.interface.js");
const public_storage_share_controller_js_1 = require("./public-storage-share.controller.js");
function makeResponse() {
    return {
        status: vitest_1.vi.fn().mockReturnThis(),
        setHeader: vitest_1.vi.fn(),
        end: vitest_1.vi.fn(),
        destroy: vitest_1.vi.fn(),
    };
}
const file = {
    id: "file-1",
    key: "secret/storage-key",
    filename: "photo.SVG",
    mimeType: "text/plain",
    size: 12,
    status: "completed",
    storageKind: "local",
};
function makeService(overrides = {}) {
    return {
        resolvePublic: vitest_1.vi.fn().mockResolvedValue({ id: "share-1", file }),
        markInvalid: vitest_1.vi.fn(),
        ...overrides,
    };
}
(0, vitest_1.describe)("PublicStorageShareController", () => {
    (0, vitest_1.it)("普通文件返回不可缓存 302，不需要 VCPDeck 认证", async () => {
        const service = makeService({ resolvePublic: vitest_1.vi.fn().mockResolvedValue({ id: "share-1", file: { ...file, filename: "report.pdf" } }) });
        const storage = {
            currentKind: vitest_1.vi.fn().mockReturnValue("local"),
            createDownloadToken: vitest_1.vi.fn().mockResolvedValue({ url: "https://provider.example/temporary", expiresAt: 1 }),
        };
        const controller = new public_storage_share_controller_js_1.PublicStorageShareController(service, storage);
        const response = makeResponse();
        await controller.download("A".repeat(43), response);
        (0, vitest_1.expect)(storage.createDownloadToken).toHaveBeenCalledWith("secret/storage-key");
        (0, vitest_1.expect)(response.status).toHaveBeenCalledWith(302);
        (0, vitest_1.expect)(response.setHeader).toHaveBeenCalledWith("Location", "https://provider.example/temporary");
        (0, vitest_1.expect)(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
        (0, vitest_1.expect)(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
        (0, vitest_1.expect)(response.end).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("图片同样 302 到当前 Provider，不由公开入口代理", async () => {
        const service = makeService();
        const storage = {
            currentKind: vitest_1.vi.fn().mockReturnValue("local"),
            createDownloadToken: vitest_1.vi.fn().mockResolvedValue({ url: "https://provider.example/image", expiresAt: 1 }),
            openDownload: vitest_1.vi.fn(),
        };
        const controller = new public_storage_share_controller_js_1.PublicStorageShareController(service, storage);
        const response = makeResponse();
        await controller.download("B".repeat(43), response);
        (0, vitest_1.expect)(storage.createDownloadToken).toHaveBeenCalledWith("secret/storage-key");
        (0, vitest_1.expect)(storage.openDownload).not.toHaveBeenCalled();
        (0, vitest_1.expect)(response.status).toHaveBeenCalledWith(302);
        (0, vitest_1.expect)(response.setHeader).toHaveBeenCalledWith("Location", "https://provider.example/image");
        (0, vitest_1.expect)(response.end).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("Token 无效返回安全 404，Provider 明确缺失时标记分享并返回 410", async () => {
        const notFound = makeService({ resolvePublic: vitest_1.vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { statusCode: 404 })) });
        const controller = new public_storage_share_controller_js_1.PublicStorageShareController(notFound, {});
        await (0, vitest_1.expect)(controller.download("bad", makeResponse())).rejects.toMatchObject({ status: 404 });
        const missing = makeService({
            resolvePublic: vitest_1.vi.fn().mockResolvedValue({ id: "share-1", file }),
            markInvalid: vitest_1.vi.fn().mockResolvedValue(undefined),
        });
        const storage = {
            currentKind: vitest_1.vi.fn().mockReturnValue("local"),
            createDownloadToken: vitest_1.vi.fn().mockRejectedValue(new storage_provider_interface_js_1.StorageObjectNotFoundError()),
        };
        const missingController = new public_storage_share_controller_js_1.PublicStorageShareController(missing, storage);
        await (0, vitest_1.expect)(missingController.download("C".repeat(43), makeResponse())).rejects.toMatchObject({ status: 410 });
        (0, vitest_1.expect)(missing.markInvalid).toHaveBeenCalledWith("share-1", "OBJECT_NOT_FOUND");
    });
});
