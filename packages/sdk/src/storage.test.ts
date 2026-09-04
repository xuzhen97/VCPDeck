import { describe, expect, it, vi } from "vitest";
import { createStorageApi } from "./storage.js";

describe("storage API", () => {
	it("构造编码后的稳定下载地址且不发请求", () => {
		const request = vi.fn();
		const storage = createStorageApi({ request } as never);

		expect(storage.downloadUrl("folder/a b.zip")).toBe(
			"/api/storage/download-redirect/folder%2Fa%20b.zip",
		);
		expect(request).not.toHaveBeenCalled();
	});

	it("使用受控 raw 路径删除对象", async () => {
		const request = vi.fn().mockResolvedValue({ ok: true });
		const storage = createStorageApi({ request } as never);

		await storage.delete("folder/a b.zip");

		expect(request).toHaveBeenCalledWith(
			"DELETE",
			"/api/storage/raw/folder%2Fa%20b.zip",
			undefined,
			undefined,
		);
	});
});
