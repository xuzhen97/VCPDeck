"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
const release_service_js_1 = require("./release.service.js");
function mockPrisma() {
    return {
        release: {
            findUnique: vitest_1.vi.fn(),
            findFirst: vitest_1.vi.fn(),
            findMany: vitest_1.vi.fn(),
            count: vitest_1.vi.fn(),
            create: vitest_1.vi.fn(),
            updateMany: vitest_1.vi.fn(),
            update: vitest_1.vi.fn(),
        },
    };
}
function dbRow(overrides = {}) {
    return {
        id: "rel_1",
        version: "1.2.1",
        archives: JSON.stringify({
            "win-x64": {
                sha256: "abc",
                size: 1024,
                fileName: "vcpdeck-1.2.1-win-x64.zip",
            },
        }),
        status: "uploaded",
        clientStates: "{}",
        errorMessage: null,
        createdByName: null,
        createdVia: null,
        createdAt: new Date("2026-06-15T00:00:00Z"),
        updatedAt: new Date("2026-06-15T00:00:00Z"),
        ...overrides,
    };
}
(0, vitest_1.describe)("ReleaseService", () => {
    let prisma;
    let service;
    (0, vitest_1.beforeEach)(() => {
        prisma = mockPrisma();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        service = new release_service_js_1.ReleaseService(prisma);
    });
    (0, vitest_1.describe)("create", () => {
        (0, vitest_1.it)("新版本创建成功，status 为 uploaded（含操作者与平台构件）", async () => {
            prisma.release.findUnique.mockResolvedValue(null);
            prisma.release.create.mockResolvedValue(dbRow());
            const info = await service.create({
                version: "1.2.1",
                archives: {
                    "win-x64": {
                        sha256: "abc",
                        fileName: "vcpdeck-1.2.1-win-x64.zip",
                        size: 1024,
                    },
                },
                createdByName: "Admin",
                createdVia: "web",
            });
            (0, vitest_1.expect)(info.status).toBe(shared_1.ReleaseStatus.UPLOADED);
            (0, vitest_1.expect)(info.clientStates).toEqual({});
            (0, vitest_1.expect)(info.archives["win-x64"]).toMatchObject({ sha256: "abc" });
            (0, vitest_1.expect)(prisma.release.create).toHaveBeenCalledWith({
                data: vitest_1.expect.objectContaining({
                    version: "1.2.1",
                    archives: vitest_1.expect.stringContaining('"win-x64"'),
                    status: "uploaded",
                    createdByName: "Admin",
                    createdVia: "web",
                }),
            });
        });
        (0, vitest_1.it)("版本重复抛出 RELEASE_DUPLICATE_VERSION", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            await (0, vitest_1.expect)(service.create({
                version: "1.2.1",
                archives: {},
            })).rejects.toMatchObject({ code: "RELEASE_DUPLICATE_VERSION" });
            (0, vitest_1.expect)(prisma.release.create).not.toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("addArchive", () => {
        (0, vitest_1.it)("补充新平台构件并返回合并结果", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            prisma.release.update.mockResolvedValue(dbRow({
                archives: JSON.stringify({
                    "win-x64": { sha256: "abc", size: 1024, fileName: "w.zip" },
                    "linux-x64": { sha256: "def", size: 2048, fileName: "l.zip" },
                }),
            }));
            const info = await service.addArchive("1.2.1", "linux-x64", {
                sha256: "def",
                size: 2048,
                fileName: "l.zip",
            });
            (0, vitest_1.expect)(info.archives["linux-x64"]).toMatchObject({ sha256: "def" });
            (0, vitest_1.expect)(prisma.release.update).toHaveBeenCalledWith({
                where: { version: "1.2.1" },
                data: { archives: vitest_1.expect.stringContaining('"linux-x64"') },
            });
        });
        (0, vitest_1.it)("同平台构件已存在抛出 RELEASE_ARCHIVE_EXISTS", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            await (0, vitest_1.expect)(service.addArchive("1.2.1", "win-x64", {
                sha256: "abc",
                size: 1024,
                fileName: "w.zip",
            })).rejects.toMatchObject({ code: "RELEASE_ARCHIVE_EXISTS" });
        });
        (0, vitest_1.it)("release 不存在抛出 RELEASE_NOT_FOUND", async () => {
            prisma.release.findUnique.mockResolvedValue(null);
            await (0, vitest_1.expect)(service.addArchive("9.9.9", "win-x64", {
                sha256: "abc",
                size: 1,
                fileName: "w.zip",
            })).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
        });
    });
    (0, vitest_1.describe)("hasAllArchives", () => {
        (0, vitest_1.it)("两个平台构件齐备返回 true", () => {
            const info = {
                version: "1.2.1",
                archives: {
                    "win-x64": { sha256: "a", size: 1, fileName: "w.zip" },
                    "linux-x64": { sha256: "b", size: 2, fileName: "l.zip" },
                },
            };
            (0, vitest_1.expect)(service.hasAllArchives(info)).toBe(true);
        });
        (0, vitest_1.it)("cleaned 平台不算可用构件", () => {
            const base = { sha256: "a", size: 1, fileName: "x.zip" };
            (0, vitest_1.expect)(service.hasAllArchives({
                archives: {
                    "win-x64": { ...base, availability: "available" },
                    "linux-x64": {
                        ...base,
                        availability: "cleaned",
                        cleanedAt: "2026-08-29T00:00:00.000Z",
                        cleanupReason: "retention_policy",
                    },
                },
            })).toBe(false);
        });
        (0, vitest_1.it)("缺平台返回 false", () => {
            (0, vitest_1.expect)(service.hasAllArchives({ archives: {} })).toBe(false);
        });
    });
    (0, vitest_1.describe)("archive cleanup CAS", () => {
        (0, vitest_1.it)("旧记录归一化为 available", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            const info = await service.findByVersion("1.2.1");
            (0, vitest_1.expect)(info?.archives["win-x64"]?.availability).toBe("available");
        });
        (0, vitest_1.it)("claim 只在原始 archive JSON 未变化时进入 deleting", async () => {
            const row = dbRow();
            prisma.release.findUnique
                .mockResolvedValueOnce(row)
                .mockResolvedValueOnce(row);
            prisma.release.updateMany.mockResolvedValue({ count: 1 });
            const claimed = await service.claimArchiveForCleanup("1.2.1", "win-x64");
            (0, vitest_1.expect)(claimed?.availability).toBe("deleting");
            (0, vitest_1.expect)(prisma.release.updateMany).toHaveBeenCalledWith({
                where: { version: "1.2.1", archives: row.archives },
                data: { archives: vitest_1.expect.stringContaining('"availability":"deleting"') },
            });
        });
        (0, vitest_1.it)("完成清理后保留审计摘要并移除存储 key", async () => {
            const row = dbRow({
                archives: JSON.stringify({
                    "win-x64": {
                        sha256: "abc",
                        size: 1024,
                        fileName: "w.zip",
                        availability: "deleting",
                        storage: { provider: "alibaba", key: "secret-key", mode: "direct" },
                    },
                }),
            });
            prisma.release.findUnique.mockResolvedValue(row);
            prisma.release.updateMany.mockResolvedValue({ count: 1 });
            await (0, vitest_1.expect)(service.finishArchiveCleanup("1.2.1", "win-x64", "2026-08-29T00:00:00.000Z")).resolves.toBe(true);
            const args = prisma.release.updateMany.mock.calls[0][0];
            (0, vitest_1.expect)(args.where).toEqual({ version: "1.2.1", archives: row.archives });
            (0, vitest_1.expect)(args.data.archives).not.toContain("secret-key");
            (0, vitest_1.expect)(args.data.archives).toContain('"availability":"cleaned"');
        });
    });
    (0, vitest_1.describe)("transitionStatus", () => {
        (0, vitest_1.it)("合法流转 uploaded → updating_server 成功", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow({ status: "uploaded" }));
            prisma.release.updateMany.mockResolvedValue({ count: 1 });
            await (0, vitest_1.expect)(service.transitionStatus("1.2.1", shared_1.ReleaseStatus.UPDATING_SERVER)).resolves.toBeUndefined();
            (0, vitest_1.expect)(prisma.release.updateMany).toHaveBeenCalledWith({
                where: { version: "1.2.1", status: "uploaded" },
                data: vitest_1.expect.objectContaining({ status: "updating_server" }),
            });
        });
        (0, vitest_1.it)("非法流转抛出 RELEASE_INVALID_TRANSITION", async () => {
            prisma.release.updateMany.mockResolvedValue({ count: 0 });
            prisma.release.findUnique.mockResolvedValue(dbRow({ status: "done" }));
            await (0, vitest_1.expect)(service.transitionStatus("1.2.1", shared_1.ReleaseStatus.UPDATING_CLIENTS)).rejects.toMatchObject({ code: "RELEASE_INVALID_TRANSITION" });
        });
        (0, vitest_1.it)("release 不存在抛出 RELEASE_NOT_FOUND", async () => {
            prisma.release.updateMany.mockResolvedValue({ count: 0 });
            prisma.release.findUnique.mockResolvedValue(null);
            await (0, vitest_1.expect)(service.transitionStatus("9.9.9", shared_1.ReleaseStatus.UPDATING_SERVER)).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
        });
    });
    (0, vitest_1.describe)("markClientState", () => {
        (0, vitest_1.it)("合并写入条目（state+at），兼容旧格式并保留其他客户端", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow({ clientStates: '{"client_a":"pending"}' }));
            prisma.release.update.mockResolvedValue(dbRow());
            const states = await service.markClientState("1.2.1", "client_b", shared_1.ReleaseClientState.UPDATING);
            (0, vitest_1.expect)(states.client_a).toMatchObject({ state: "pending" });
            (0, vitest_1.expect)(states.client_b).toMatchObject({
                state: "updating",
                at: vitest_1.expect.any(String),
            });
            const written = prisma.release.update.mock.calls[0][0].data.clientStates;
            let parsed;
            try {
                parsed = JSON.parse(written);
            }
            catch (e) {
                throw new Error(`clientStates 写入值非法 JSON: ${e instanceof Error ? e.message : String(e)}`);
            }
            (0, vitest_1.expect)(parsed.client_a).toMatchObject({ state: "pending" });
            (0, vitest_1.expect)(parsed.client_b).toMatchObject({
                state: "updating",
                at: vitest_1.expect.any(String),
            });
        });
        (0, vitest_1.it)("failed 状态带失败原因与时间落库", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            prisma.release.update.mockResolvedValue(dbRow());
            const states = await service.markClientState("1.2.1", "c1", shared_1.ReleaseClientState.FAILED, "校验失败");
            (0, vitest_1.expect)(states.c1).toMatchObject({
                state: "failed",
                reason: "校验失败",
                at: vitest_1.expect.any(String),
            });
        });
    });
    (0, vitest_1.describe)("list", () => {
        (0, vitest_1.it)("分页返回 data/total/totalPages", async () => {
            prisma.release.findMany.mockResolvedValue([dbRow()]);
            prisma.release.count.mockResolvedValue(1);
            const result = await service.list(1, 20);
            (0, vitest_1.expect)(result).toMatchObject({
                total: 1,
                page: 1,
                pageSize: 20,
                totalPages: 1,
            });
            (0, vitest_1.expect)(result.data[0].version).toBe("1.2.1");
        });
    });
    (0, vitest_1.describe)("getActiveRelease", () => {
        (0, vitest_1.it)("返回 updating_server/updating_clients 状态的 release", async () => {
            prisma.release.findFirst.mockResolvedValue(dbRow({ status: "updating_server" }));
            const active = await service.getActiveRelease();
            (0, vitest_1.expect)(active?.status).toBe(shared_1.ReleaseStatus.UPDATING_SERVER);
            (0, vitest_1.expect)(prisma.release.findFirst).toHaveBeenCalledWith({
                where: { status: { in: ["updating_server", "updating_clients"] } },
                orderBy: { createdAt: "desc" },
            });
        });
        (0, vitest_1.it)("无活动 release 时返回 null", async () => {
            prisma.release.findFirst.mockResolvedValue(null);
            await (0, vitest_1.expect)(service.getActiveRelease()).resolves.toBeNull();
        });
    });
    (0, vitest_1.describe)("getLatestActiveTarget", () => {
        (0, vitest_1.it)("返回最近一条具有双平台可用构件的 release", async () => {
            prisma.release.findMany.mockResolvedValue([
                dbRow({
                    status: "updating_clients",
                    archives: JSON.stringify({
                        "win-x64": {
                            sha256: "abc",
                            size: 1024,
                            fileName: "w.zip",
                        },
                        "linux-x64": {
                            sha256: "def",
                            size: 2048,
                            fileName: "l.zip",
                        },
                    }),
                }),
            ]);
            const target = await service.getLatestActiveTarget();
            (0, vitest_1.expect)(target?.status).toBe(shared_1.ReleaseStatus.UPDATING_CLIENTS);
            (0, vitest_1.expect)(prisma.release.findMany).toHaveBeenCalledWith({
                where: { status: { in: ["updating_clients", "done"] } },
                orderBy: { createdAt: "desc" },
            });
        });
        (0, vitest_1.it)("最新 done 构件已清理时回退到最近的可用目标", async () => {
            prisma.release.findMany.mockResolvedValue([
                dbRow({
                    version: "1.2.2",
                    status: "done",
                    archives: JSON.stringify({
                        "win-x64": {
                            sha256: "a",
                            size: 1,
                            fileName: "w.zip",
                            availability: "cleaned",
                            cleanedAt: "2026-08-29T00:00:00.000Z",
                            cleanupReason: "retention_policy",
                        },
                        "linux-x64": {
                            sha256: "b",
                            size: 1,
                            fileName: "l.zip",
                            availability: "cleaned",
                            cleanedAt: "2026-08-29T00:00:00.000Z",
                            cleanupReason: "retention_policy",
                        },
                    }),
                }),
                dbRow({
                    version: "1.2.1",
                    status: "done",
                    archives: JSON.stringify({
                        "win-x64": {
                            sha256: "abc",
                            size: 1024,
                            fileName: "w.zip",
                        },
                        "linux-x64": {
                            sha256: "def",
                            size: 2048,
                            fileName: "l.zip",
                        },
                    }),
                }),
            ]);
            const target = await service.getLatestActiveTarget();
            (0, vitest_1.expect)(target?.version).toBe("1.2.1");
            (0, vitest_1.expect)(prisma.release.findMany).toHaveBeenCalledWith({
                where: { status: { in: ["updating_clients", "done"] } },
                orderBy: { createdAt: "desc" },
            });
        });
        (0, vitest_1.it)("无活动 release 时返回 null", async () => {
            prisma.release.findMany.mockResolvedValue([]);
            await (0, vitest_1.expect)(service.getLatestActiveTarget()).resolves.toBeNull();
        });
    });
    (0, vitest_1.describe)("verifyZipSha256", () => {
        let dir;
        (0, vitest_1.beforeEach)(async () => {
            dir = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "release-test-"));
        });
        (0, vitest_1.afterEach)(async () => {
            await (0, promises_1.rm)(dir, { recursive: true, force: true });
        });
        (0, vitest_1.it)("文件哈希与期望值匹配返回 true", async () => {
            const file = (0, node_path_1.join)(dir, "a.zip");
            const content = Buffer.from("hello release");
            await (0, promises_1.writeFile)(file, content);
            const expected = (0, node_crypto_1.createHash)("sha256").update(content).digest("hex");
            await (0, vitest_1.expect)(service.verifyZipSha256(file, expected)).resolves.toBe(true);
        });
        (0, vitest_1.it)("哈希不匹配返回 false", async () => {
            const file = (0, node_path_1.join)(dir, "a.zip");
            await (0, promises_1.writeFile)(file, "hello release");
            await (0, vitest_1.expect)(service.verifyZipSha256(file, "deadbeef")).resolves.toBe(false);
        });
        (0, vitest_1.it)("文件不存在返回 false", async () => {
            await (0, vitest_1.expect)(service.verifyZipSha256((0, node_path_1.join)(dir, "missing.zip"), "deadbeef")).resolves.toBe(false);
        });
    });
    (0, vitest_1.describe)("toReleaseInfo 存储信息透传（ADR-0016）", () => {
        (0, vitest_1.it)("公开 Release 隐藏 Provider key，内部读取仍保留 key", async () => {
            const row = dbRow({
                archives: JSON.stringify({
                    "win-x64": {
                        sha256: "abc",
                        size: 1024,
                        fileName: "vcpdeck-1.2.1-win-x64.zip",
                        storage: { provider: "alibaba", key: "file-1", mode: "direct" },
                    },
                }),
            });
            prisma.release.findUnique.mockResolvedValue(row);
            const info = await service.findByVersion("1.2.1");
            const archive = info?.archives["win-x64"];
            (0, vitest_1.expect)(archive && "storage" in archive ? archive.storage : undefined).toEqual({
                provider: "alibaba",
                mode: "direct",
            });
            (0, vitest_1.expect)(JSON.stringify(info)).not.toContain("file-1");
            prisma.release.findUnique.mockResolvedValue(row);
            const internal = await service.findByVersionWithStorage("1.2.1");
            const internalArchive = internal?.archives["win-x64"];
            (0, vitest_1.expect)(internalArchive && "storage" in internalArchive ? internalArchive.storage : undefined).toEqual({
                provider: "alibaba",
                key: "file-1",
                mode: "direct",
            });
        });
        (0, vitest_1.it)("storage 字段不完整时 fail closed，不把 archive 猜成 Local", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow({
                archives: JSON.stringify({
                    "win-x64": {
                        sha256: "abc",
                        size: 1024,
                        fileName: "vcpdeck-1.2.1-win-x64.zip",
                        storage: { provider: "alibaba", key: "file-1", mode: "proxy" },
                    },
                }),
            }));
            const info = await service.findByVersion("1.2.1");
            (0, vitest_1.expect)(info?.archives["win-x64"]).toBeUndefined();
        });
        (0, vitest_1.it)("非法 cleanedAt 或 storageSummary 时不暴露清理状态", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow({
                archives: JSON.stringify({
                    "win-x64": {
                        sha256: "abc",
                        size: 1024,
                        fileName: "w.zip",
                        availability: "cleaned",
                        cleanedAt: "not-a-date",
                        cleanupReason: "retention_policy",
                    },
                    "linux-x64": {
                        sha256: "def",
                        size: 1024,
                        fileName: "l.zip",
                        availability: "cleaned",
                        cleanedAt: "2026-08-29T00:00:00.000Z",
                        cleanupReason: "retention_policy",
                        storageSummary: { provider: "alibaba", mode: "proxy" },
                    },
                }),
            }));
            const info = await service.findByVersion("1.2.1");
            (0, vitest_1.expect)(info?.archives).toEqual({});
        });
        (0, vitest_1.it)("无 storage 字段的旧记录不受影响", async () => {
            prisma.release.findUnique.mockResolvedValue(dbRow());
            const info = await service.findByVersion("1.2.1");
            const archive = info?.archives["win-x64"];
            (0, vitest_1.expect)(archive && "storage" in archive ? archive.storage : undefined).toBeUndefined();
            (0, vitest_1.expect)(archive?.fileName).toBe("vcpdeck-1.2.1-win-x64.zip");
        });
    });
});
