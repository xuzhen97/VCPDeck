"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const alibaba_storage_provider_js_1 = require("./alibaba-storage.provider.js");
const baseConfig = {
    clientId: "app-id",
    accessToken: "token",
    expiresAt: Date.now() + 3_600_000,
    transferFolder: "VCPDeckTransfers",
};
function openapiOk(body) {
    return vitest_1.vi.fn().mockResolvedValue(Response.json(body));
}
(0, vitest_1.describe)("AlibabaStorageProvider 直传会话", () => {
    (0, vitest_1.afterEach)(() => vitest_1.vi.unstubAllGlobals());
    (0, vitest_1.it)("刷新 token 后调用持久化回调写回新凭证", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            clientId: "app-id",
            accessToken: "old-token",
            refreshToken: "refresh-old",
            expiresAt: Date.now() - 60_000, // 已过期 → 触发刷新
            driveId: "drive-1",
        });
        const persist = vitest_1.vi.fn();
        provider.setTokenPersistence(persist);
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi
            .fn()
            .mockResolvedValueOnce(Response.json({
            access_token: "new-token",
            refresh_token: "refresh-new",
            expires_in: 3600,
        }))
            .mockResolvedValueOnce(Response.json({ url: "https://download.example/x", expire_time: 1 })));
        await provider.getExternalDownloadUrl("file-1");
        (0, vitest_1.expect)(persist).toHaveBeenCalledWith({
            accessToken: "new-token",
            refreshToken: "refresh-new",
            expiresAt: vitest_1.expect.any(Number),
        });
    });
    (0, vitest_1.it)("未设置持久化回调时刷新不抛错", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            clientId: "app-id",
            accessToken: "old-token",
            refreshToken: "refresh-old",
            expiresAt: Date.now() - 60_000,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi
            .fn()
            .mockResolvedValueOnce(Response.json({
            access_token: "new-token",
            refresh_token: "refresh-new",
            expires_in: 3600,
        }))
            .mockResolvedValueOnce(Response.json({ url: "https://download.example/x", expire_time: 1 })));
        await (0, vitest_1.expect)(provider.getExternalDownloadUrl("file-1")).resolves.toMatchObject({ url: "https://download.example/x" });
    });
    (0, vitest_1.it)("createDirectUpload 按 size 分片并返回各片 URL", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider(baseConfig);
        const fetcher = vitest_1.vi
            .fn()
            // ensureReady：getDriveInfo
            .mockResolvedValueOnce(Response.json({ default_drive_id: "drive-1" }))
            // ensureFolderPath：列出 VCPDeckTransfers → 空
            .mockResolvedValueOnce(Response.json({ items: [] }))
            // ensureFolderPath：创建文件夹
            .mockResolvedValueOnce(Response.json({ file_id: "folder-1" }))
            // createFileUpload
            .mockResolvedValueOnce(Response.json({
            file_id: "file-1",
            upload_id: "upload-1",
            part_info_list: [
                { part_number: 1, upload_url: "https://oss.example/p1" },
                { part_number: 2, upload_url: "https://oss.example/p2" },
            ],
        }));
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const result = await provider.createDirectUpload(alibaba_storage_provider_js_1.ALIBABA_PART_SIZE + 1, "big.bin");
        (0, vitest_1.expect)(result).toMatchObject({
            fileId: "file-1",
            uploadId: "upload-1",
            partSize: alibaba_storage_provider_js_1.ALIBABA_PART_SIZE,
            parts: [
                { partNumber: 1, url: "https://oss.example/p1" },
                { partNumber: 2, url: "https://oss.example/p2" },
            ],
        });
    });
    (0, vitest_1.it)("createDirectUpload 的 create 响应缺 URL 时调 getUploadUrl 补齐", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider(baseConfig);
        const fetcher = vitest_1.vi
            .fn()
            .mockResolvedValueOnce(Response.json({ default_drive_id: "drive-1" }))
            .mockResolvedValueOnce(Response.json({ items: [] }))
            .mockResolvedValueOnce(Response.json({ file_id: "folder-1" }))
            // create 不带 upload_url
            .mockResolvedValueOnce(Response.json({
            file_id: "file-1",
            upload_id: "upload-1",
            part_info_list: [{ part_number: 1 }, { part_number: 2 }],
        }))
            // getUploadUrl 补齐
            .mockResolvedValueOnce(Response.json({
            part_info_list: [
                { part_number: 1, upload_url: "https://oss.example/p1" },
                { part_number: 2, upload_url: "https://oss.example/p2" },
            ],
        }));
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const result = await provider.createDirectUpload(alibaba_storage_provider_js_1.ALIBABA_PART_SIZE + 1, "big.bin");
        (0, vitest_1.expect)(result.parts).toHaveLength(2);
        (0, vitest_1.expect)(result.parts[0]?.url).toBe("https://oss.example/p1");
    });
    (0, vitest_1.it)("refreshPartUrls 返回续期后的分片 URL", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", openapiOk({
            part_info_list: [
                { part_number: 2, upload_url: "https://oss.example/p2-new" },
            ],
        }));
        const parts = await provider.refreshPartUrls("file-1", "upload-1", [2]);
        (0, vitest_1.expect)(parts).toEqual([{ partNumber: 2, url: "https://oss.example/p2-new" }]);
    });
    (0, vitest_1.it)("completeDirectUpload 调 complete 接口", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        const fetcher = openapiOk({});
        vitest_1.vi.stubGlobal("fetch", fetcher);
        await provider.completeDirectUpload("file-1", "upload-1");
        let body = {};
        try {
            body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
        }
        catch {
            body = {};
        }
        (0, vitest_1.expect)(body).toMatchObject({ file_id: "file-1", upload_id: "upload-1" });
    });
    (0, vitest_1.it)("对象不存在时只将明确的 OpenAPI 404 分类为永久缺失", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
        await (0, vitest_1.expect)(provider.download("file-missing")).rejects.toMatchObject({
            name: "StorageObjectNotFoundError",
        });
    });
    (0, vitest_1.it)("授权或临时 OpenAPI 错误不分类为永久缺失", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
        await (0, vitest_1.expect)(provider.download("file-temporary-failure")).rejects.not.toMatchObject({
            name: "StorageObjectNotFoundError",
        });
    });
    (0, vitest_1.it)("getExternalDownloadUrl 返回外部 URL", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", openapiOk({
            url: "https://download.example/x",
            expire_time: 1760000000000,
        }));
        const result = await provider.getExternalDownloadUrl("file-1");
        (0, vitest_1.expect)(result).toEqual({
            url: "https://download.example/x",
            expiresAt: 1760000000000,
        });
    });
    (0, vitest_1.it)("将阿里云盘过期证书下载域名替换为有效域名并保留签名参数", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", openapiOk({
            url: "https://dl1-v6.aliyundrive.cloud/object/path?x-oss-signature=test",
            expire_time: 1760000000000,
        }));
        await (0, vitest_1.expect)(provider.getExternalDownloadUrl("file-1")).resolves.toEqual({
            url: "https://cn-beijing-data.aliyundrive.net/object/path?x-oss-signature=test",
            expiresAt: 1760000000000,
        });
    });
    (0, vitest_1.it)("getDirectDownloadUrl（ADR-0016）委托外部下载 URL", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", openapiOk({
            url: "https://download.example/y",
            expire_time: 1760000000000,
        }));
        await (0, vitest_1.expect)(provider.getDirectDownloadUrl("file-1")).resolves.toEqual({
            url: "https://download.example/y",
            expiresAt: 1760000000000,
        });
    });
    (0, vitest_1.it)("expire_time 为 ISO 字符串时解析为毫秒时间戳", async () => {
        const provider = new alibaba_storage_provider_js_1.AlibabaStorageProvider({
            ...baseConfig,
            driveId: "drive-1",
        });
        vitest_1.vi.stubGlobal("fetch", openapiOk({
            url: "https://download.example/z",
            expire_time: "2026-08-18T12:00:00.000Z",
        }));
        const result = await provider.getExternalDownloadUrl("file-1");
        (0, vitest_1.expect)(result.url).toBe("https://download.example/z");
        (0, vitest_1.expect)(result.expiresAt).toBe(Date.parse("2026-08-18T12:00:00.000Z"));
    });
});
