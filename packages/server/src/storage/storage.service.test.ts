import { beforeEach, describe, expect, it, vi } from "vitest";
import { StorageService } from "./storage.service.js";

function mockPrisma() {
	return {
		storageBackendConfig: {
			findFirst: vi.fn(),
			upsert: vi.fn(),
		},
		file: {
			findFirst: vi.fn(),
			findUnique: vi.fn().mockResolvedValue(null),
			updateMany: vi.fn(),
		},
	};
}

describe("StorageService", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let service: StorageService;

	beforeEach(() => {
		prisma = mockPrisma();
		service = new StorageService(prisma as never);
	});

	describe("loadProvider", () => {
		it("config 缺 signSecret 时生成并写回 DB", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "local",
				config: "{}",
				updatedAt: null,
			});

			await service.loadProvider();

			expect(prisma.storageBackendConfig.upsert).toHaveBeenCalledWith({
				where: { id: 1 },
				create: expect.objectContaining({
					id: 1,
					kind: "local",
					config: expect.stringContaining("signSecret"),
				}),
				update: expect.objectContaining({
					config: expect.stringContaining("signSecret"),
				}),
			});
		});

		it("已有 signSecret 时不重复写回", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "local",
				config: JSON.stringify({ signSecret: "fixed-secret" }),
				updatedAt: null,
			});

			await service.loadProvider();

			expect(prisma.storageBackendConfig.upsert).not.toHaveBeenCalled();
		});
	});

	describe("resolveFilename", () => {
		it("从 File 记录返回真实文件名（阿里云盘 key 为 fileId）", async () => {
			prisma.file.findFirst.mockResolvedValue({
				filename: "nginx-1.18.0.zip",
			});

			expect(
				await service.resolveFilename(
					"6a6da3a2cbc85401786349bf8253c4d8b6cbc2a1",
				),
			).toBe("nginx-1.18.0.zip");
			expect(prisma.file.findFirst).toHaveBeenCalledWith({
				where: { key: "6a6da3a2cbc85401786349bf8253c4d8b6cbc2a1" },
				select: { filename: true },
			});
		});

		it("无 File 记录时返回 null（直接上传未建记录的兜底）", async () => {
			prisma.file.findFirst.mockResolvedValue(null);

			expect(await service.resolveFilename("some-key")).toBeNull();
		});
	});

	describe("receiveUpload", () => {
		it("上传完成后把 File 临时 key 替换为 provider 返回的真实 key", async () => {
			const provider = {
				verifyUploadSignature: vi.fn().mockReturnValue(true),
				uploadToKey: vi.fn().mockResolvedValue({
					key: "aliyun-file-id",
					jobId: "job-1",
					clientId: "client-1",
					filename: "nginx-1.18.0.zip",
					size: 158601385,
					storageKind: "alibaba",
					createdAt: new Date(),
				}),
			} as never;
			vi.spyOn(service, "getProvider").mockReturnValue(provider);

			await service.receiveUpload(
				"temporary-key/nginx-1.18.0.zip",
				{} as never,
				0,
				"sig",
			);

			expect(prisma.file.updateMany).toHaveBeenCalledWith({
				where: { key: "temporary-key/nginx-1.18.0.zip" },
				data: {
					key: "aliyun-file-id",
					status: "completed",
				},
			});
		});

		it("pending 缓存丢失时按临时 key 从 File 表恢复上传元数据", async () => {
			const uploadToKey = vi.fn().mockResolvedValue({
				key: "aliyun-file-id",
				jobId: "job-1",
				clientId: "client-1",
				filename: "nginx-1.18.0.zip",
				mimeType: "application/zip",
				size: 158601385,
				storageKind: "alibaba",
				createdAt: new Date(),
			});
			const provider = {
				verifyUploadSignature: vi.fn().mockReturnValue(true),
				uploadToKey,
			} as never;
			vi.spyOn(service, "getProvider").mockReturnValue(provider);
			prisma.file.findUnique.mockResolvedValue({
				jobId: "job-1",
				clientId: "client-1",
				filename: "nginx-1.18.0.zip",
				mimeType: "application/zip",
				size: 158601385,
			});
			const stream = {} as never;

			await service.receiveUpload(
				"temporary-key/nginx-1.18.0.zip",
				stream,
				0,
				"sig",
			);

			expect(prisma.file.findUnique).toHaveBeenCalledWith({
				where: { key: "temporary-key/nginx-1.18.0.zip" },
			});
			expect(uploadToKey).toHaveBeenCalledWith(
				stream,
				expect.objectContaining({
					jobId: "job-1",
					clientId: "client-1",
					filename: "nginx-1.18.0.zip",
					mimeType: "application/zip",
					size: 158601385,
				}),
				"temporary-key/nginx-1.18.0.zip",
			);
		});
	});

	describe("getBackendConfig", () => {
		it("returns kind and updatedAt without exposing config secrets", async () => {
			const updatedAt = new Date("2026-07-31T12:00:00.000Z");
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "alibaba",
				config: JSON.stringify({
					clientSecret: "secret-value",
					accessToken: "access-token",
					refreshToken: "refresh-token",
				}),
				updatedAt,
			});

			const result = await service.getBackendConfig();

			expect(result).toEqual({
				kind: "alibaba",
				updatedAt: updatedAt.toISOString(),
			});
			expect(result).not.toHaveProperty("config");
			expect(JSON.stringify(result)).not.toContain("secret-value");
			expect(JSON.stringify(result)).not.toContain("access-token");
			expect(JSON.stringify(result)).not.toContain("refresh-token");
		});

		it("defaults to local when no database row exists", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue(null);

			expect(await service.getBackendConfig()).toEqual({
				kind: "local",
				updatedAt: null,
			});
		});

		it("normalizes an unknown persisted kind to the effective local fallback", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "unsupported",
				config: "{}",
				updatedAt: null,
			});

			expect(await service.getBackendConfig()).toEqual({
				kind: "local",
				updatedAt: null,
			});
		});
	});
});
