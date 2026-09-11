"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const storage_share_service_js_1 = require("./storage-share.service.js");
const actor = {
    identityId: "identity-1",
    displayName: "Operator",
    isAdmin: false,
    credentialId: "credential-1",
    sessionId: null,
    source: "cli",
    requestId: "request-1",
};
function row(overrides = {}) {
    return {
        id: "share-1",
        tokenHash: "a".repeat(64),
        fileId: "file-1",
        filename: "photo.PNG",
        mimeType: "image/png",
        storageKind: "local",
        createdByIdentityId: "identity-1",
        createdByName: "Operator",
        createdVia: "cli",
        createdAt: new Date("2026-09-04T00:00:00.000Z"),
        revokedAt: null,
        revokedByIdentityId: null,
        invalidatedAt: null,
        invalidReason: null,
        ...overrides,
    };
}
function mockPrisma() {
    const file = {
        findUnique: vitest_1.vi.fn(),
    };
    const storageShare = {
        create: vitest_1.vi.fn(),
        findMany: vitest_1.vi.fn(),
        findUnique: vitest_1.vi.fn(),
        count: vitest_1.vi.fn(),
        update: vitest_1.vi.fn(),
    };
    return {
        file,
        storageShare,
        $transaction: vitest_1.vi.fn(async (callback) => callback({ file, storageShare })),
    };
}
(0, vitest_1.describe)("StorageShareService", () => {
    (0, vitest_1.it)("只持久化 32 字节 Token 的 SHA-256 哈希，并只在创建结果返回 sharePath", async () => {
        const prisma = mockPrisma();
        prisma.file.findUnique.mockResolvedValue({
            id: "file-1",
            status: "completed",
            filename: "photo.PNG",
            mimeType: "image/png",
            storageKind: "local",
        });
        prisma.storageShare.create.mockImplementation(async ({ data }) => row({ id: "created", tokenHash: data.tokenHash }));
        const service = new storage_share_service_js_1.StorageShareService(prisma, {
            currentKind: vitest_1.vi.fn().mockReturnValue("local"),
        });
        const result = await service.create({ fileId: "file-1" }, actor);
        (0, vitest_1.expect)(result.sharePath).toMatch(/^\/api\/public\/storage-shares\/[A-Za-z0-9_-]{43}$/);
        (0, vitest_1.expect)(prisma.storageShare.create).toHaveBeenCalledWith({
            data: vitest_1.expect.objectContaining({
                fileId: "file-1",
                tokenHash: vitest_1.expect.stringMatching(/^[a-f0-9]{64}$/),
                createdByIdentityId: "identity-1",
                createdByName: "Operator",
                createdVia: "cli",
            }),
        });
        (0, vitest_1.expect)(result).toMatchObject({ id: "created", fileId: "file-1", previewable: true });
        const listed = service.toInfo(row());
        (0, vitest_1.expect)(listed).not.toHaveProperty("sharePath");
        (0, vitest_1.expect)(listed).not.toHaveProperty("tokenHash");
    });
    (0, vitest_1.it)("同一 File 每次创建独立分享，并拒绝未完成或 Provider 不匹配的 File", async () => {
        const prisma = mockPrisma();
        const create = prisma.storageShare.create;
        create.mockImplementation(async ({ data }) => row({ id: crypto.randomUUID(), tokenHash: data.tokenHash }));
        const currentKind = vitest_1.vi.fn().mockReturnValue("local");
        const service = new storage_share_service_js_1.StorageShareService(prisma, { currentKind });
        prisma.file.findUnique.mockResolvedValue({
            id: "file-1",
            status: "completed",
            filename: "a.txt",
            mimeType: "text/plain",
            storageKind: "local",
        });
        const first = await service.create({ fileId: "file-1" }, actor);
        const second = await service.create({ fileId: "file-1" }, actor);
        (0, vitest_1.expect)(first.sharePath).not.toBe(second.sharePath);
        (0, vitest_1.expect)(create.mock.calls[0]?.[0].data.tokenHash).not.toBe(create.mock.calls[1]?.[0].data.tokenHash);
        prisma.file.findUnique.mockResolvedValue({ ...row(), status: "pending" });
        await (0, vitest_1.expect)(service.create({ fileId: "file-1" }, actor)).rejects.toMatchObject({
            code: "FILE_NOT_SHAREABLE",
            statusCode: 409,
        });
        prisma.file.findUnique.mockResolvedValue({ ...row(), status: "completed", storageKind: "alibaba" });
        await (0, vitest_1.expect)(service.create({ fileId: "file-1" }, actor)).rejects.toMatchObject({
            code: "STORAGE_PROVIDER_MISMATCH",
            statusCode: 503,
        });
    });
    (0, vitest_1.it)("按推导状态分页列出、幂等撤销并统计有效分享", async () => {
        const prisma = mockPrisma();
        prisma.storageShare.findMany.mockResolvedValue([
            row(),
            row({ id: "share-2", revokedAt: new Date("2026-09-04T01:00:00.000Z") }),
        ]);
        prisma.storageShare.count.mockResolvedValue(2);
        prisma.storageShare.update.mockResolvedValue(row({ revokedAt: new Date(), revokedByIdentityId: actor.identityId }));
        prisma.storageShare.findUnique.mockResolvedValue(row());
        const service = new storage_share_service_js_1.StorageShareService(prisma, {
            currentKind: vitest_1.vi.fn().mockReturnValue("local"),
        });
        const result = await service.list({ page: 2, pageSize: 1 });
        (0, vitest_1.expect)(result).toMatchObject({ total: 2, page: 2, pageSize: 1, totalPages: 2 });
        (0, vitest_1.expect)(result.data[0]).not.toHaveProperty("tokenHash");
        (0, vitest_1.expect)(prisma.storageShare.findMany).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ skip: 1, take: 1 }));
        (0, vitest_1.expect)(prisma.storageShare.count).toHaveBeenCalledOnce();
        await (0, vitest_1.expect)(service.revoke("share-1", actor)).resolves.toMatchObject({ status: "revoked" });
        (0, vitest_1.expect)(prisma.storageShare.update).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            where: { id: "share-1" },
            data: vitest_1.expect.objectContaining({ revokedByIdentityId: actor.identityId }),
        }));
        prisma.storageShare.count.mockResolvedValue(1);
        await (0, vitest_1.expect)(service.hasActiveShares("file-1")).resolves.toBe(true);
        (0, vitest_1.expect)(prisma.storageShare.count).toHaveBeenLastCalledWith({
            where: { fileId: "file-1", revokedAt: null, invalidatedAt: null },
        });
    });
});
