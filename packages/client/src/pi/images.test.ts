import { describe, expect, it, vi } from "vitest";
import { downloadPromptImages, validateImageBytes } from "./images.js";
import type { PiAttachmentRef } from "@vcpdeck/shared";

function pngBytes(size = 1024): Buffer {
	const buf = Buffer.alloc(size);
	// PNG magic
	buf[0] = 0x89;
	buf[1] = 0x50;
	buf[2] = 0x4e;
	buf[3] = 0x47;
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	return buf;
}

function refOf(bytes: Buffer, overrides: Partial<PiAttachmentRef> = {}): PiAttachmentRef {
	const { createHash } = require("node:crypto");
	return {
		fileId: "f1",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.length,
		mimeType: "image/png",
		url: "https://storage.local/api/storage/download/k1?sig=x",
		expiresAt: Date.now() + 600_000,
		...overrides,
	};
}

function stubFetch(bytes: Buffer, headers: Record<string, string> = {}) {
	const fetcher = vi.fn(async () => ({
		status: 200,
		headers: { get: (k: string) => headers[k] ?? null },
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	}));
	vi.stubGlobal("fetch", fetcher);
	return fetcher;
}

function expectPiError(fn: () => void, code: string): void {
	try {
		fn();
		expect.unreachable("should throw");
	} catch (err) {
		expect(err).toMatchObject({ code });
	}
}

describe("validateImageBytes", () => {
	it("PNG 通过校验", () => {
		const bytes = pngBytes();
		expect(() => validateImageBytes(bytes, refOf(bytes))).not.toThrow();
	});

	it("大小不匹配拒绝", () => {
		const bytes = pngBytes();
		expectPiError(() => validateImageBytes(bytes, refOf(bytes, { size: bytes.length + 1 })), "PI_IMAGE_INVALID");
	});

	it("sha256 不匹配拒绝", () => {
		const bytes = pngBytes();
		expectPiError(
			() => validateImageBytes(bytes, refOf(bytes, { sha256: "0".repeat(64) })),
			"PI_IMAGE_INVALID",
		);
	});

	it("MIME 与魔数不一致拒绝", () => {
		const bytes = pngBytes();
		expectPiError(
			() => validateImageBytes(bytes, refOf(bytes, { mimeType: "image/jpeg" })),
			"PI_IMAGE_INVALID",
		);
	});

	it("非图片魔数拒绝", () => {
		const bytes = Buffer.from("not an image at all........");
		expectPiError(() => validateImageBytes(bytes, refOf(bytes)), "PI_IMAGE_INVALID");
	});

	it("超过 10 MiB 拒绝", () => {
		const bytes = pngBytes(11 * 1024 * 1024);
		expectPiError(() => validateImageBytes(bytes, refOf(bytes)), "PI_IMAGE_TOO_LARGE");
	});

	it("JPEG/GIF/WebP 魔数通过", () => {
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]);
		expect(() => validateImageBytes(jpeg, refOf(jpeg, { mimeType: "image/jpeg" }))).not.toThrow();
		const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100)]);
		expect(() => validateImageBytes(gif, refOf(gif, { mimeType: "image/gif" }))).not.toThrow();
		const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
		expect(() => validateImageBytes(webp, refOf(webp, { mimeType: "image/webp" }))).not.toThrow();
	});
});

describe("downloadPromptImages", () => {
	it("下载并校验全部图片，失败清空", async () => {
		const good = pngBytes(1024);
		const bad = Buffer.from("junk");
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce({
				status: 200,
				headers: { get: () => String(good.length) },
				arrayBuffer: async () =>
					good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength),
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: { get: () => String(bad.length) },
				arrayBuffer: async () =>
					bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength),
			});
		vi.stubGlobal("fetch", fetcher);

		await expect(
			downloadPromptImages([refOf(good), refOf(bad)]),
		).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
	});

	it("禁用 redirect 跟随", async () => {
		const bytes = pngBytes();
		const fetcher = stubFetch(bytes, { "content-length": String(bytes.length) });
		await downloadPromptImages([refOf(bytes)]);
		expect(fetcher).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("Content-Length 超限在下载前拒绝", async () => {
		const bytes = pngBytes(100);
		const fetcher = stubFetch(bytes, { "content-length": String(11 * 1024 * 1024) });
		await expect(downloadPromptImages([refOf(bytes)])).rejects.toMatchObject({
			code: "PI_IMAGE_TOO_LARGE",
		});
		expect(fetcher).toHaveBeenCalled();
	});

	it("HTTP 错误拒绝", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				status: 403,
				headers: { get: () => null },
				arrayBuffer: async () => new ArrayBuffer(0),
			})),
		);
		const bytes = pngBytes();
		await expect(downloadPromptImages([refOf(bytes)])).rejects.toMatchObject({
			code: "PI_IMAGE_INVALID",
		});
	});
});
