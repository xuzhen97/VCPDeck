import { describe, expect, it, vi } from "vitest";
import { StorageShareService } from "./storage-share.service.js";

const actor = {
	identityId: "identity-1",
	displayName: "Operator",
	isAdmin: false,
	credentialId: "credential-1",
	sessionId: null,
	source: "cli" as const,
	requestId: "request-1",
};

function row(overrides: Record<string, unknown> = {}) {
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
		findUnique: vi.fn(),
	};
	const storageShare = {
		create: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		count: vi.fn(),
		update: vi.fn(),
	};
	return {
		file,
		storageShare,
		$transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
			callback({ file, storageShare }),
		),
	};
}

describe("StorageShareService", () => {
	it("只持久化 32 字节 Token 的 SHA-256 哈希，并只在创建结果返回 sharePath", async () => {
		const prisma = mockPrisma();
		prisma.file.findUnique.mockResolvedValue({
			id: "file-1",
			status: "completed",
			filename: "photo.PNG",
			mimeType: "image/png",
			storageKind: "local",
		});
		prisma.storageShare.create.mockImplementation(async ({ data }) =>
			row({ id: "created", tokenHash: data.tokenHash }),
		);
		const service = new StorageShareService(prisma as never, {
			currentKind: vi.fn().mockReturnValue("local"),
		} as never);

		const result = await service.create({ fileId: "file-1" }, actor);

		expect(result.sharePath).toMatch(/^\/api\/public\/storage-shares\/[A-Za-z0-9_-]{43}$/);
		expect(prisma.storageShare.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				fileId: "file-1",
				tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
				createdByIdentityId: "identity-1",
				createdByName: "Operator",
				createdVia: "cli",
			}),
		});
		expect(result).toMatchObject({ id: "created", fileId: "file-1", previewable: true });

		const listed = service.toInfo(row());
		expect(listed).not.toHaveProperty("sharePath");
		expect(listed).not.toHaveProperty("tokenHash");
	});

	it("同一 File 每次创建独立分享，并拒绝未完成或 Provider 不匹配的 File", async () => {
		const prisma = mockPrisma();
		const create = prisma.storageShare.create;
		create.mockImplementation(async ({ data }) => row({ id: crypto.randomUUID(), tokenHash: data.tokenHash }));
		const currentKind = vi.fn().mockReturnValue("local");
		const service = new StorageShareService(prisma as never, { currentKind } as never);
		prisma.file.findUnique.mockResolvedValue({
			id: "file-1",
			status: "completed",
			filename: "a.txt",
			mimeType: "text/plain",
			storageKind: "local",
		});

		const first = await service.create({ fileId: "file-1" }, actor);
		const second = await service.create({ fileId: "file-1" }, actor);
		expect(first.sharePath).not.toBe(second.sharePath);
		expect(create.mock.calls[0]?.[0].data.tokenHash).not.toBe(create.mock.calls[1]?.[0].data.tokenHash);

		prisma.file.findUnique.mockResolvedValue({ ...row(), status: "pending" });
		await expect(service.create({ fileId: "file-1" }, actor)).rejects.toMatchObject({
			code: "FILE_NOT_SHAREABLE",
			statusCode: 409,
		});

		prisma.file.findUnique.mockResolvedValue({ ...row(), status: "completed", storageKind: "alibaba" });
		await expect(service.create({ fileId: "file-1" }, actor)).rejects.toMatchObject({
			code: "STORAGE_PROVIDER_MISMATCH",
			statusCode: 503,
		});
	});

	it("按推导状态分页列出、幂等撤销并统计有效分享", async () => {
		const prisma = mockPrisma();
		prisma.storageShare.findMany.mockResolvedValue([
			row(),
			row({ id: "share-2", revokedAt: new Date("2026-09-04T01:00:00.000Z") }),
		]);
		prisma.storageShare.count.mockResolvedValue(2);
		prisma.storageShare.update.mockResolvedValue(row({ revokedAt: new Date(), revokedByIdentityId: actor.identityId }));
		prisma.storageShare.findUnique.mockResolvedValue(row());
		const service = new StorageShareService(prisma as never, {
			currentKind: vi.fn().mockReturnValue("local"),
		} as never);

		const result = await service.list({ page: 2, pageSize: 1 });
		expect(result).toMatchObject({ total: 2, page: 2, pageSize: 1, totalPages: 2 });
		expect(result.data[0]).not.toHaveProperty("tokenHash");
		expect(prisma.storageShare.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 1, take: 1 }));
		expect(prisma.storageShare.count).toHaveBeenCalledOnce();

		await expect(service.revoke("share-1", actor)).resolves.toMatchObject({ status: "revoked" });
		expect(prisma.storageShare.update).toHaveBeenCalledWith(expect.objectContaining({
			where: { id: "share-1" },
			data: expect.objectContaining({ revokedByIdentityId: actor.identityId }),
		}));

		prisma.storageShare.count.mockResolvedValue(1);
		await expect(service.hasActiveShares("file-1")).resolves.toBe(true);
		expect(prisma.storageShare.count).toHaveBeenLastCalledWith({
			where: { fileId: "file-1", revokedAt: null, invalidatedAt: null },
		});
	});
});
