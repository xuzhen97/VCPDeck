"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
const node_stream_1 = require("node:stream");
const node_fs_1 = require("node:fs");
// 统一 mock platform，让 normPath 在任意 OS 上都用 Windows 小写规则
vitest_1.vi.mock("node:os", () => ({
    platform: vitest_1.vi.fn(() => "win32"),
    homedir: vitest_1.vi.fn(() => "C:\\Users\\test"),
}));
const mockFsPromises = vitest_1.vi.hoisted(() => ({
    stat: vitest_1.vi.fn(),
    realpath: vitest_1.vi.fn(async (p) => p),
    unlink: vitest_1.vi.fn(),
    rename: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("node:fs/promises", () => ({
    ...mockFsPromises,
    default: mockFsPromises,
}));
vitest_1.vi.mock("node:fs", () => ({
    createReadStream: vitest_1.vi.fn(() => node_stream_1.Readable.from([Buffer.from("hello")])),
    createWriteStream: vitest_1.vi.fn(() => new node_stream_1.PassThrough()),
}));
const transfer_handler_js_1 = require("./transfer-handler.js");
function mockSocket() {
    const emit = vitest_1.vi.fn();
    return { emit };
}
function exportJob(uploadKey = "uuid/a.txt") {
    return {
        jobId: "job-1",
        type: "file.export",
        payload: {
            path: "a.txt",
            rootDir: "C:\\root",
            uploadRef: {
                id: "f1",
                key: uploadKey,
                url: `/api/storage/upload/${uploadKey}?expires=1&sig=abc`,
                method: "PUT",
                expiresAt: 1,
            },
        },
    };
}
function doneCalls(socket) {
    return vitest_1.vi
        .mocked(socket.emit)
        .mock.calls.filter(([event]) => event === shared_1.Events.JOB_DONE);
}
function progressCalls(socket) {
    return vitest_1.vi
        .mocked(socket.emit)
        .mock.calls.filter(([event]) => event === shared_1.Events.JOB_PROGRESS);
}
function errorCalls(socket) {
    return vitest_1.vi
        .mocked(socket.emit)
        .mock.calls.filter(([event]) => event === shared_1.Events.JOB_DONE);
}
function importJob(overwrite = false, direct = false) {
    return {
        jobId: "job-1",
        type: "file.import",
        payload: {
            rootDir: "C:\\root",
            targetPath: "a.txt",
            downloadRef: {
                id: "f1",
                key: "k",
                url: direct
                    ? "https://download.example/x"
                    : "/api/storage/download/k?expires=0&sig=abc",
                method: "GET",
                expiresAt: 0,
                direct,
            },
            size: 5,
            overwrite,
        },
    };
}
(0, vitest_1.describe)("handleTransfer file.export", () => {
    (0, vitest_1.beforeEach)(() => {
        // 每个用例恢复流 mock，避免上一个用例的分片读取实现污染整文件哈希。
        vitest_1.vi.mocked(node_fs_1.createReadStream).mockReset();
        vitest_1.vi.mocked(node_fs_1.createReadStream).mockImplementation(() => node_stream_1.Readable.from([Buffer.from("hello")]));
        // mock fetch 必须消费 body，否则上传流（webStream）不会流动，
        // sha256/进度逻辑都不会执行
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi
            .fn()
            .mockImplementation(async (_url, init) => {
            const body = init?.body;
            if (body) {
                const reader = body.getReader();
                while (true) {
                    const { done } = await reader.read();
                    if (done)
                        break;
                }
            }
            return {
                ok: true,
                json: async () => ({ key: "aliyun-fileid-123", size: 5 }),
            };
        }));
        mockFsPromises.stat.mockResolvedValue({ size: 5 });
        mockFsPromises.unlink.mockResolvedValue(undefined);
        mockFsPromises.rename.mockResolvedValue(undefined);
        vitest_1.vi.mocked(node_fs_1.createWriteStream).mockImplementation(() => new node_stream_1.PassThrough());
    });
    (0, vitest_1.it)("回传 Server 返回的真实存储 key（阿里云盘 fileId），而非上传签名 key", async () => {
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(exportJob(), socket);
        const [event, data] = doneCalls(socket)[0];
        (0, vitest_1.expect)(event).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(data.result).toMatchObject({
            fileId: "f1",
            key: "aliyun-fileid-123",
            size: 5,
        });
    });
    (0, vitest_1.it)("Server 未返回 key 时回退到 uploadRef.key（本地存储后端）", async () => {
        vitest_1.vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(exportJob(), socket);
        const [, data] = doneCalls(socket)[0];
        (0, vitest_1.expect)(data.result.key).toBe("uuid/a.txt");
    });
    (0, vitest_1.it)("流结束时补报精确的总进度", async () => {
        const MB = 1024 * 1024;
        const total = MB + 7;
        vitest_1.vi.mocked(node_fs_1.createReadStream).mockReturnValueOnce(node_stream_1.Readable.from([
            Buffer.alloc(MB, 1),
            Buffer.alloc(7, 2),
        ]));
        mockFsPromises.stat.mockResolvedValue({ size: total });
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(exportJob(), socket);
        const progress = progressCalls(socket);
        (0, vitest_1.expect)(progress.at(-1)?.[1]).toEqual({
            jobId: "job-1",
            loaded: total,
            total,
        });
    });
    (0, vitest_1.it)("上传流按节流上报 JOB_PROGRESS（每 1MB 增量）", async () => {
        const MB = 1024 * 1024;
        vitest_1.vi.mocked(node_fs_1.createReadStream).mockReturnValueOnce(node_stream_1.Readable.from([
            Buffer.alloc(MB, 1),
            Buffer.alloc(MB, 2),
            Buffer.alloc(MB, 3),
        ]));
        mockFsPromises.stat.mockResolvedValue({ size: 3 * MB });
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(exportJob(), socket);
        const progress = progressCalls(socket);
        (0, vitest_1.expect)(progress.length).toBeGreaterThan(0);
        const first = progress[0][1];
        (0, vitest_1.expect)(first.jobId).toBe("job-1");
        (0, vitest_1.expect)(first.loaded).toBe(MB);
        (0, vitest_1.expect)(first.total).toBe(3 * MB);
        // 1MB 阈值触发，节流内至少 2 次上报（第 1、2 MB）
        (0, vitest_1.expect)(progress.length).toBeGreaterThanOrEqual(2);
    });
    (0, vitest_1.it)("直传导出按服务端分片大小读取文件", async () => {
        const uploadedSizes = [];
        const fetcher = vitest_1.vi
            .fn()
            .mockImplementation(async (_url, init) => {
            if (init?.body instanceof ReadableStream) {
                const reader = init.body.getReader();
                let size = 0;
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done)
                        break;
                    size += chunk.value.byteLength;
                }
                uploadedSizes.push(size);
            }
            const call = fetcher.mock.calls.length;
            if (call === 1) {
                return {
                    ok: true,
                    json: async () => ({
                        fileId: "aliyun-file",
                        uploadId: "up-1",
                        partSize: 8,
                        parts: [
                            { partNumber: 1, url: "https://oss.example/p1" },
                            { partNumber: 2, url: "https://oss.example/p2" },
                        ],
                    }),
                };
            }
            return { ok: true, json: async () => ({ key: "aliyun-file" }) };
        });
        vitest_1.vi.stubGlobal("fetch", fetcher);
        mockFsPromises.stat.mockResolvedValue({ size: 13 });
        vitest_1.vi.mocked(node_fs_1.createReadStream).mockImplementation(((_path, options) => node_stream_1.Readable.from([
            Buffer.alloc((options?.end ?? 0) - (options?.start ?? 0) + 1),
        ])));
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)({
            ...exportJob(),
            payload: {
                ...exportJob().payload,
                uploadRef: {
                    ...exportJob().payload.uploadRef,
                    url: "",
                    direct: true,
                },
            },
        }, socket);
        (0, vitest_1.expect)(uploadedSizes).toEqual([8, 5]);
    });
    (0, vitest_1.it)("uploadRef.direct 时分片直传并完成导出会话", async () => {
        const fetcher = vitest_1.vi
            .fn()
            // 1) 协商导出直传会话
            .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 5,
                parts: [{ partNumber: 1, url: "https://oss.example/p1" }],
            }),
        })
            // 2) PUT 分片到 OSS
            .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
            // 3) 完成导出会话
            .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ key: "aliyun-file" }),
        });
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const socket = mockSocket();
        const job = exportJob();
        await (0, transfer_handler_js_1.handleTransfer)({
            ...job,
            payload: {
                ...job.payload,
                uploadRef: { ...job.payload.uploadRef, url: "", direct: true },
            },
        }, socket);
        (0, vitest_1.expect)(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:3001/api/files/client-export-sessions");
        (0, vitest_1.expect)(fetcher.mock.calls[0]?.[1]).toMatchObject({
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-vcpdeck-psk": "vcpdeck-dev-psk",
            },
        });
        (0, vitest_1.expect)(fetcher.mock.calls[1]?.[0]).toBe("https://oss.example/p1");
        (0, vitest_1.expect)(fetcher.mock.calls[1]?.[1]).toMatchObject({
            method: "PUT",
            duplex: "half",
        });
        (0, vitest_1.expect)(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
        (0, vitest_1.expect)(fetcher.mock.calls[2]?.[0]).toBe("http://localhost:3001/api/files/client-export-sessions/job-1/complete");
        (0, vitest_1.expect)(fetcher.mock.calls[2]?.[1]).toMatchObject({
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-vcpdeck-psk": "vcpdeck-dev-psk",
            },
        });
        (0, vitest_1.expect)(doneCalls(socket)[0]?.[1].result).toMatchObject({
            fileId: "f1",
            key: "aliyun-file",
            size: 5,
        });
    });
    (0, vitest_1.it)("导出分片 403 时用 Client PSK续期并只向新 URL重试", async () => {
        const fetcher = vitest_1.vi
            .fn()
            .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                fileId: "aliyun-file",
                uploadId: "up-1",
                partSize: 5,
                parts: [{ partNumber: 1, url: "https://oss.example/old" }],
            }),
        })
            .mockResolvedValueOnce({ ok: false, status: 403 })
            .mockResolvedValueOnce({
            ok: true,
            json: async () => [
                { partNumber: 1, url: "https://oss.example/new" },
            ],
        })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ key: "aliyun-file" }),
        });
        vitest_1.vi.stubGlobal("fetch", fetcher);
        const socket = mockSocket();
        const job = exportJob();
        await (0, transfer_handler_js_1.handleTransfer)({
            ...job,
            payload: {
                ...job.payload,
                uploadRef: { ...job.payload.uploadRef, url: "", direct: true },
            },
        }, socket);
        (0, vitest_1.expect)(fetcher.mock.calls.map(([url]) => url)).toEqual([
            "http://localhost:3001/api/files/client-export-sessions",
            "https://oss.example/old",
            "http://localhost:3001/api/files/client-export-sessions/job-1/part-urls",
            "https://oss.example/new",
            "http://localhost:3001/api/files/client-export-sessions/job-1/complete",
        ]);
        (0, vitest_1.expect)(fetcher.mock.calls[2]?.[1]).toMatchObject({
            method: "POST",
            headers: vitest_1.expect.objectContaining({
                "x-vcpdeck-psk": "vcpdeck-dev-psk",
            }),
        });
        (0, vitest_1.expect)(fetcher.mock.calls[1]?.[1]?.headers).toBeUndefined();
        (0, vitest_1.expect)(fetcher.mock.calls[3]?.[1]?.headers).toBeUndefined();
        (0, vitest_1.expect)(doneCalls(socket)[0]?.[1].result).toMatchObject({
            key: "aliyun-file",
            size: 5,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        });
    });
});
(0, vitest_1.describe)("handleTransfer file.import", () => {
    (0, vitest_1.beforeEach)(() => {
        mockFsPromises.stat.mockClear();
        mockFsPromises.unlink.mockClear();
        mockFsPromises.rename.mockClear();
        mockFsPromises.stat.mockResolvedValue(null);
        vitest_1.vi.mocked(fetch).mockResolvedValue({
            ok: true,
            body: node_stream_1.Readable.toWeb(node_stream_1.Readable.from([Buffer.from("hello")])),
        });
    });
    (0, vitest_1.it)("默认不覆盖已有文件并返回 PATH_CONFLICT", async () => {
        mockFsPromises.stat.mockResolvedValue({ isDirectory: () => false });
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(importJob(false), socket);
        (0, vitest_1.expect)(errorCalls(socket)[0]?.[1].error).toEqual({
            code: "PATH_CONFLICT",
            message: "Destination exists; set overwrite=true",
        });
        (0, vitest_1.expect)(mockFsPromises.rename).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("overwrite=true 时替换已有文件并返回实际大小", async () => {
        mockFsPromises.stat.mockResolvedValue({ isDirectory: () => false });
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(importJob(true), socket);
        (0, vitest_1.expect)(mockFsPromises.unlink).toHaveBeenCalledWith("c:/root/a.txt");
        (0, vitest_1.expect)(mockFsPromises.rename).toHaveBeenCalledWith(vitest_1.expect.stringContaining("a.txt.vcpdeck-tmp-"), "c:/root/a.txt");
        (0, vitest_1.expect)(doneCalls(socket)[0]?.[1].result).toMatchObject({
            key: "k",
            size: 5,
        });
    });
    (0, vitest_1.it)("实际字节数与声明 size 不符时报 IO_ERROR 并清理临时文件", async () => {
        const socket = mockSocket();
        const job = importJob(false);
        await (0, transfer_handler_js_1.handleTransfer)({ ...job, payload: { ...job.payload, size: 999 } }, socket);
        (0, vitest_1.expect)(errorCalls(socket)[0]?.[1].error.code).toBe("IO_ERROR");
        (0, vitest_1.expect)(mockFsPromises.rename).not.toHaveBeenCalled();
        (0, vitest_1.expect)(mockFsPromises.unlink).toHaveBeenCalledWith(vitest_1.expect.stringContaining("a.txt.vcpdeck-tmp-"));
    });
    (0, vitest_1.it)("downloadRef.direct 时直连外部 URL 且只校验 size", async () => {
        vitest_1.vi.mocked(fetch).mockClear();
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(importJob(false, true), socket);
        (0, vitest_1.expect)(vitest_1.vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://download.example/x");
        (0, vitest_1.expect)(doneCalls(socket)[0]?.[1].result).toMatchObject({
            key: "k",
            size: 5,
        });
    });
    (0, vitest_1.it)("拒绝非 Server 同源的绝对下载 URL", async () => {
        vitest_1.vi.mocked(fetch).mockClear();
        const socket = mockSocket();
        const job = importJob(false);
        await (0, transfer_handler_js_1.handleTransfer)({
            ...job,
            payload: {
                ...job.payload,
                downloadRef: {
                    ...job.payload.downloadRef,
                    url: "http://evil.example/steal",
                },
            },
        }, socket);
        (0, vitest_1.expect)(errorCalls(socket)[0]?.[1].error.code).toBe("IO_ERROR");
        (0, vitest_1.expect)(vitest_1.vi.mocked(fetch)).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("下载写入阶段补报精确进度", async () => {
        const socket = mockSocket();
        await (0, transfer_handler_js_1.handleTransfer)(importJob(false), socket);
        (0, vitest_1.expect)(progressCalls(socket).at(-1)?.[1]).toEqual({
            jobId: "job-1",
            loaded: 5,
            total: 5,
        });
    });
});
