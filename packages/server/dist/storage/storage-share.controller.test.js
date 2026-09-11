"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const storage_share_controller_js_1 = require("./storage-share.controller.js");
const actor = {
    identityId: "identity-1",
    displayName: "Operator",
    isAdmin: false,
    credentialId: null,
    sessionId: "session-1",
    source: "web",
    requestId: "request-1",
};
(0, vitest_1.describe)("StorageShareController", () => {
    (0, vitest_1.it)("创建和撤销分享传递 Actor，并返回服务层结果", async () => {
        const service = {
            create: vitest_1.vi.fn().mockResolvedValue({ id: "share-1", sharePath: "/api/public/storage-shares/token" }),
            revoke: vitest_1.vi.fn().mockResolvedValue({ id: "share-1", status: "revoked" }),
        };
        const controller = new storage_share_controller_js_1.StorageShareController(service);
        await (0, vitest_1.expect)(controller.create({ fileId: "file-1" }, actor)).resolves.toMatchObject({ id: "share-1" });
        (0, vitest_1.expect)(service.create).toHaveBeenCalledWith({ fileId: "file-1" }, actor);
        await controller.revoke("share-1", actor);
        (0, vitest_1.expect)(service.revoke).toHaveBeenCalledWith("share-1", actor);
    });
    (0, vitest_1.it)("列表限制 page/pageSize，并保留 fileId/status 筛选", async () => {
        const service = { list: vitest_1.vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 }) };
        const controller = new storage_share_controller_js_1.StorageShareController(service);
        await controller.list("file-1", "active", "0", "999");
        (0, vitest_1.expect)(service.list).toHaveBeenCalledWith({ fileId: "file-1", status: "active", page: 1, pageSize: 100 });
    });
});
