"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateImageBytes = validateImageBytes;
exports.downloadPromptImages = downloadPromptImages;
exports.toSdkImages = toSdkImages;
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@vcpdeck/shared");
/** 图片魔数校验（PNG/JPEG/GIF/WebP） */
const MAGIC = [
    {
        mime: "image/png",
        match: (b) => b.length >= 8 &&
            b[0] === 0x89 &&
            b[1] === 0x50 &&
            b[2] === 0x4e &&
            b[3] === 0x47 &&
            b[4] === 0x0d &&
            b[5] === 0x0a &&
            b[6] === 0x1a &&
            b[7] === 0x0a,
    },
    {
        mime: "image/jpeg",
        match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    },
    {
        mime: "image/gif",
        match: (b) => {
            const head = b.subarray(0, 6).toString("latin1");
            return head === "GIF87a" || head === "GIF89a";
        },
    },
    {
        mime: "image/webp",
        match: (b) => b.length >= 12 &&
            b.subarray(0, 4).toString("latin1") === "RIFF" &&
            b.subarray(8, 12).toString("latin1") === "WEBP",
    },
];
function piError(code, message) {
    return Object.assign(new Error(message), { code });
}
/** 校验单图字节（真实大小/魔数/MIME 一致性） */
function validateImageBytes(bytes, declared) {
    if (bytes.length > shared_1.MAX_PI_IMAGE_BYTES) {
        throw piError("PI_IMAGE_TOO_LARGE", `Image exceeds ${shared_1.MAX_PI_IMAGE_BYTES} bytes`);
    }
    if (bytes.length !== declared.size) {
        throw piError("PI_IMAGE_INVALID", "Image size mismatch");
    }
    const hash = (0, node_crypto_1.createHash)("sha256").update(bytes).digest("hex");
    if (hash !== declared.sha256) {
        throw piError("PI_IMAGE_INVALID", "Image sha256 mismatch");
    }
    const magic = MAGIC.find((m) => m.match(bytes));
    if (!magic) {
        throw piError("PI_IMAGE_INVALID", "Image magic bytes not recognized");
    }
    if (magic.mime !== declared.mimeType) {
        throw piError("PI_IMAGE_INVALID", "Image MIME mismatch");
    }
}
/** 安全下载：禁止重定向跟随（redirect: manual），校验响应的 Content-Length */
async function fetchBytes(url) {
    const response = await fetch(url, {
        redirect: "manual",
        headers: { Accept: "image/*" },
    });
    if (response.status < 200 || response.status >= 300) {
        throw piError("PI_IMAGE_INVALID", `Download failed: HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 0 && declaredLength > shared_1.MAX_PI_IMAGE_BYTES) {
        throw piError("PI_IMAGE_TOO_LARGE", "Declared size exceeds limit");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > shared_1.MAX_PI_IMAGE_BYTES) {
        throw piError("PI_IMAGE_TOO_LARGE", "Image exceeds limit");
    }
    return bytes;
}
/**
 * 下载并校验 prompt 附件（Content-Length + 真实 bytes 双上限、
 * declared size/hash/MIME、魔数、禁 redirect 跟随）。
 * 任何失败清空全部 buffer 并抛稳定错误。
 */
async function downloadPromptImages(refs) {
    const out = [];
    try {
        for (const ref of refs) {
            const bytes = await fetchBytes(ref.url);
            validateImageBytes(bytes, ref);
            out.push({ bytes, ref });
        }
        return out;
    }
    catch (err) {
        out.length = 0;
        throw err;
    }
}
/** 转为 Pi SDK image content（base64） */
function toSdkImages(images) {
    return images.map(({ bytes, ref }) => ({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: ref.mimeType,
    }));
}
