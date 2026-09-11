"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const pi_attachment_service_js_1 = require("./pi-attachment.service.js");
function makeService() {
    const files = {
        createPending: vitest_1.vi.fn(async (_jobId, _clientId, meta, _options) => ({
            fileId: `f-${meta.filename}`,
            key: `k-${meta.filename}`,
            uploadUrl: `/api/storage/upload/k-${meta.filename}?sig=x`,
            expiresAt: Date.now() + 900_000,
        })),
        delete: vitest_1.vi.fn(async () => { }),
    };
    const storage = {
        createDownloadToken: vitest_1.vi.fn(async (key) => ({
            url: `/api/storage/download/${key}?sig=x`,
            expiresAt: Date.now() + 600_000,
        })),
    };
    const filesDb = [];
    const prisma = {
        file: {
            findUnique: vitest_1.vi.fn(async (args) => filesDb.find((f) => f.id === args.where.id) ?? null),
        },
    };
    const service = new pi_attachment_service_js_1.PiAttachmentService(files, storage, prisma);
    const addFile = (f) => filesDb.push(f);
    return { service, files, storage, prisma, addFile };
}
const img = (name, size = 1024) => ({
    filename: name,
    size,
    mimeType: "image/png",
});
(0, vitest_1.describe)("PiAttachmentService", () => {
    (0, vitest_1.it)("创建 pi_prompt 附件（purpose + 15 分钟 TTL + 无 jobId）", async () => {
        const { service, files } = makeService();
        const result = await service.createPromptUploads("c1", [img("a.png"), img("b.png")]);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(files.createPending).toHaveBeenNthCalledWith(1, undefined, "c1", vitest_1.expect.objectContaining({ filename: "a.png", mimeType: "image/png" }), vitest_1.expect.objectContaining({ purpose: "pi_prompt" }));
    });
    (0, vitest_1.it)("超过 10 张拒绝", async () => {
        const { service } = makeService();
        const many = Array.from({ length: 11 }, (_, i) => img(`m${i}.png`));
        await (0, vitest_1.expect)(service.createPromptUploads("c1", many)).rejects.toMatchObject({
            code: "PI_IMAGE_INVALID",
        });
    });
    (0, vitest_1.it)("单图超过 10 MiB 拒绝", async () => {
        const { service } = makeService();
        await (0, vitest_1.expect)(service.createPromptUploads("c1", [img("big.png", 11 * 1024 * 1024)])).rejects.toMatchObject({ code: "PI_IMAGE_TOO_LARGE" });
    });
    (0, vitest_1.it)("总量超过 100 MiB 拒绝", async () => {
        const { service } = makeService();
        const many = Array.from({ length: 10 }, () => img("m.png", 11 * 1024 * 1024));
        await (0, vitest_1.expect)(service.createPromptUploads("c1", many)).rejects.toMatchObject({
            code: "PI_IMAGE_TOO_LARGE",
        });
    });
    (0, vitest_1.it)("非白名单 MIME 拒绝", async () => {
        const { service } = makeService();
        await (0, vitest_1.expect)(service.createPromptUploads("c1", [{ filename: "x.exe", size: 10, mimeType: "application/x-msdownload" }])).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
    });
    (0, vitest_1.it)("complete 校验 purpose/client/status 并返回下载 ref", async () => {
        const { service, storage, addFile } = makeService();
        addFile({
            id: "f1",
            key: "k1",
            jobId: null,
            clientId: "c1",
            filename: "a.png",
            mimeType: "image/png",
            size: 1024,
            sha256: "abc",
            status: "completed",
            storageKind: "local",
            purpose: "pi_prompt",
            expiresAt: null,
            createdAt: new Date(),
        });
        const ref = await service.completePromptUpload("f1", "c1");
        (0, vitest_1.expect)(ref).toMatchObject({
            fileId: "f1",
            sha256: "abc",
            mimeType: "image/png",
        });
        (0, vitest_1.expect)(storage.createDownloadToken).toHaveBeenCalledWith("k1");
    });
    (0, vitest_1.it)("complete 拒绝未完成上传", async () => {
        const { service, addFile } = makeService();
        addFile({
            id: "f1",
            key: "k1",
            clientId: "c1",
            filename: "a.png",
            mimeType: "image/png",
            size: 1024,
            sha256: "",
            status: "pending",
            storageKind: "local",
            purpose: "pi_prompt",
        });
        await (0, vitest_1.expect)(service.completePromptUpload("f1", "c1")).rejects.toMatchObject({
            code: "PI_IMAGE_INVALID",
        });
    });
    (0, vitest_1.it)("deleteAttachment 只清理目标 client 的文件", async () => {
        const { service, files, addFile } = makeService();
        addFile({ id: "f1", clientId: "c1", purpose: "pi_prompt" });
        await service.deleteAttachment("f1", "c2");
        (0, vitest_1.expect)(files.delete).not.toHaveBeenCalled();
        await service.deleteAttachment("f1", "c1");
        (0, vitest_1.expect)(files.delete).toHaveBeenCalledWith("f1");
    });
    (0, vitest_1.it)("历史媒体 prepare/complete 用 pi_history purpose", async () => {
        const { service, files, addFile, storage } = makeService();
        const session = await service.prepareHistoryUpload("c1", img("hist.png", 2048));
        (0, vitest_1.expect)(session.fileId).toBe("f-hist.png");
        (0, vitest_1.expect)(files.createPending).toHaveBeenCalledWith(undefined, "c1", vitest_1.expect.objectContaining({ size: 2048 }), vitest_1.expect.objectContaining({ purpose: "pi_history" }));
        addFile({
            id: "f-hist.png",
            key: "k-hist.png",
            clientId: "c1",
            filename: "hist.png",
            mimeType: "image/png",
            size: 2048,
            sha256: "h",
            status: "completed",
            storageKind: "local",
            purpose: "pi_history",
        });
        const ref = await service.completeHistoryUpload("f-hist.png", "c1");
        (0, vitest_1.expect)(ref.url).toContain("/api/storage/download/");
        (0, vitest_1.expect)(storage.createDownloadToken).toHaveBeenCalledWith("k-hist.png");
    });
});
