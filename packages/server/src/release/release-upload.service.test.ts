import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseUploadService } from "./release-upload.service.js";

const SHA = "a".repeat(64);
const input = {
	version: "0.2.1",
	platform: "win-x64" as const,
	sha256: SHA,
	size: 100,
};

function release(archives: Record<string, unknown> = {}) {
	return {
		version: "0.2.1",
		archives,
		status: "uploaded",
		clientStates: {},
		createdAt: "2026-08-21T00:00:00.000Z",
		updatedAt: "2026-08-21T00:00:00.000Z",
	};
}

function fixture(options: { backend?: "local" | "alibaba"; row?: any } = {}) {
	let row = options.row ?? null;
	const delegate = {
		findUnique: vi.fn(async () => row),
		create: vi.fn(async ({ data }: any) => {
			row = {
				...data,
				createdByName: data.createdByName,
				createdVia: data.createdVia,
			};
			return row;
		}),
		delete: vi.fn(async () => {
			row = null;
		}),
		update: vi.fn(async ({ data }: any) => {
			row = { ...row, ...data };
			return row;
		}),
	};
	const prisma = { releaseUploadSession: delegate };
	const storage = {
		getBackendConfig: vi.fn(async () => ({
			kind: options.backend ?? "alibaba",
			updatedAt: null,
		})),
		createReleaseDirectUpload: vi.fn(async () => ({
			fileId: "provider-file",
			uploadId: "provider-upload",
			partSize: 64,
			parts: [
				{ partNumber: 1, url: "https://provider.invalid/secret-1" },
				{ partNumber: 2, url: "https://provider.invalid/secret-2" },
			],
		})),
		refreshReleaseDirectUploadParts: vi.fn(
			async (_fileId: string, _uploadId: string, partNumbers: number[]) =>
				partNumbers.map((partNumber) => ({
					partNumber,
					url: `https://provider.invalid/refreshed-${partNumber}`,
				})),
		),
		completeReleaseDirectUpload: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	};
	const releases = {
		findByVersion: vi.fn(async () => null as any),
		findByVersionWithStorage: vi.fn(async () => null as any),
		create: vi.fn(async ({ archives }: any) => {
			const publicArchives = Object.fromEntries(
				Object.entries(archives).map(([platform, archive]: [string, any]) => {
					if (!archive.storage) return [platform, archive];
					const { key: _key, ...storage } = archive.storage;
					return [platform, { ...archive, storage }];
				}),
			);
			return release(publicArchives) as any;
		}),
		addArchive: vi.fn(
			async (_version: string, platform: string, archive: any) =>
				release({ [platform]: archive }) as any,
		),
		hasAllArchives: vi.fn(() => false),
	};
	const orchestrator = { startRelease: vi.fn(async () => undefined) };
	const service = new ReleaseUploadService(
		prisma as never,
		storage as never,
		releases as never,
		orchestrator as never,
	);
	return {
		service,
		delegate,
		storage,
		releases,
		orchestrator,
		getRow: () => row,
	};
}

function pendingRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		version: "0.2.1",
		platform: "win-x64",
		sha256: SHA,
		size: 100,
		provider: "alibaba",
		providerKey: "provider-file",
		providerUploadId: "provider-upload",
		partSize: 64,
		status: "pending",
		createdByName: "Operator",
		createdVia: "cli",
		expiresAt: new Date(Date.now() + 60_000),
		...overrides,
	};
}

describe("ReleaseUploadService", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("Local 后端只协商 server 模式", async () => {
		const { service, storage, delegate } = fixture({ backend: "local" });
		await expect(service.createSession(input)).resolves.toEqual({
			mode: "server",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
		expect(delegate.create).not.toHaveBeenCalled();
	});

	it("Alibaba 创建持久化会话但不持久化预签名 URL", async () => {
		const { service, delegate, getRow } = fixture();
		const result = await service.createSession(input);
		expect(result).toMatchObject({ mode: "direct", partSize: 64 });
		expect(result.mode === "direct" ? result.parts : []).toHaveLength(2);
		expect(delegate.create).toHaveBeenCalledOnce();
		expect(JSON.stringify(getRow())).not.toContain("provider.invalid");
	});

	it("服务重启后从持久化会话刷新全部分片 URL", async () => {
		const row = pendingRow();
		const { service, storage } = fixture({ row });
		const result = await service.createSession(input);
		expect(result).toMatchObject({ mode: "direct", sessionId: "session-1" });
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
		expect(storage.refreshReleaseDirectUploadParts).toHaveBeenCalledWith(
			"provider-file",
			"provider-upload",
			[1, 2],
		);
	});

	it("相同已登记构件幂等跳过，不同构件拒绝", async () => {
		const { service, releases, storage } = fixture();
		releases.findByVersion.mockResolvedValueOnce(
			release({ "win-x64": { sha256: SHA, size: 100 } }),
		);
		await expect(service.createSession(input)).resolves.toMatchObject({
			mode: "existing",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();

		releases.findByVersion.mockResolvedValueOnce(
			release({ "win-x64": { sha256: "b".repeat(64), size: 100 } }),
		);
		releases.findByVersionWithStorage.mockResolvedValueOnce(null);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_ARCHIVE_EXISTS",
		});
	});

	it("完成前严格校验上传字节数", async () => {
		const { service, storage, releases } = fixture({ row: pendingRow() });
		await expect(service.completeSession("session-1", 99)).rejects.toMatchObject({
			code: "RELEASE_UPLOAD_SIZE_MISMATCH",
		});
		expect(storage.completeReleaseDirectUpload).not.toHaveBeenCalled();
		expect(releases.create).not.toHaveBeenCalled();
	});

	it("完成 Provider 后登记 storage 元数据并更新会话", async () => {
		const { service, storage, releases, delegate } = fixture({
			row: pendingRow(),
		});
		const result = await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledWith(
			"provider-file",
			"provider-upload",
		);
		expect(releases.create).toHaveBeenCalledWith(
			expect.objectContaining({
				archives: {
					"win-x64": expect.objectContaining({
						sha256: SHA,
						size: 100,
						storage: {
							provider: "alibaba",
							key: "provider-file",
							mode: "direct",
						},
					}),
				},
			}),
		);
		expect(delegate.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { status: "completed" },
		});
		expect(result.release.version).toBe("0.2.1");
		expect(JSON.stringify(result.release)).not.toContain("provider-file");
	});

	it("Release 已登记但会话未完成时修复状态且不重复 complete", async () => {
		const { service, releases, storage, delegate } = fixture({
			row: pendingRow(),
		});
		releases.findByVersionWithStorage.mockResolvedValue(
			release({
				"win-x64": {
					sha256: SHA,
					size: 100,
					storage: { provider: "alibaba", key: "provider-file", mode: "direct" },
				},
			}),
		);
		await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).not.toHaveBeenCalled();
		expect(delegate.update).toHaveBeenCalled();
	});

	it("两个平台齐备时触发编排", async () => {
		const { service, releases, orchestrator } = fixture({ row: pendingRow() });
		releases.hasAllArchives.mockReturnValue(true);
		await service.completeSession("session-1", 100);
		await vi.waitFor(() =>
			expect(orchestrator.startRelease).toHaveBeenCalledWith("0.2.1"),
		);
	});

	it("cleaned archive 仍占用版本，不作为幂等已有构件", async () => {
		const { service, releases, storage } = fixture();
		releases.findByVersion.mockResolvedValueOnce(
			release({
				"win-x64": {
					sha256: SHA,
					size: 100,
					fileName: "win.zip",
					availability: "cleaned",
					cleanedAt: "2026-08-29T00:00:00.000Z",
					cleanupReason: "retention_policy",
				},
			}),
		);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_ARCHIVE_EXISTS",
		});
		expect(storage.createReleaseDirectUpload).not.toHaveBeenCalled();
	});

	it("Provider 合并后登记失败时持久化 provider_completed，重试不重复合并", async () => {
		const { service, storage, releases, delegate } = fixture({
			row: pendingRow(),
		});
		releases.create.mockRejectedValueOnce(new Error("登记暂时失败"));
		await expect(service.completeSession("session-1", 100)).rejects.toThrow(
			"登记暂时失败",
		);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledOnce();
		expect(delegate.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { status: "provider_completed" },
		});

		const result = await service.completeSession("session-1", 100);
		expect(storage.completeReleaseDirectUpload).toHaveBeenCalledOnce();
		expect(result.release.version).toBe("0.2.1");
	});

	it("Provider 原始失败归一化为安全稳定错误", async () => {
		const { service, storage } = fixture();
		storage.createReleaseDirectUpload.mockRejectedValue(
			new Error("raw provider token=secret response"),
		);
		await expect(service.createSession(input)).rejects.toMatchObject({
			code: "RELEASE_UPLOAD_PROVIDER_FAILED",
			message: "外部存储操作失败，请稍后重试",
		});
	});
});
