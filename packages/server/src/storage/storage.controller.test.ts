import { describe, expect, it, vi } from "vitest";
import { StorageController } from "./storage.controller.js";

function makeController() {
	const storageService = {
		createDownloadToken: vi.fn(),
	};
	return {
		controller: new StorageController(storageService as never),
		storageService,
	};
}

function makeResponse() {
	return {
		status: vi.fn(),
		setHeader: vi.fn(),
		end: vi.fn(),
	};
}

describe("StorageController", () => {
	it("每次请求都签发 fresh URL 并返回不可缓存的 302", async () => {
		const { controller, storageService } = makeController();
		storageService.createDownloadToken
			.mockResolvedValueOnce({
				url: "https://download.example/one",
				expiresAt: 1,
			})
			.mockResolvedValueOnce({
				url: "https://download.example/two",
				expiresAt: 2,
			});
		const first = makeResponse();
		const second = makeResponse();

		await controller.redirectDownload("aliyun-file", first as never);
		await controller.redirectDownload("aliyun-file", second as never);

		expect(storageService.createDownloadToken).toHaveBeenCalledTimes(2);
		expect(storageService.createDownloadToken).toHaveBeenNthCalledWith(
			1,
			"aliyun-file",
		);
		expect(first.status).toHaveBeenCalledWith(302);
		expect(first.setHeader).toHaveBeenCalledWith(
			"Location",
			"https://download.example/one",
		);
		expect(second.setHeader).toHaveBeenCalledWith(
			"Location",
			"https://download.example/two",
		);
		expect(first.setHeader).toHaveBeenCalledWith(
			"Referrer-Policy",
			"no-referrer",
		);
		expect(first.setHeader).toHaveBeenCalledWith(
			"Cache-Control",
			"private, no-store",
		);
		expect(first.end).toHaveBeenCalledOnce();
	});

	it("local 签名地址同样通过稳定入口跳转", async () => {
		const { controller, storageService } = makeController();
		storageService.createDownloadToken.mockResolvedValue({
			url: "/api/storage/download/local-key?expires=123&sig=abc",
			expiresAt: 123,
		});
		const response = makeResponse();

		await controller.redirectDownload("local-key", response as never);

		expect(response.setHeader).toHaveBeenCalledWith(
			"Location",
			"/api/storage/download/local-key?expires=123&sig=abc",
		);
	});
});
