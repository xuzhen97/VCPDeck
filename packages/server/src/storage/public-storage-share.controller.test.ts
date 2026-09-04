import { describe, expect, it, vi } from "vitest";
import { StorageObjectNotFoundError } from "./providers/storage-provider.interface.js";
import { PublicStorageShareController } from "./public-storage-share.controller.js";

function makeResponse() {
	return {
		status: vi.fn().mockReturnThis(),
		setHeader: vi.fn(),
		end: vi.fn(),
		destroy: vi.fn(),
	};
}

const file = {
	id: "file-1",
	key: "secret/storage-key",
	filename: "photo.SVG",
	mimeType: "text/plain",
	size: 12,
	status: "completed",
	storageKind: "local",
};

function makeService(overrides: Record<string, unknown> = {}) {
	return {
		resolvePublic: vi.fn().mockResolvedValue({ id: "share-1", file }),
		markInvalid: vi.fn(),
		...overrides,
	};
}

describe("PublicStorageShareController", () => {
	it("普通文件返回不可缓存 302，不需要 VCPDeck 认证", async () => {
		const service = makeService({ resolvePublic: vi.fn().mockResolvedValue({ id: "share-1", file: { ...file, filename: "report.pdf" } }) });
		const storage = {
			currentKind: vi.fn().mockReturnValue("local"),
			createDownloadToken: vi.fn().mockResolvedValue({ url: "https://provider.example/temporary", expiresAt: 1 }),
		};
		const controller = new PublicStorageShareController(service as never, storage as never);
		const response = makeResponse();

		await controller.download("A".repeat(43), response as never);

		expect(storage.createDownloadToken).toHaveBeenCalledWith("secret/storage-key");
		expect(response.status).toHaveBeenCalledWith(302);
		expect(response.setHeader).toHaveBeenCalledWith("Location", "https://provider.example/temporary");
		expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
		expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
		expect(response.end).toHaveBeenCalledOnce();
	});

	it("图片由 Server 代理并设置固定 MIME、安全 disposition 和 SVG CSP", async () => {
		const stream = {
			on: vi.fn(),
			pipe: vi.fn(),
		};
		const service = makeService();
		const storage = {
			currentKind: vi.fn().mockReturnValue("local"),
			openDownload: vi.fn().mockResolvedValue({ stream, meta: { size: 7 } }),
		};
		const controller = new PublicStorageShareController(service as never, storage as never);
		const response = makeResponse();
		const pipe = vi.spyOn(stream, "pipe");

		await controller.download("B".repeat(43), response as never);

		expect(storage.openDownload).toHaveBeenCalledWith("secret/storage-key");
		expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/svg+xml");
		expect(response.setHeader).toHaveBeenCalledWith(
		"Content-Disposition",
		"inline; filename*=UTF-8''photo.SVG",
	);
		expect(response.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
		expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
		expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
		expect(response.setHeader).toHaveBeenCalledWith(
		"Content-Security-Policy",
		"sandbox; default-src 'none'; img-src data:",
	);
		expect(pipe).toHaveBeenCalledWith(response);
	});

	it("Token 无效返回安全 404，Provider 明确缺失时标记分享并返回 410", async () => {
		const notFound = makeService({ resolvePublic: vi.fn().mockRejectedValue(Object.assign(new Error("Not found"), { statusCode: 404 })) });
		const controller = new PublicStorageShareController(notFound as never, {} as never);
		await expect(controller.download("bad", makeResponse() as never)).rejects.toMatchObject({ status: 404 });

		const missing = makeService({
			resolvePublic: vi.fn().mockResolvedValue({ id: "share-1", file }),
			markInvalid: vi.fn().mockResolvedValue(undefined),
		});
		const storage = {
			currentKind: vi.fn().mockReturnValue("local"),
			openDownload: vi.fn().mockRejectedValue(new StorageObjectNotFoundError()),
		};
		const missingController = new PublicStorageShareController(missing as never, storage as never);
		await expect(missingController.download("C".repeat(43), makeResponse() as never)).rejects.toMatchObject({ status: 410 });
		expect(missing.markInvalid).toHaveBeenCalledWith("share-1", "OBJECT_NOT_FOUND");
	});
});
