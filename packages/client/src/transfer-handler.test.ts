import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import { PassThrough, Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";

// 统一 mock platform，让 normPath 在任意 OS 上都用 Windows 小写规则
vi.mock("node:os", () => ({
	platform: vi.fn(() => "win32"),
	homedir: vi.fn(() => "C:\\Users\\test"),
}));

const mockFsPromises = vi.hoisted(() => ({
	stat: vi.fn(),
	realpath: vi.fn(async (p: string) => p),
	unlink: vi.fn(),
	rename: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
	...mockFsPromises,
	default: mockFsPromises,
}));

vi.mock("node:fs", () => ({
	createReadStream: vi.fn(() => Readable.from([Buffer.from("hello")])),
	createWriteStream: vi.fn(() => new PassThrough()),
}));

import { handleTransfer } from "./transfer-handler.js";

function mockSocket() {
	const emit = vi.fn();
	return { emit } as unknown as Socket;
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
				method: "PUT" as const,
				expiresAt: 1,
			},
		},
	};
}

function doneCalls(socket: Socket) {
	return vi
		.mocked(socket.emit)
		.mock.calls.filter(([event]) => event === Events.JOB_DONE) as Array<
		[string, { result: Record<string, unknown> }]
	>;
}

function progressCalls(socket: Socket) {
	return vi
		.mocked(socket.emit)
		.mock.calls.filter(([event]) => event === Events.JOB_PROGRESS) as Array<
		[string, { jobId: string; loaded: number; total: number }]
	>;
}

function errorCalls(socket: Socket) {
	return vi
		.mocked(socket.emit)
		.mock.calls.filter(([event]) => event === Events.JOB_DONE) as Array<
		[string, { error: { code: string; message: string } }]
	>;
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
				method: "GET" as const,
				expiresAt: 0,
				direct,
			},
			size: 5,
			overwrite,
		},
	};
}

describe("handleTransfer file.export", () => {
	beforeEach(() => {
		// mock fetch 必须消费 body，否则上传流（webStream）不会流动，
		// sha256/进度逻辑都不会执行
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementation(
					async (_url: unknown, init?: { body?: unknown }) => {
						const body = init?.body as ReadableStream<Uint8Array> | undefined;
						if (body) {
							const reader = body.getReader();
							while (true) {
								const { done } = await reader.read();
								if (done) break;
							}
						}
						return {
							ok: true,
							json: async () => ({ key: "aliyun-fileid-123", size: 5 }),
						};
					},
				),
		);
		mockFsPromises.stat.mockResolvedValue({ size: 5 });
		mockFsPromises.unlink.mockResolvedValue(undefined);
		mockFsPromises.rename.mockResolvedValue(undefined);
		vi.mocked(createWriteStream).mockImplementation(
			() => new PassThrough() as never,
		);
	});

	it("回传 Server 返回的真实存储 key（阿里云盘 fileId），而非上传签名 key", async () => {
		const socket = mockSocket();
		await handleTransfer(exportJob(), socket);

		const [event, data] = doneCalls(socket)[0]!;
		expect(event).toBe(Events.JOB_DONE);
		expect(data.result).toMatchObject({
			fileId: "f1",
			key: "aliyun-fileid-123",
			size: 5,
		});
	});

	it("Server 未返回 key 时回退到 uploadRef.key（本地存储后端）", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({}),
		} as never);
		const socket = mockSocket();
		await handleTransfer(exportJob(), socket);

		const [, data] = doneCalls(socket)[0]!;
		expect(data.result.key).toBe("uuid/a.txt");
	});

	it("流结束时补报精确的总进度", async () => {
		const MB = 1024 * 1024;
		const total = MB + 7;
		vi.mocked(createReadStream).mockReturnValueOnce(
			Readable.from([
				Buffer.alloc(MB, 1),
				Buffer.alloc(7, 2),
			]) as unknown as import("node:fs").ReadStream,
		);
		mockFsPromises.stat.mockResolvedValue({ size: total });
		const socket = mockSocket();

		await handleTransfer(exportJob(), socket);

		const progress = progressCalls(socket);
		expect(progress.at(-1)?.[1]).toEqual({
			jobId: "job-1",
			loaded: total,
			total,
		});
	});

	it("上传流按节流上报 JOB_PROGRESS（每 1MB 增量）", async () => {
		const MB = 1024 * 1024;
		vi.mocked(createReadStream).mockReturnValueOnce(
			Readable.from([
				Buffer.alloc(MB, 1),
				Buffer.alloc(MB, 2),
				Buffer.alloc(MB, 3),
			]) as unknown as import("node:fs").ReadStream,
		);
		mockFsPromises.stat.mockResolvedValue({ size: 3 * MB });
		const socket = mockSocket();

		await handleTransfer(exportJob(), socket);

		const progress = progressCalls(socket);
		expect(progress.length).toBeGreaterThan(0);
		const first = progress[0]![1];
		expect(first.jobId).toBe("job-1");
		expect(first.loaded).toBe(MB);
		expect(first.total).toBe(3 * MB);
		// 1MB 阈值触发，节流内至少 2 次上报（第 1、2 MB）
		expect(progress.length).toBeGreaterThanOrEqual(2);
	});

	it("直传导出按服务端分片大小读取文件", async () => {
		const uploadedSizes: number[] = [];
		const fetcher = vi
			.fn()
			.mockImplementation(async (_url: unknown, init?: { body?: BodyInit }) => {
				if (init?.body instanceof ReadableStream) {
					const reader = init.body.getReader();
					let size = 0;
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
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
		vi.stubGlobal("fetch", fetcher);
		mockFsPromises.stat.mockResolvedValue({ size: 13 });
		vi.mocked(createReadStream).mockImplementation(
			((_path: unknown, options?: { start?: number; end?: number }) =>
				Readable.from([
					Buffer.alloc((options?.end ?? 0) - (options?.start ?? 0) + 1),
				]) as never) as never,
		);
		const socket = mockSocket();

		await handleTransfer(
			{
				...exportJob(),
				payload: {
					...exportJob().payload,
					uploadRef: {
						...exportJob().payload.uploadRef,
						url: "",
						direct: true,
					},
				},
			},
			socket,
		);

		expect(uploadedSizes).toEqual([8, 5]);
	});

	it("uploadRef.direct 时分片直传并完成导出会话", async () => {
		const fetcher = vi
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
		vi.stubGlobal("fetch", fetcher);
		const socket = mockSocket();
		const job = exportJob();
		await handleTransfer(
			{
				...job,
				payload: {
					...job.payload,
					uploadRef: { ...job.payload.uploadRef, url: "", direct: true },
				},
			},
			socket,
		);

		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"http://localhost:3001/api/files/export-sessions",
		);
		expect(fetcher.mock.calls[1]?.[0]).toBe("https://oss.example/p1");
		expect(fetcher.mock.calls[2]?.[0]).toBe(
			"http://localhost:3001/api/files/export-sessions/job-1/complete",
		);
		expect(doneCalls(socket)[0]?.[1].result).toMatchObject({
			key: "aliyun-file",
			size: 5,
		});
	});
});

describe("handleTransfer file.import", () => {
	beforeEach(() => {
		mockFsPromises.stat.mockClear();
		mockFsPromises.unlink.mockClear();
		mockFsPromises.rename.mockClear();
		mockFsPromises.stat.mockResolvedValue(null);
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			body: Readable.toWeb(Readable.from([Buffer.from("hello")])),
		} as never);
	});

	it("默认不覆盖已有文件并返回 PATH_CONFLICT", async () => {
		mockFsPromises.stat.mockResolvedValue({ isDirectory: () => false });
		const socket = mockSocket();

		await handleTransfer(importJob(false), socket);

		expect(errorCalls(socket)[0]?.[1].error).toEqual({
			code: "PATH_CONFLICT",
			message: "Destination exists; set overwrite=true",
		});
		expect(mockFsPromises.rename).not.toHaveBeenCalled();
	});

	it("overwrite=true 时替换已有文件并返回实际大小", async () => {
		mockFsPromises.stat.mockResolvedValue({ isDirectory: () => false });
		const socket = mockSocket();

		await handleTransfer(importJob(true), socket);

		expect(mockFsPromises.unlink).toHaveBeenCalledWith("c:/root/a.txt");
		expect(mockFsPromises.rename).toHaveBeenCalledWith(
			expect.stringContaining("a.txt.vcpdeck-tmp-"),
			"c:/root/a.txt",
		);
		expect(doneCalls(socket)[0]?.[1].result).toMatchObject({
			key: "k",
			size: 5,
		});
	});

	it("实际字节数与声明 size 不符时报 IO_ERROR 并清理临时文件", async () => {
		const socket = mockSocket();
		const job = importJob(false);
		await handleTransfer(
			{ ...job, payload: { ...job.payload, size: 999 } },
			socket,
		);

		expect(errorCalls(socket)[0]?.[1].error.code).toBe("IO_ERROR");
		expect(mockFsPromises.rename).not.toHaveBeenCalled();
		expect(mockFsPromises.unlink).toHaveBeenCalledWith(
			expect.stringContaining("a.txt.vcpdeck-tmp-"),
		);
	});

	it("downloadRef.direct 时直连外部 URL 且只校验 size", async () => {
		vi.mocked(fetch).mockClear();
		const socket = mockSocket();
		await handleTransfer(importJob(false, true), socket);

		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
			"https://download.example/x",
		);
		expect(doneCalls(socket)[0]?.[1].result).toMatchObject({
			key: "k",
			size: 5,
		});
	});

	it("拒绝非 Server 同源的绝对下载 URL", async () => {
		vi.mocked(fetch).mockClear();
		const socket = mockSocket();
		const job = importJob(false);
		await handleTransfer(
			{
				...job,
				payload: {
					...job.payload,
					downloadRef: {
						...job.payload.downloadRef,
						url: "http://evil.example/steal",
					},
				},
			},
			socket,
		);

		expect(errorCalls(socket)[0]?.[1].error.code).toBe("IO_ERROR");
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
	});

	it("下载写入阶段补报精确进度", async () => {
		const socket = mockSocket();
		await handleTransfer(importJob(false), socket);

		expect(progressCalls(socket).at(-1)?.[1]).toEqual({
			jobId: "job-1",
			loaded: 5,
			total: 5,
		});
	});
});
