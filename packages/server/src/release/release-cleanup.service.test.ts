import { describe, expect, it, vi } from "vitest";
import { ReleaseStatus } from "@vcpdeck/shared";
import { ReleaseCleanupService } from "./release-cleanup.service.js";

const now = new Date("2026-08-29T00:00:00.000Z");
const archive = (platform: "win-x64" | "linux-x64", availability = "available") => ({
	sha256: "a".repeat(64),
	size: platform === "win-x64" ? 100 : 200,
	fileName: `${platform}.zip`,
	availability,
});
function release(overrides: Record<string, unknown> = {}) {
	return {
		version: "1.0.0",
		status: ReleaseStatus.FAILED,
		archives: {
			"win-x64": archive("win-x64"),
			"linux-x64": archive("linux-x64"),
		},
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		clientStates: {},
		...overrides,
	};
}

function fixture(
	releases = [release()],
	options: { backend?: "local" | "alibaba"; sessionProvider?: string } = {},
) {
	const backend = options.backend ?? "local";
	const rows = [
		{
			id: "session-1",
			version: "9.0.0",
			platform: "win-x64",
			size: 50,
			provider: options.sessionProvider ?? backend,
			providerKey: "provider-key",
			providerUploadId: "upload-1",
			partSize: 10,
			status: "pending",
			expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		},
	];
	const prisma = {
		releaseUploadSession: {
			findMany: vi.fn(async () => rows),
			delete: vi.fn(async ({ where }: { where: { id: string } }) => {
				const index = rows.findIndex((row) => row.id === where.id);
				if (index >= 0) rows.splice(index, 1);
			}),
		},
	};
	const releaseService = {
		listForCleanup: vi.fn(async () => releases),
		findByVersion: vi.fn(async (version: string) =>
			releases.find((item) => item.version === version) ?? null,
		),
		findByVersionWithStorage: vi.fn(async (version: string) =>
			releases.find((item) => item.version === version) ?? null,
		),
		getLatestActiveTarget: vi.fn(async () => null),
		getActiveRelease: vi.fn(async () => null),
		claimArchiveForCleanup: vi.fn(async (version: string, platform: string) => {
			const item = releases.find((value) => value.version === version) as any;
			const current = item?.archives[platform];
			if (!current || current.availability === "cleaned") return null;
			current.availability = "deleting";
			return current;
		}),
		finishArchiveCleanup: vi.fn(async (version: string, platform: string) => {
			const item = releases.find((value) => value.version === version) as any;
			const current = item?.archives[platform];
			if (!current || current.availability !== "deleting") return false;
			current.availability = "cleaned";
			return true;
		}),
		restoreArchiveAfterCleanup: vi.fn(async (version: string, platform: string) => {
			const item = releases.find((value) => value.version === version) as any;
			const current = item?.archives[platform];
			if (!current || current.availability !== "deleting") return false;
			current.availability = "available";
			return true;
		}),
	};
	const storage = {
		getBackendConfig: vi.fn(async () => ({ kind: backend, updatedAt: null })),
		delete: vi.fn(async () => undefined),
	};
	const removeLocal = vi.fn(async () => undefined);
	const service = new ReleaseCleanupService(
		prisma as never,
		releaseService as never,
		storage as never,
		{ now: () => now, removeLocal },
	);
	return { service, prisma, releaseService, storage, removeLocal, rows };
}

describe("ReleaseCleanupService", () => {
	it("preview 按平台聚合候选并隐藏 Provider key", async () => {
		const { service } = fixture();
		const preview = await service.preview();

		expect(preview.candidates).toEqual([
			{
				version: "1.0.0",
				status: ReleaseStatus.FAILED,
				archives: [
					{ platform: "win-x64", bytes: 100, providerState: "ready" },
					{ platform: "linux-x64", bytes: 200, providerState: "ready" },
				],
				bytes: 300,
				reason: "retention_policy",
			},
		]);
		expect(JSON.stringify(preview)).not.toContain("provider-key");
		expect(preview.expiredUploadSessions).toEqual({ count: 1, bytes: 50 });
		expect(preview.estimatedReclaimableBytes).toBe(350);
	});

	it("Local run 按 claim → 删除 → finish 顺序执行", async () => {
		const { service, releaseService, removeLocal } = fixture();
		const result = await service.run();

		expect(removeLocal).toHaveBeenCalledTimes(2);
		expect(releaseService.claimArchiveForCleanup).toHaveBeenCalledTimes(2);
		expect(releaseService.finishArchiveCleanup).toHaveBeenCalledTimes(2);
		expect(result.cleanedItems).toBe(3);
		expect(result.cleanedBytes).toBe(350);
	});

	it("删除失败恢复 available 并报告可重试错误", async () => {
		const { service, releaseService, removeLocal } = fixture();
		removeLocal.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

		const result = await service.run();

		expect(releaseService.restoreArchiveAfterCleanup).toHaveBeenCalledWith(
			"1.0.0",
			"win-x64",
		);
		expect(result.failed).toBe(1);
		expect(result.retryable).toBe(true);
		expect(result.issues[0]).toEqual({
			version: "1.0.0",
			platform: "win-x64",
			code: "RELEASE_CLEANUP_DELETE_FAILED",
		});
	});

	it("过期上传会话先删除 Provider 对象再删除 DB 记录", async () => {
		const { service, storage, prisma } = fixture([], { backend: "alibaba" });
		await service.run();

		expect(storage.delete).toHaveBeenCalledWith("provider-key");
		expect(prisma.releaseUploadSession.delete).toHaveBeenCalledWith({
			where: { id: "session-1" },
		});
	});

	it("上传会话 Provider 不匹配时不删除对象、不删除 DB 记录", async () => {
		const { service, storage, prisma, rows } = fixture([], {
			backend: "local",
			sessionProvider: "alibaba",
		});
		const result = await service.run();

		expect(storage.delete).not.toHaveBeenCalled();
		expect(prisma.releaseUploadSession.delete).not.toHaveBeenCalled();
		expect(result.providerUnavailable).toBe(1);
		expect(result.issues).toContainEqual({
			version: "9.0.0",
			code: "RELEASE_CLEANUP_PROVIDER_UNAVAILABLE",
		});
		expect(rows).toHaveLength(1);
	});

	it("archive Provider 不匹配时不删除、不清除 key", async () => {
		const item = release({
			archives: {
				"win-x64": {
					...archive("win-x64"),
					storage: { provider: "alibaba", key: "provider-key", mode: "direct" },
				},
			},
		});
		const { service, storage, rows } = fixture([item]);
		rows.splice(0);
		const preview = await service.preview();
		const result = await service.run();

		expect(preview.candidates[0]?.archives[0]?.providerState).toBe(
			"provider_unavailable",
		);
		expect(storage.delete).not.toHaveBeenCalled();
		expect(result.providerUnavailable).toBe(1);
	});

	it("并发 run 返回 RELEASE_CLEANUP_BUSY", async () => {
		const { service, removeLocal } = fixture();
		let releaseDelete: () => void = () => undefined;
		let startedResolve: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		let firstDelete = true;
		removeLocal.mockImplementation(
			() => {
				if (!firstDelete) return Promise.resolve(undefined);
				firstDelete = false;
				return new Promise<undefined>((resolve) => {
					startedResolve();
					releaseDelete = () => resolve(undefined);
				});
			},
		);
		const first = service.run();
		await started;
		await expect(service.run()).rejects.toMatchObject({
			code: "RELEASE_CLEANUP_BUSY",
		});
		releaseDelete();
		await first;
	});
});
