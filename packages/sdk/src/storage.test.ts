import { describe, expect, it, vi } from "vitest";
import { createStorageApi } from "./storage.js";

describe("storage.downloadUrl", () => {
	it("构造编码后的稳定相对下载地址且不发请求", () => {
		const request = vi.fn();
		const storage = createStorageApi({ request } as never);

		expect(storage.downloadUrl("folder/a b.zip")).toBe(
			"/api/storage/download-redirect/folder%2Fa%20b.zip",
		);
		expect(request).not.toHaveBeenCalled();
	});
});
