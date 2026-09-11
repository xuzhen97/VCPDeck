"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_stream_1 = require("node:stream");
const vitest_1 = require("vitest");
const storage_service_js_1 = require("./storage.service.js");
function mockPrisma() {
    return {
        storageBackendConfig: {
            findFirst: vitest_1.vi.fn(),
            upsert: vitest_1.vi.fn(),
        },
        file: {
            findFirst: vitest_1.vi.fn(),
            findUnique: vitest_1.vi.fn().mockResolvedValue(null),
            findUniqueOrThrow: vitest_1.vi.fn(),
            updateMany: vitest_1.vi.fn(),
            update: vitest_1.vi.fn(),
        },
        job: {
            findUnique: vitest_1.vi.fn().mockResolvedValue(null),
            update: vitest_1.vi.fn(),
        },
    };
}
(0, vitest_1.describe)("StorageService", () => {
    let prisma;
    let service;
    (0, vitest_1.beforeEach)(() => {
        prisma = mockPrisma();
        service = new storage_service_js_1.StorageService(prisma);
    });
    (0, vitest_1.describe)("loadProvider", () => {
        (0, vitest_1.it)("config 缺 signSecret 时生成并写回 DB", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "local",
                config: "{}",
                updatedAt: null,
            });
            await service.loadProvider();
            (0, vitest_1.expect)(prisma.storageBackendConfig.upsert).toHaveBeenCalledWith({
                where: { id: 1 },
                create: vitest_1.expect.objectContaining({
                    id: 1,
                    kind: "local",
                    config: vitest_1.expect.stringContaining("signSecret"),
                }),
                update: vitest_1.expect.objectContaining({
                    config: vitest_1.expect.stringContaining("signSecret"),
                }),
            });
        });
        (0, vitest_1.it)("已有 signSecret 时不重复写回", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "local",
                config: JSON.stringify({ signSecret: "fixed-secret" }),
                updatedAt: null,
            });
            await service.loadProvider();
            (0, vitest_1.expect)(prisma.storageBackendConfig.upsert).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("alibaba provider 刷新 token 后把新凭证写回 DB", async () => {
            const config = {
                signSecret: "fixed-secret",
                clientId: "app-id",
                accessToken: "old-token",
                refreshToken: "refresh-old",
                expiresAt: Date.now() - 60_000, // 已过期 → 触发刷新
                driveId: "drive-1",
            };
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "alibaba",
                config: JSON.stringify(config),
                updatedAt: null,
            });
            await service.loadProvider();
            const provider = service.getProvider();
            vitest_1.vi.stubGlobal("fetch", vitest_1.vi
                .fn()
                .mockResolvedValueOnce(Response.json({
                access_token: "new-token",
                refresh_token: "refresh-new",
                expires_in: 3600,
            }))
                .mockResolvedValueOnce(Response.json({
                url: "https://download.example/x",
                expire_time: 1,
            })));
            await provider.getExternalDownloadUrl("file-1");
            (0, vitest_1.expect)(prisma.storageBackendConfig.upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                where: { id: 1 },
                update: vitest_1.expect.objectContaining({
                    config: vitest_1.expect.stringContaining("new-token"),
                }),
            }));
        });
    });
    (0, vitest_1.describe)("resolveFilename", () => {
        (0, vitest_1.it)("从 File 记录返回真实文件名（阿里云盘 key 为 fileId）", async () => {
            prisma.file.findFirst.mockResolvedValue({
                filename: "nginx-1.18.0.zip",
            });
            (0, vitest_1.expect)(await service.resolveFilename("file-key-1")).toBe("nginx-1.18.0.zip");
            (0, vitest_1.expect)(prisma.file.findFirst).toHaveBeenCalledWith({
                where: { key: "file-key-1" },
                select: { filename: true },
            });
        });
        (0, vitest_1.it)("无 File 记录时返回 null（直接上传未建记录的兜底）", async () => {
            prisma.file.findFirst.mockResolvedValue(null);
            (0, vitest_1.expect)(await service.resolveFilename("some-key")).toBeNull();
        });
    });
    (0, vitest_1.describe)("receiveUpload", () => {
        (0, vitest_1.it)("上传完成后把 File 临时 key 替换为 provider 返回的真实 key并保存摘要", async () => {
            const provider = {
                verifyUploadSignature: vitest_1.vi.fn().mockReturnValue(true),
                uploadToKey: vitest_1.vi.fn(async (stream) => {
                    for await (const _chunk of stream) {
                        // 消费上传流，模拟真实 provider。
                    }
                    return {
                        key: "aliyun-file-id",
                        jobId: "job-1",
                        clientId: "client-1",
                        filename: "nginx-1.18.0.zip",
                        size: 5,
                        storageKind: "alibaba",
                        createdAt: new Date(),
                    };
                }),
            };
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(provider);
            await service.receiveUpload("temporary-key/nginx-1.18.0.zip", node_stream_1.Readable.from([Buffer.from("hello")]), 0, "sig");
            (0, vitest_1.expect)(prisma.file.updateMany).toHaveBeenCalledWith({
                where: { key: "temporary-key/nginx-1.18.0.zip" },
                data: {
                    key: "aliyun-file-id",
                    status: "completed",
                    size: 5,
                    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                },
            });
        });
        (0, vitest_1.it)("pending 缓存丢失时按临时 key 从 File 表恢复上传元数据", async () => {
            const uploadToKey = vitest_1.vi.fn(async (stream) => {
                for await (const _chunk of stream) {
                    // 消费上传流，模拟真实 provider。
                }
                return {
                    key: "aliyun-file-id",
                    jobId: "job-1",
                    clientId: "client-1",
                    filename: "nginx-1.18.0.zip",
                    mimeType: "application/zip",
                    size: 5,
                    storageKind: "alibaba",
                    createdAt: new Date(),
                };
            });
            const provider = {
                verifyUploadSignature: vitest_1.vi.fn().mockReturnValue(true),
                uploadToKey,
            };
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(provider);
            prisma.file.findUnique.mockResolvedValue({
                jobId: "job-1",
                clientId: "client-1",
                filename: "nginx-1.18.0.zip",
                mimeType: "application/zip",
                size: 158601385,
            });
            prisma.job.findUnique.mockResolvedValue({ type: "file.import" });
            const stream = node_stream_1.Readable.from([Buffer.from("hello")]);
            await service.receiveUpload("temporary-key/nginx-1.18.0.zip", stream, 0, "sig");
            (0, vitest_1.expect)(prisma.file.findUnique).toHaveBeenCalledWith({
                where: { key: "temporary-key/nginx-1.18.0.zip" },
            });
            (0, vitest_1.expect)(uploadToKey).toHaveBeenCalledWith(vitest_1.expect.any(node_stream_1.Readable), vitest_1.expect.objectContaining({
                jobId: "job-1",
                clientId: "client-1",
                filename: "nginx-1.18.0.zip",
                mimeType: "application/zip",
                size: 158601385,
            }), "temporary-key/nginx-1.18.0.zip");
            (0, vitest_1.expect)(prisma.job.update).toHaveBeenCalledWith({
                where: { id: "job-1" },
                data: { progress: JSON.stringify({ loaded: 5, total: 158601385 }) },
            });
        });
        (0, vitest_1.it)("file.import provider 失败时标记 Job 错误但不标记 File 完成", async () => {
            const provider = {
                verifyUploadSignature: vitest_1.vi.fn().mockReturnValue(true),
                uploadToKey: vitest_1.vi.fn().mockRejectedValue(new Error("provider down")),
            };
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(provider);
            prisma.file.findUnique.mockResolvedValue({
                jobId: "job-1",
                clientId: "client-1",
                filename: "a.txt",
                mimeType: "text/plain",
                size: 5,
            });
            prisma.job.findUnique.mockResolvedValue({ type: "file.import" });
            await (0, vitest_1.expect)(service.receiveUpload("temporary-key/a.txt", node_stream_1.Readable.from([Buffer.from("hello")]), 0, "sig")).rejects.toThrow("provider down");
            (0, vitest_1.expect)(prisma.file.updateMany).not.toHaveBeenCalled();
            (0, vitest_1.expect)(prisma.job.update).toHaveBeenCalledWith({
                where: { id: "job-1" },
                data: {
                    status: "error",
                    errorCode: "IO_ERROR",
                    errorMessage: "Storage upload failed",
                    finishedAt: vitest_1.expect.any(Date),
                },
            });
        });
    });
    (0, vitest_1.describe)("getBackendConfig", () => {
        (0, vitest_1.it)("returns kind and updatedAt without exposing config secrets", async () => {
            const updatedAt = new Date("2026-07-31T12:00:00.000Z");
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "alibaba",
                config: JSON.stringify({
                    clientSecret: "secret-value",
                    accessToken: "access-token",
                    refreshToken: "refresh-token",
                }),
                updatedAt,
            });
            const result = await service.getBackendConfig();
            (0, vitest_1.expect)(result).toEqual({
                kind: "alibaba",
                updatedAt: updatedAt.toISOString(),
            });
            (0, vitest_1.expect)(result).not.toHaveProperty("config");
            (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("secret-value");
            (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("access-token");
            (0, vitest_1.expect)(JSON.stringify(result)).not.toContain("refresh-token");
        });
        (0, vitest_1.it)("defaults to local when no database row exists", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue(null);
            (0, vitest_1.expect)(await service.getBackendConfig()).toEqual({
                kind: "local",
                updatedAt: null,
            });
        });
        (0, vitest_1.it)("normalizes an unknown persisted kind to the effective local fallback", async () => {
            prisma.storageBackendConfig.findFirst.mockResolvedValue({
                kind: "unsupported",
                config: "{}",
                updatedAt: null,
            });
            (0, vitest_1.expect)(await service.getBackendConfig()).toEqual({
                kind: "local",
                updatedAt: null,
            });
        });
    });
    (0, vitest_1.describe)("直传会话编排", () => {
        const directProvider = {
            createDirectUpload: vitest_1.vi.fn(),
            completeDirectUpload: vitest_1.vi.fn(),
            refreshPartUrls: vitest_1.vi.fn(),
            getExternalDownloadUrl: vitest_1.vi.fn(),
        };
        function mockDirectProvider() {
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(directProvider);
        }
        (0, vitest_1.it)("createDirectUploadSession 建会话并更新 File key 为阿里云 fileId", async () => {
            mockDirectProvider();
            directProvider.createDirectUpload.mockResolvedValue({
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 64,
                parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
            });
            prisma.file.update.mockResolvedValue({});
            const result = await service.createDirectUploadSession(100, "a.bin", "f1");
            (0, vitest_1.expect)(result).toMatchObject({ fileId: "aliyun-file", uploadId: "up-1" });
            (0, vitest_1.expect)(prisma.file.update).toHaveBeenCalledWith({
                where: { id: "f1" },
                data: { key: "aliyun-file" },
            });
        });
        (0, vitest_1.it)("completeDirectUploadSession 校验字节数、合并分片、置 completed", async () => {
            mockDirectProvider();
            prisma.file.findUniqueOrThrow.mockResolvedValue({
                id: "f1",
                size: 100,
                key: "aliyun-file",
            });
            directProvider.completeDirectUpload.mockResolvedValue(undefined);
            prisma.file.update.mockResolvedValue({});
            await service.createDirectUploadSession(100, "a.bin", "f1");
            await service.completeDirectUploadSession("f1", 100);
            (0, vitest_1.expect)(directProvider.completeDirectUpload).toHaveBeenCalledWith("aliyun-file", "up-1");
            (0, vitest_1.expect)(prisma.file.update).toHaveBeenCalledWith({
                where: { id: "f1" },
                data: vitest_1.expect.objectContaining({
                    status: "completed",
                    storageKind: "alibaba",
                    sha256: "",
                }),
            });
        });
        (0, vitest_1.it)("completeDirectUploadSession 字节数不符时报 SIZE_MISMATCH", async () => {
            mockDirectProvider();
            prisma.file.findUniqueOrThrow.mockResolvedValue({
                id: "f1",
                size: 100,
                key: "aliyun-file",
            });
            await service.createDirectUploadSession(100, "a.bin", "f1");
            await (0, vitest_1.expect)(service.completeDirectUploadSession("f1", 99)).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
        });
        (0, vitest_1.it)("createExportSession 从 job payload 取文件名并更新 File size", async () => {
            mockDirectProvider();
            prisma.job.findUnique.mockResolvedValue({
                id: "j1",
                type: "file.export",
                payload: JSON.stringify({ path: "D:\\a.zip" }),
            });
            prisma.file.findFirst.mockResolvedValue({ id: "f1", key: "k" });
            directProvider.createDirectUpload.mockResolvedValue({
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 64,
                parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
            });
            prisma.file.update.mockResolvedValue({});
            const result = await service.createExportSession("j1", 100);
            (0, vitest_1.expect)(directProvider.createDirectUpload).toHaveBeenCalledWith(100, "a.zip");
            (0, vitest_1.expect)(prisma.file.update).toHaveBeenCalledWith({
                where: { id: "f1" },
                data: vitest_1.expect.objectContaining({ size: 100, key: "aliyun-file" }),
            });
            (0, vitest_1.expect)(result.parts).toHaveLength(1);
        });
        (0, vitest_1.it)("completeExportUpload 校验字节数并返回真实 key", async () => {
            mockDirectProvider();
            prisma.job.findUnique.mockResolvedValue({
                id: "j1",
                type: "file.export",
                payload: JSON.stringify({ path: "D:\\a.zip" }),
            });
            prisma.file.findFirst.mockResolvedValue({ id: "f1", size: 100 });
            directProvider.completeDirectUpload.mockResolvedValue(undefined);
            prisma.file.update.mockResolvedValue({});
            await service.createExportSession("j1", 100);
            const result = await service.completeExportUpload("j1", 100);
            (0, vitest_1.expect)(result).toEqual({ key: "aliyun-file" });
            (0, vitest_1.expect)(prisma.file.update).toHaveBeenCalledWith({
                where: { id: "f1" },
                data: vitest_1.expect.objectContaining({ status: "completed" }),
            });
        });
        (0, vitest_1.it)("createDownloadToken 在直传 provider 上返回外部 URL", async () => {
            mockDirectProvider();
            directProvider.getExternalDownloadUrl.mockResolvedValue({
                url: "https://download.example/x",
                expiresAt: 1760000000000,
            });
            await (0, vitest_1.expect)(service.createDownloadToken("aliyun-file")).resolves.toEqual({
                url: "https://download.example/x",
                expiresAt: 1760000000000,
            });
        });
        (0, vitest_1.it)("local provider 上 createDownloadToken 保持签名 URL", async () => {
            const localProvider = {
                signDownloadUrl: vitest_1.vi.fn().mockReturnValue("expires=123&sig=s"),
            };
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(localProvider);
            await (0, vitest_1.expect)(service.createDownloadToken("k")).resolves.toEqual({
                url: "/api/storage/download/k?expires=123&sig=s",
                expiresAt: 123,
            });
        });
        (0, vitest_1.it)("updateUploadProgress 写入 job.progress（total 取 File.size）", async () => {
            prisma.job.findUnique.mockResolvedValue({
                id: "j1",
                payload: JSON.stringify({ fileId: "f1" }),
            });
            prisma.file.findUnique.mockResolvedValue({ size: 100 });
            prisma.job.update.mockResolvedValue({});
            await service.updateUploadProgress("j1", 50);
            (0, vitest_1.expect)(prisma.job.update).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                data: vitest_1.expect.objectContaining({
                    progress: JSON.stringify({ loaded: 50, total: 100 }),
                }),
            }));
        });
    });
    (0, vitest_1.describe)("直连下载能力（ADR-0016）", () => {
        (0, vitest_1.it)("无 getDirectDownloadUrl 方法的 provider 不支持直连", async () => {
            const localProvider = { signDownloadUrl: vitest_1.vi.fn(), signUploadUrl: vitest_1.vi.fn() };
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue(localProvider);
            (0, vitest_1.expect)(service.supportsDirectDownload()).toBe(false);
            await (0, vitest_1.expect)(service.getDirectDownloadUrl("k")).resolves.toBeNull();
        });
        (0, vitest_1.it)("带 getDirectDownloadUrl 的 provider 支持直连并委托换取", async () => {
            const direct = vitest_1.vi.fn().mockResolvedValue({
                url: "https://storage/x",
                expiresAt: Date.now() + 900_000,
            });
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue({
                getDirectDownloadUrl: direct,
            });
            (0, vitest_1.expect)(service.supportsDirectDownload()).toBe(true);
            await (0, vitest_1.expect)(service.getDirectDownloadUrl("k")).resolves.toEqual({
                url: "https://storage/x",
                expiresAt: vitest_1.expect.any(Number),
            });
            (0, vitest_1.expect)(direct).toHaveBeenCalledWith("k");
        });
        (0, vitest_1.it)("provider 返回空 URL 时按不支持处理", async () => {
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue({
                getDirectDownloadUrl: vitest_1.vi.fn().mockResolvedValue({ url: "", expiresAt: 0 }),
            });
            await (0, vitest_1.expect)(service.getDirectDownloadUrl("k")).resolves.toBeNull();
        });
        (0, vitest_1.it)("uploadStream 委托 provider.upload", async () => {
            const upload = vitest_1.vi.fn().mockResolvedValue({
                key: "file-1",
                storageKind: "alibaba",
            });
            vitest_1.vi.spyOn(service, "getProvider").mockReturnValue({ upload });
            const stream = node_stream_1.Readable.from(["zip-bytes"]);
            const meta = { clientId: "release", filename: "a.zip", size: 9 };
            await service.uploadStream(stream, meta);
            (0, vitest_1.expect)(upload).toHaveBeenCalledWith(stream, meta);
        });
    });
});
