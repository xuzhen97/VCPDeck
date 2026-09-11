"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const storage_delete_controller_js_1 = require("./storage-delete.controller.js");
(0, vitest_1.describe)("StorageDeleteController", () => {
    (0, vitest_1.it)("按 key 找到 File 时委托 FileService，避免绕过 active share 锁", async () => {
        const files = { findByKey: vitest_1.vi.fn().mockResolvedValue({ id: "file-1" }), delete: vitest_1.vi.fn() };
        const storage = { delete: vitest_1.vi.fn() };
        const controller = new storage_delete_controller_js_1.StorageDeleteController(files, storage);
        await controller.delete("file-key");
        (0, vitest_1.expect)(files.delete).toHaveBeenCalledWith("file-1");
        (0, vitest_1.expect)(storage.delete).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("没有 File 登记时保留专用对象的 raw key 删除兜底", async () => {
        const files = { findByKey: vitest_1.vi.fn().mockResolvedValue(null), delete: vitest_1.vi.fn() };
        const storage = { delete: vitest_1.vi.fn().mockResolvedValue(undefined) };
        const controller = new storage_delete_controller_js_1.StorageDeleteController(files, storage);
        await controller.delete("release-provider-key");
        (0, vitest_1.expect)(storage.delete).toHaveBeenCalledWith("release-provider-key");
    });
});
