"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const images_js_1 = require("./images.js");
function pngBytes(size = 1024) {
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
function refOf(bytes, overrides = {}) {
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
function stubFetch(bytes, headers = {}) {
    const fetcher = vitest_1.vi.fn(async () => ({
        status: 200,
        headers: { get: (k) => headers[k] ?? null },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    vitest_1.vi.stubGlobal("fetch", fetcher);
    return fetcher;
}
function expectPiError(fn, code) {
    try {
        fn();
        vitest_1.expect.unreachable("should throw");
    }
    catch (err) {
        (0, vitest_1.expect)(err).toMatchObject({ code });
    }
}
(0, vitest_1.describe)("validateImageBytes", () => {
    (0, vitest_1.it)("PNG 通过校验", () => {
        const bytes = pngBytes();
        (0, vitest_1.expect)(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes))).not.toThrow();
    });
    (0, vitest_1.it)("大小不匹配拒绝", () => {
        const bytes = pngBytes();
        expectPiError(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes, { size: bytes.length + 1 })), "PI_IMAGE_INVALID");
    });
    (0, vitest_1.it)("sha256 不匹配拒绝", () => {
        const bytes = pngBytes();
        expectPiError(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes, { sha256: "0".repeat(64) })), "PI_IMAGE_INVALID");
    });
    (0, vitest_1.it)("MIME 与魔数不一致拒绝", () => {
        const bytes = pngBytes();
        expectPiError(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes, { mimeType: "image/jpeg" })), "PI_IMAGE_INVALID");
    });
    (0, vitest_1.it)("非图片魔数拒绝", () => {
        const bytes = Buffer.from("not an image at all........");
        expectPiError(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes)), "PI_IMAGE_INVALID");
    });
    (0, vitest_1.it)("超过 10 MiB 拒绝", () => {
        const bytes = pngBytes(11 * 1024 * 1024);
        expectPiError(() => (0, images_js_1.validateImageBytes)(bytes, refOf(bytes)), "PI_IMAGE_TOO_LARGE");
    });
    (0, vitest_1.it)("JPEG/GIF/WebP 魔数通过", () => {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100)]);
        (0, vitest_1.expect)(() => (0, images_js_1.validateImageBytes)(jpeg, refOf(jpeg, { mimeType: "image/jpeg" }))).not.toThrow();
        const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(100)]);
        (0, vitest_1.expect)(() => (0, images_js_1.validateImageBytes)(gif, refOf(gif, { mimeType: "image/gif" }))).not.toThrow();
        const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
        (0, vitest_1.expect)(() => (0, images_js_1.validateImageBytes)(webp, refOf(webp, { mimeType: "image/webp" }))).not.toThrow();
    });
});
(0, vitest_1.describe)("downloadPromptImages", () => {
    (0, vitest_1.it)("下载并校验全部图片，失败清空", async () => {
        const good = pngBytes(1024);
        const bad = Buffer.from("junk");
        const fetcher = vitest_1.vi
            .fn()
            .mockResolvedValueOnce({
            status: 200,
            headers: { get: () => String(good.length) },
            arrayBuffer: async () => good.buffer.slice(good.byteOffset, good.byteOffset + good.byteLength),
        })
            .mockResolvedValueOnce({
            status: 200,
            headers: { get: () => String(bad.length) },
            arrayBuffer: async () => bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength),
        });
        vitest_1.vi.stubGlobal("fetch", fetcher);
        await (0, vitest_1.expect)((0, images_js_1.downloadPromptImages)([refOf(good), refOf(bad)])).rejects.toMatchObject({ code: "PI_IMAGE_INVALID" });
    });
    (0, vitest_1.it)("禁用 redirect 跟随", async () => {
        const bytes = pngBytes();
        const fetcher = stubFetch(bytes, { "content-length": String(bytes.length) });
        await (0, images_js_1.downloadPromptImages)([refOf(bytes)]);
        (0, vitest_1.expect)(fetcher).toHaveBeenCalledWith(vitest_1.expect.any(String), vitest_1.expect.objectContaining({ redirect: "manual" }));
    });
    (0, vitest_1.it)("Content-Length 超限在下载前拒绝", async () => {
        const bytes = pngBytes(100);
        const fetcher = stubFetch(bytes, { "content-length": String(11 * 1024 * 1024) });
        await (0, vitest_1.expect)((0, images_js_1.downloadPromptImages)([refOf(bytes)])).rejects.toMatchObject({
            code: "PI_IMAGE_TOO_LARGE",
        });
        (0, vitest_1.expect)(fetcher).toHaveBeenCalled();
    });
    (0, vitest_1.it)("HTTP 错误拒绝", async () => {
        vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn(async () => ({
            status: 403,
            headers: { get: () => null },
            arrayBuffer: async () => new ArrayBuffer(0),
        })));
        const bytes = pngBytes();
        await (0, vitest_1.expect)((0, images_js_1.downloadPromptImages)([refOf(bytes)])).rejects.toMatchObject({
            code: "PI_IMAGE_INVALID",
        });
    });
});
