import { describe, expect, it, vi } from "vitest";
import { FileService } from "./file.service.js";

function mockPrisma() {
	return {
		file: {
			update: vi.fn().mockResolvedValue({
				key: "aliyun-file-id",
				size: 0,
			}),
		},
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
