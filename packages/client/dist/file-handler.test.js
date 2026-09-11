"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const shared_1 = require("@vcpdeck/shared");
// 统一 mock platform，让 normPath 在任意 OS 上都用 Windows 小写规则
vitest_1.vi.mock("node:os", () => ({
    platform: vitest_1.vi.fn(() => "win32"),
    homedir: vitest_1.vi.fn(() => "C:\\Users\\test"),
}));
// 只 mock 需要控制的 fs/promises 函数（vi.mock 会被提升，用 vi.hoisted）
const mockFsFns = vitest_1.vi.hoisted(() => ({
    readdir: vitest_1.vi.fn(),
    stat: vitest_1.vi.fn(),
    readFile: vitest_1.vi.fn(),
    writeFile: vitest_1.vi.fn(),
    mkdir: vitest_1.vi.fn(),
    rm: vitest_1.vi.fn(),
    rename: vitest_1.vi.fn(),
    realpath: vitest_1.vi.fn(),
    access: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("node:fs/promises", () => ({ ...mockFsFns, default: mockFsFns }));
const promises_1 = __importDefault(require("node:fs/promises"));
const file_handler_js_1 = require("./file-handler.js");
function dirent(name, isDir) {
    return { name, isDirectory: () => isDir, isFile: () => !isDir };
}
function stats(size, isDir, mtime = new Date("2026-01-01T00:00:00Z")) {
    return {
        size,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        mtime,
    };
}
function mockSocket() {
    const emit = vitest_1.vi.fn();
    return { emit };
}
// realpath 的 Node 类型签名包含 Buffer，统一用字符串 mock
function mockRealpathIdentity() {
    vitest_1.vi.mocked(promises_1.default.realpath).mockImplementation((p) => Promise.resolve(p));
}
// ──────────────────────────────────────────────
// resolveSafePath
// ──────────────────────────────────────────────
(0, vitest_1.describe)("resolveSafePath", () => {
    (0, vitest_1.beforeEach)(() => vitest_1.vi.clearAllMocks());
    (0, vitest_1.it)("保留根路径自身", async () => {
        mockRealpathIdentity();
        const result = await (0, file_handler_js_1.resolveSafePath)("C:\\", ".");
        (0, vitest_1.expect)(result).toBe("c:/");
    });
    (0, vitest_1.it)("允许根路径内的子目录", async () => {
        mockRealpathIdentity();
        const result = await (0, file_handler_js_1.resolveSafePath)("C:\\", "Users");
        (0, vitest_1.expect)(result).toContain("c:");
        (0, vitest_1.expect)(result).toContain("users");
    });
    (0, vitest_1.it)("拒绝逃逸根路径的上溯", async () => {
        mockRealpathIdentity();
        await (0, vitest_1.expect)((0, file_handler_js_1.resolveSafePath)("C:\\Users\\test", "../../../Windows")).rejects.toMatchObject({ code: shared_1.FileErrorCode.PATH_NOT_ALLOWED });
    });
    (0, vitest_1.it)("realpath 抛出异常时不阻止路径返回", async () => {
        vitest_1.vi.mocked(promises_1.default.realpath).mockRejectedValue(new Error("ENOENT"));
        const result = await (0, file_handler_js_1.resolveSafePath)("D:\\", "work");
        (0, vitest_1.expect)(result).toContain("d:");
        (0, vitest_1.expect)(result).toContain("work");
    });
});
// ──────────────────────────────────────────────
// handleFileOp — file.list
// ──────────────────────────────────────────────
(0, vitest_1.describe)("handleFileOp — file.list", () => {
    (0, vitest_1.beforeEach)(() => vitest_1.vi.clearAllMocks());
    (0, vitest_1.it)("全部 stat 成功时返回所有条目", async () => {
        mockRealpathIdentity();
        vitest_1.vi.mocked(promises_1.default.readdir).mockResolvedValue([
            dirent("readme.txt", false),
            dirent("work", true),
        ]);
        vitest_1.vi.mocked(promises_1.default.stat)
            .mockResolvedValueOnce(stats(100, false))
            .mockResolvedValueOnce(stats(0, true));
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "j1",
            type: "file.list",
            payload: { rootDir: "D:\\", path: "." },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "j1",
            type: "file.list",
            result: {
                entries: [
                    { name: "readme.txt", kind: "file", size: 100 },
                    { name: "work", kind: "dir", size: 0 },
                ],
            },
        });
    });
    (0, vitest_1.it)("部分 stat 失败时跳过不可访问条目", async () => {
        mockRealpathIdentity();
        vitest_1.vi.mocked(promises_1.default.readdir).mockResolvedValue([
            dirent("pagefile.sys", false),
            dirent("Users", true),
        ]);
        vitest_1.vi.mocked(promises_1.default.stat)
            // pagefile.sys → EACCES
            .mockRejectedValueOnce(Object.assign(new Error("Access is denied"), { code: "EACCES" }))
            // Users → OK
            .mockResolvedValueOnce(stats(0, true));
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "j2",
            type: "file.list",
            payload: { rootDir: "C:\\", path: "." },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "j2",
            result: {
                entries: [{ name: "Users", kind: "dir" }],
            },
        });
        // pagefile.sys 被跳过
        (0, vitest_1.expect)(call[1].result.entries).toHaveLength(1);
    });
    (0, vitest_1.it)("全部 stat 失败时返回空数组", async () => {
        mockRealpathIdentity();
        vitest_1.vi.mocked(promises_1.default.readdir).mockResolvedValue([
            dirent("pagefile.sys", false),
            dirent("swapfile.sys", false),
        ]);
        vitest_1.vi.mocked(promises_1.default.stat)
            .mockRejectedValueOnce(Object.assign(new Error("Access is denied"), { code: "EACCES" }))
            .mockRejectedValueOnce(Object.assign(new Error("Access is denied"), { code: "EACCES" }));
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "j3",
            type: "file.list",
            payload: { rootDir: "C:\\", path: "." },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1].result.entries).toEqual([]);
    });
    (0, vitest_1.it)("路径逃逸时发出 PATH_NOT_ALLOWED 错误", async () => {
        mockRealpathIdentity();
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "j4",
            type: "file.list",
            payload: { rootDir: "C:\\safe", path: "../../etc" },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "j4",
            type: "file.list",
            error: { code: shared_1.FileErrorCode.PATH_NOT_ALLOWED },
        });
    });
});
// ──────────────────────────────────────────────
// handleFileOp — other types (smoke)
// ──────────────────────────────────────────────
(0, vitest_1.describe)("handleFileOp — 其他类型", () => {
    (0, vitest_1.beforeEach)(() => vitest_1.vi.clearAllMocks());
    (0, vitest_1.it)("file.stat 返回正确元数据", async () => {
        mockRealpathIdentity();
        vitest_1.vi.mocked(promises_1.default.stat).mockResolvedValue(stats(2048, false));
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "js1",
            type: "file.stat",
            payload: { rootDir: "D:\\", path: "readme.txt" },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "js1",
            type: "file.stat",
            result: { name: "readme.txt", kind: "file", size: 2048 },
        });
    });
    (0, vitest_1.it)("file.readText 超出 maxBytes 时发出 SIZE_EXCEEDED", async () => {
        mockRealpathIdentity();
        vitest_1.vi.mocked(promises_1.default.stat).mockResolvedValue(stats(300_000, false));
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "jr1",
            type: "file.readText",
            payload: { rootDir: "C:\\", path: "bigfile.bin", maxBytes: 1000 },
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "jr1",
            type: "file.readText",
            error: { code: shared_1.FileErrorCode.SIZE_EXCEEDED },
        });
    });
    (0, vitest_1.it)("未知 type 发出 IO_ERROR", async () => {
        mockRealpathIdentity();
        const socket = mockSocket();
        await (0, file_handler_js_1.handleFileOp)({
            jobId: "jx1",
            type: "file.bogus",
            payload: {},
        }, socket);
        const call = vitest_1.vi.mocked(socket.emit).mock.calls[0];
        (0, vitest_1.expect)(call[0]).toBe(shared_1.Events.JOB_DONE);
        (0, vitest_1.expect)(call[1]).toMatchObject({
            jobId: "jx1",
            error: { code: shared_1.FileErrorCode.IO_ERROR },
        });
    });
});
