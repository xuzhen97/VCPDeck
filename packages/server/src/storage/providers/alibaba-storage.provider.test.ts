import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AlibabaStorageProvider,
	ALIBABA_PART_SIZE,
} from "./alibaba-storage.provider.js";

const baseConfig = {
	clientId: "app-id",
	accessToken: "token",
	expiresAt: Date.now() + 3_600_000,
	transferFolder: "VCPDeckTransfers",
};

function openapiOk(body: unknown) {
	return vi.fn().mockResolvedValue(Response.json(body));
}

describe("AlibabaStorageProvider 直传会话", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("刷新 token 后调用持久化回调写回新凭证", async () => {
		const provider = new AlibabaStorageProvider({
			clientId: "app-id",
			accessToken: "old-token",
			refreshToken: "refresh-old",
			expiresAt: Date.now() - 60_000, // 已过期 → 触发刷新
			driveId: "drive-1",
		} as never);
		const persist = vi.fn();
		provider.setTokenPersistence(persist);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						access_token: "new-token",
						refresh_token: "refresh-new",
						expires_in: 3600,
					}),
				)
				.mockResolvedValueOnce(
					Response.json({ url: "https://download.example/x", expire_time: 1 }),
				),
		);

		await provider.getExternalDownloadUrl("file-1");

		expect(persist).toHaveBeenCalledWith({
			accessToken: "new-token",
			refreshToken: "refresh-new",
			expiresAt: expect.any(Number),
		});
	});

	it("未设置持久化回调时刷新不抛错", async () => {
		const provider = new AlibabaStorageProvider({
			clientId: "app-id",
			accessToken: "old-token",
			refreshToken: "refresh-old",
			expiresAt: Date.now() - 60_000,
			driveId: "drive-1",
		} as never);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					Response.json({
						access_token: "new-token",
						refresh_token: "refresh-new",
						expires_in: 3600,
					}),
				)
				.mockResolvedValueOnce(
					Response.json({ url: "https://download.example/x", expire_time: 1 }),
				),
		);

		await expect(
			provider.getExternalDownloadUrl("file-1"),
		).resolves.toMatchObject({ url: "https://download.example/x" });
	});

	it("createDirectUpload 按 size 分片并返回各片 URL", async () => {
		const provider = new AlibabaStorageProvider(baseConfig as never);
		const fetcher = vi
			.fn()
			// ensureReady：getDriveInfo
			.mockResolvedValueOnce(Response.json({ default_drive_id: "drive-1" }))
			// ensureFolderPath：列出 VCPDeckTransfers → 空
			.mockResolvedValueOnce(Response.json({ items: [] }))
			// ensureFolderPath：创建文件夹
			.mockResolvedValueOnce(Response.json({ file_id: "folder-1" }))
			// createFileUpload
			.mockResolvedValueOnce(
				Response.json({
					file_id: "file-1",
					upload_id: "upload-1",
					part_info_list: [
						{ part_number: 1, upload_url: "https://oss.example/p1" },
						{ part_number: 2, upload_url: "https://oss.example/p2" },
					],
				}),
			);
		vi.stubGlobal("fetch", fetcher);

		const result = await provider.createDirectUpload(
			ALIBABA_PART_SIZE + 1,
			"big.bin",
		);

		expect(result).toMatchObject({
			fileId: "file-1",
			uploadId: "upload-1",
			parts: [
				{ partNumber: 1, url: "https://oss.example/p1" },
				{ partNumber: 2, url: "https://oss.example/p2" },
			],
		});
	});

	it("createDirectUpload 的 create 响应缺 URL 时调 getUploadUrl 补齐", async () => {
		const provider = new AlibabaStorageProvider(baseConfig as never);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ default_drive_id: "drive-1" }))
			.mockResolvedValueOnce(Response.json({ items: [] }))
			.mockResolvedValueOnce(Response.json({ file_id: "folder-1" }))
			// create 不带 upload_url
			.mockResolvedValueOnce(
				Response.json({
					file_id: "file-1",
					upload_id: "upload-1",
					part_info_list: [{ part_number: 1 }, { part_number: 2 }],
				}),
			)
			// getUploadUrl 补齐
			.mockResolvedValueOnce(
				Response.json({
					part_info_list: [
						{ part_number: 1, upload_url: "https://oss.example/p1" },
						{ part_number: 2, upload_url: "https://oss.example/p2" },
					],
				}),
			);
		vi.stubGlobal("fetch", fetcher);

		const result = await provider.createDirectUpload(
			ALIBABA_PART_SIZE + 1,
			"big.bin",
		);

		expect(result.parts).toHaveLength(2);
		expect(result.parts[0]?.url).toBe("https://oss.example/p1");
	});

	it("refreshPartUrls 返回续期后的分片 URL", async () => {
		const provider = new AlibabaStorageProvider({
			...baseConfig,
			driveId: "drive-1",
		} as never);
		vi.stubGlobal(
			"fetch",
			openapiOk({
				part_info_list: [
					{ part_number: 2, upload_url: "https://oss.example/p2-new" },
				],
			}),
		);
		const parts = await provider.refreshPartUrls("file-1", "upload-1", [2]);
		expect(parts).toEqual([
			{ partNumber: 2, url: "https://oss.example/p2-new" },
		]);
	});

	it("completeDirectUpload 调 complete 接口", async () => {
		const provider = new AlibabaStorageProvider({
			...baseConfig,
			driveId: "drive-1",
		} as never);
		const fetcher = openapiOk({});
		vi.stubGlobal("fetch", fetcher);
		await provider.completeDirectUpload("file-1", "upload-1");
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
		} catch {
			body = {};
		}
		expect(body).toMatchObject({ file_id: "file-1", upload_id: "upload-1" });
	});

	it("getExternalDownloadUrl 返回外部 URL", async () => {
		const provider = new AlibabaStorageProvider({
			...baseConfig,
			driveId: "drive-1",
		} as never);
		vi.stubGlobal(
			"fetch",
			openapiOk({
				url: "https://download.example/x",
				expire_time: 1760000000000,
			}),
		);
		const result = await provider.getExternalDownloadUrl("file-1");
		expect(result).toEqual({
			url: "https://download.example/x",
			expiresAt: 1760000000000,
		});
	});
});
