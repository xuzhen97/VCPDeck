import { describe, expect, it, vi } from "vitest";
import { StorageDeleteController } from "./storage-delete.controller.js";

describe("StorageDeleteController", () => {
	it("按 key 找到 File 时委托 FileService，避免绕过 active share 锁", async () => {
		const files = { findByKey: vi.fn().mockResolvedValue({ id: "file-1" }), delete: vi.fn() };
		const storage = { delete: vi.fn() };
		const controller = new StorageDeleteController(files as never, storage as never);

		await controller.delete("file-key");
		expect(files.delete).toHaveBeenCalledWith("file-1");
		expect(storage.delete).not.toHaveBeenCalled();
	});

	it("没有 File 登记时保留专用对象的 raw key 删除兜底", async () => {
		const files = { findByKey: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		const storage = { delete: vi.fn().mockResolvedValue(undefined) };
		const controller = new StorageDeleteController(files as never, storage as never);

		await controller.delete("release-provider-key");
		expect(storage.delete).toHaveBeenCalledWith("release-provider-key");
	});
});
