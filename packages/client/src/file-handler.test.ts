import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Socket } from "socket.io-client";
import { Events, FileErrorCode } from "@vcpdeck/shared";

// 统一 mock platform，让 normPath 在任意 OS 上都用 Windows 小写规则
vi.mock("node:os", () => ({
	platform: vi.fn(() => "win32"),
	homedir: vi.fn(() => "C:\\Users\\test"),
}));

// 只 mock 需要控制的 fs/promises 函数（vi.mock 会被提升，用 vi.hoisted）
const mockFsFns = vi.hoisted(() => ({
	readdir: vi.fn(),
	stat: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rm: vi.fn(),
	rename: vi.fn(),
	realpath: vi.fn(),
	access: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ ...mockFsFns, default: mockFsFns }));

import fs from "node:fs/promises";
import { resolveSafePath, handleFileOp } from "./file-handler.js";

function dirent(name: string, isDir: boolean) {
	return { name, isDirectory: () => isDir, isFile: () => !isDir } as any;
}

function stats(
	size: number,
	isDir: boolean,
	mtime = new Date("2026-01-01T00:00:00Z"),
) {
	return {
		size,
		isDirectory: () => isDir,
		isFile: () => !isDir,
		mtime,
	} as any;
}

function mockSocket() {
	const emit = vi.fn();
	return { emit } as unknown as Socket;
}

// realpath 的 Node 类型签名包含 Buffer，统一用字符串 mock
function mockRealpathIdentity() {
	vi.mocked(fs.realpath).mockImplementation((p: unknown) =>
		Promise.resolve(p as string),
	);
}

// ──────────────────────────────────────────────
// resolveSafePath
// ──────────────────────────────────────────────
describe("resolveSafePath", () => {
	beforeEach(() => vi.clearAllMocks());

	it("保留根路径自身", async () => {
		mockRealpathIdentity();
		const result = await resolveSafePath("C:\\", ".");
		expect(result).toBe("c:/");
	});

	it("允许根路径内的子目录", async () => {
		mockRealpathIdentity();
		const result = await resolveSafePath("C:\\", "Users");
		expect(result).toContain("c:");
		expect(result).toContain("users");
	});

	it("拒绝逃逸根路径的上溯", async () => {
		mockRealpathIdentity();
		await expect(
			resolveSafePath("C:\\Users\\test", "../../../Windows"),
		).rejects.toMatchObject({ code: FileErrorCode.PATH_NOT_ALLOWED });
	});

	it("realpath 抛出异常时不阻止路径返回", async () => {
		vi.mocked(fs.realpath).mockRejectedValue(new Error("ENOENT"));
		const result = await resolveSafePath("D:\\", "work");
		expect(result).toContain("d:");
		expect(result).toContain("work");
	});
});

// ──────────────────────────────────────────────
// handleFileOp — file.list
// ──────────────────────────────────────────────
describe("handleFileOp — file.list", () => {
	beforeEach(() => vi.clearAllMocks());

	it("全部 stat 成功时返回所有条目", async () => {
		mockRealpathIdentity();
		vi.mocked(fs.readdir).mockResolvedValue([
			dirent("readme.txt", false),
			dirent("work", true),
		] as any);
		vi.mocked(fs.stat)
			.mockResolvedValueOnce(stats(100, false))
			.mockResolvedValueOnce(stats(0, true));

		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "j1",
				type: "file.list",
				payload: { rootDir: "D:\\", path: "." },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
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

	it("部分 stat 失败时跳过不可访问条目", async () => {
		mockRealpathIdentity();
		vi.mocked(fs.readdir).mockResolvedValue([
			dirent("pagefile.sys", false),
			dirent("Users", true),
		] as any);
		vi.mocked(fs.stat)
			// pagefile.sys → EACCES
			.mockRejectedValueOnce(
				Object.assign(new Error("Access is denied"), { code: "EACCES" }),
			)
			// Users → OK
			.mockResolvedValueOnce(stats(0, true));

		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "j2",
				type: "file.list",
				payload: { rootDir: "C:\\", path: "." },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
			jobId: "j2",
			result: {
				entries: [{ name: "Users", kind: "dir" }],
			},
		});
		// pagefile.sys 被跳过
		expect((call[1] as any).result.entries).toHaveLength(1);
	});

	it("全部 stat 失败时返回空数组", async () => {
		mockRealpathIdentity();
		vi.mocked(fs.readdir).mockResolvedValue([
			dirent("pagefile.sys", false),
			dirent("swapfile.sys", false),
		] as any);
		vi.mocked(fs.stat)
			.mockRejectedValueOnce(
				Object.assign(new Error("Access is denied"), { code: "EACCES" }),
			)
			.mockRejectedValueOnce(
				Object.assign(new Error("Access is denied"), { code: "EACCES" }),
			);

		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "j3",
				type: "file.list",
				payload: { rootDir: "C:\\", path: "." },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect((call[1] as any).result.entries).toEqual([]);
	});

	it("路径逃逸时发出 PATH_NOT_ALLOWED 错误", async () => {
		mockRealpathIdentity();
		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "j4",
				type: "file.list",
				payload: { rootDir: "C:\\safe", path: "../../etc" },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
			jobId: "j4",
			type: "file.list",
			error: { code: FileErrorCode.PATH_NOT_ALLOWED },
		});
	});
});

// ──────────────────────────────────────────────
// handleFileOp — other types (smoke)
// ──────────────────────────────────────────────
describe("handleFileOp — 其他类型", () => {
	beforeEach(() => vi.clearAllMocks());

	it("file.stat 返回正确元数据", async () => {
		mockRealpathIdentity();
		vi.mocked(fs.stat).mockResolvedValue(stats(2048, false));

		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "js1",
				type: "file.stat",
				payload: { rootDir: "D:\\", path: "readme.txt" },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
			jobId: "js1",
			type: "file.stat",
			result: { name: "readme.txt", kind: "file", size: 2048 },
		});
	});

	it("file.readText 超出 maxBytes 时发出 SIZE_EXCEEDED", async () => {
		mockRealpathIdentity();
		vi.mocked(fs.stat).mockResolvedValue(stats(300_000, false));

		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "jr1",
				type: "file.readText",
				payload: { rootDir: "C:\\", path: "bigfile.bin", maxBytes: 1000 },
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
			jobId: "jr1",
			type: "file.readText",
			error: { code: FileErrorCode.SIZE_EXCEEDED },
		});
	});

	it("未知 type 发出 IO_ERROR", async () => {
		mockRealpathIdentity();
		const socket = mockSocket();
		await handleFileOp(
			{
				jobId: "jx1",
				type: "file.bogus" as any,
				payload: {},
			},
			socket,
		);

		const call = vi.mocked(socket.emit).mock.calls[0];
		expect(call[0]).toBe(Events.JOB_DONE);
		expect(call[1]).toMatchObject({
			jobId: "jx1",
			error: { code: FileErrorCode.IO_ERROR },
		});
	});
});
