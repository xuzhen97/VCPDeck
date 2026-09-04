import { describe, expect, it, vi } from "vitest";
import { FileService } from "./file.service.js";

function mockPrisma() {
	const file = {
		update: vi.fn().mockResolvedValue({
			key: "aliyun-file-id",
			size: 0,
		}),
		findUnique: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		delete: vi.fn(),
	};
	const storageShare = { count: vi.fn() };
	return {
		file,
		storageShare,
		$transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
			callback({ file, storageShare }),
		),
	};
}

describe("FileService.confirmUpload", () => {
	it("只确认摘要和状态，保留上传阶段持久化的真实 key", async () => {
		const prisma = mockPrisma();
		const service = new FileService(prisma as never, {} as never);

		const result = await service.confirmUpload("file-1", "sha256-value");

		expect(result).toEqual({ key: "aliyun-file-id", size: 0 });
		expect(prisma.file.update).toHaveBeenCalledWith({
			where: { id: "file-1" },
			data: { sha256: "sha256-value", status: "completed" },
		});
	});
});

describe("FileService share retention", () => {
	it("active share prevents provider deletion", async () => {
		const prisma = mockPrisma();
		prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
		prisma.storageShare.count.mockResolvedValue(1);
		const storage = { delete: vi.fn() };
		const service = new FileService(prisma as never, storage as never);

		await expect(service.delete("f1")).rejects.toMatchObject({
			code: "FILE_HAS_ACTIVE_SHARES",
			statusCode: 409,
		});
		expect(storage.delete).not.toHaveBeenCalled();
	});

	it("无有效分享时先认领 deleting，Provider 成功后删除 File", async () => {
		const prisma = mockPrisma();
		prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
		prisma.storageShare.count.mockResolvedValue(0);
		const storage = { delete: vi.fn().mockResolvedValue(undefined) };
		const service = new FileService(prisma as never, storage as never);

		await service.delete("f1");
		expect(prisma.file.updateMany).toHaveBeenCalledWith({
			where: { id: "f1", status: "completed" },
			data: { status: "deleting" },
		});
		expect(storage.delete).toHaveBeenCalledWith("k1");
		expect(prisma.file.delete).toHaveBeenCalledWith({ where: { id: "f1" } });
	});

	it("Provider 删除失败时恢复原 File 状态", async () => {
		const prisma = mockPrisma();
		prisma.file.findUnique.mockResolvedValue({ id: "f1", key: "k1", status: "completed" });
		prisma.storageShare.count.mockResolvedValue(0);
		const storage = { delete: vi.fn().mockRejectedValue(new Error("provider down")) };
		const service = new FileService(prisma as never, storage as never);

		await expect(service.delete("f1")).rejects.toThrow("provider down");
		expect(prisma.file.updateMany).toHaveBeenCalledWith({
			where: { id: "f1", status: "deleting" },
			data: { status: "completed" },
		});
		expect(prisma.file.delete).not.toHaveBeenCalled();
	});

	it("过期 File 查询排除 active share", async () => {
		const prisma = mockPrisma();
		prisma.file.findMany.mockResolvedValue([]);
		const service = new FileService(prisma as never, {} as never);

		await service.getExpiredFiles();
		expect(prisma.file.findMany).toHaveBeenCalledWith(expect.objectContaining({
			where: {
				expiresAt: { lte: expect.any(Date) },
				shares: { none: { revokedAt: null, invalidatedAt: null } },
			},
		}));
	});
});
