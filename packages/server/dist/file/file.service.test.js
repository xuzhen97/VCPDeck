"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const file_service_js_1 = require("./file.service.js");
function mockPrisma() {
    const file = {
        update: vitest_1.vi.fn().mockResolvedValue({
            key: "aliyun-file-id",
            size: 0,
        }),
        findUnique: vitest_1.vi.fn(),
        findMany: vitest_1.vi.fn(),
        updateMany: vitest_1.vi.fn().mockResolvedValue({ count: 1 }),
        delete: vitest_1.vi.fn(),
    };
    const storageShare = { count: vitest_1.vi.fn() };
    return {
        file,
        storageShare,
        $transaction: vitest_1.vi.fn(async (callback) => callback({ file, storageShare })),
    };
}
(0, vitest_1.describe)("FileService.confirmUpload", () => {
    (0, vitest_1.it)("只确认摘要和状态，保留上传阶段持久化的真实 key", async () => {
        const prisma = mockPrisma();
        const service = new file_service_js_1.FileService(prisma, {});
        const result = await service.confirmUpload("file-1", "sha256-value");
        (0, vitest_1.expect)(result).toEqual({ key: "aliyun-file-id", size: 0 });
        (0, vitest_1.expect)(prisma.file.update).toHaveBeenCalledWith({
            where: { id: "file-1" },
            data: { sha256: "sha256-value", status: "completed" },
        });
    });
});
(0, vitest_1.describe)("FileService share retention", () => {
    (0, vitest_1.it)("active share prevents provider deletion", async () => {
        const prisma = mockPrisma();
        prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
        prisma.storageShare.count.mockResolvedValue(1);
        const storage = { delete: vitest_1.vi.fn() };
        const service = new file_service_js_1.FileService(prisma, storage);
        await (0, vitest_1.expect)(service.delete("f1")).rejects.toMatchObject({
            code: "FILE_HAS_ACTIVE_SHARES",
            statusCode: 409,
        });
        (0, vitest_1.expect)(storage.delete).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("无有效分享时先认领 deleting，Provider 成功后删除 File", async () => {
        const prisma = mockPrisma();
        prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
        prisma.storageShare.count.mockResolvedValue(0);
        const storage = { delete: vitest_1.vi.fn().mockResolvedValue(undefined) };
        const service = new file_service_js_1.FileService(prisma, storage);
        await service.delete("f1");
        (0, vitest_1.expect)(prisma.file.updateMany).toHaveBeenCalledWith({
            where: { id: "f1", status: "completed" },
            data: { status: "deleting" },
        });
        (0, vitest_1.expect)(storage.delete).toHaveBeenCalledWith("k1");
        (0, vitest_1.expect)(prisma.file.delete).toHaveBeenCalledWith({ where: { id: "f1" } });
    });
    (0, vitest_1.it)("Provider 删除失败时恢复原 File 状态", async () => {
        const prisma = mockPrisma();
        prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
        prisma.storageShare.count.mockResolvedValue(0);
        const storage = { delete: vitest_1.vi.fn().mockRejectedValue(new Error("provider down")) };
        const service = new file_service_js_1.FileService(prisma, storage);
        await (0, vitest_1.expect)(service.delete("f1")).rejects.toThrow("provider down");
        (0, vitest_1.expect)(prisma.file.updateMany).toHaveBeenCalledWith({
            where: { id: "f1", status: "deleting" },
            data: { status: "completed" },
        });
        (0, vitest_1.expect)(prisma.file.delete).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("过期 File 查询排除 active share", async () => {
        const prisma = mockPrisma();
        prisma.file.findMany.mockResolvedValue([]);
        const service = new file_service_js_1.FileService(prisma, {});
        await service.getExpiredFiles();
        (0, vitest_1.expect)(prisma.file.findMany).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            where: {
                expiresAt: { lte: vitest_1.expect.any(Date) },
                shares: { none: { revokedAt: null, invalidatedAt: null } },
            },
        }));
    });
});
