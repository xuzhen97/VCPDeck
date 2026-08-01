import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Socket } from "socket.io-client";
import { Events } from "@vcpdeck/shared";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";

// 统一 mock platform，让 normPath 在任意 OS 上都用 Windows 小写规则
vi.mock("node:os", () => ({
	platform: vi.fn(() => "win32"),
	homedir: vi.fn(() => "C:\\Users\\test"),
}));

const mockFsPromises = vi.hoisted(() => ({
	stat: vi.fn(),
	realpath: vi.fn(async (p: string) => p),
}));
vi.mock("node:fs/promises", () => ({
	...mockFsPromises,
	default: mockFsPromises,
}));

vi.mock("node:fs", () => ({
	createReadStream: vi.fn(() => Readable.from([Buffer.from("hello")])),
	createWriteStream: vi.fn(),
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
		.mock.calls.filter(
			([event]) => event === Events.JOB_PROGRESS,
		) as Array<[string, { jobId: string; loaded: number; total: number }]>;
}

describe("handleTransfer file.export", () => {
	beforeEach(() => {
		// mock fetch 必须消费 body，否则上传流（webStream）不会流动，
		// sha256/进度逻辑都不会执行
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
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
			}),
		);
		mockFsPromises.stat.mockResolvedValue({ size: 5 });
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
		} as never);		const socket = mockSocket();
		await handleTransfer(exportJob(), socket);

		const [, data] = doneCalls(socket)[0]!;
		expect(data.result.key).toBe("uuid/a.txt");
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
});
