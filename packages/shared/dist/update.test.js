"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const update_js_1 = require("./update.js");
(0, vitest_1.describe)("Release archive 生命周期", () => {
    (0, vitest_1.it)("只有 available archive 可用于下载和编排", () => {
        const base = { sha256: "a".repeat(64), size: 1, fileName: "x.zip" };
        (0, vitest_1.expect)((0, update_js_1.isReleaseArchiveAvailable)({ ...base, availability: "available" })).toBe(true);
        (0, vitest_1.expect)((0, update_js_1.isReleaseArchiveAvailable)({ ...base, availability: "deleting" })).toBe(false);
        (0, vitest_1.expect)((0, update_js_1.isReleaseArchiveAvailable)({
            ...base,
            availability: "cleaned",
            cleanedAt: "2026-08-29T00:00:00.000Z",
            cleanupReason: "retention_policy",
        })).toBe(false);
    });
    (0, vitest_1.it)("cleaned archive 保留审计摘要但不保留存储 key", () => {
        const cleaned = {
            availability: "cleaned",
            sha256: "a".repeat(64),
            size: 1,
            fileName: "x.zip",
            storageSummary: { provider: "alibaba", mode: "direct" },
            cleanedAt: "2026-08-29T00:00:00.000Z",
            cleanupReason: "retention_policy",
        };
        (0, vitest_1.expect)(cleaned.storageSummary?.provider).toBe("alibaba");
        (0, vitest_1.expect)("storage" in cleaned).toBe(false);
    });
});
(0, vitest_1.describe)("Release 上传会话 parser", () => {
    (0, vitest_1.it)("严格解析创建会话输入", () => {
        (0, vitest_1.expect)((0, update_js_1.parseReleaseUploadCreateInput)({
            version: "0.2.1",
            platform: "win-x64",
            sha256: "a".repeat(64),
            size: 123,
        })).toEqual({
            version: "0.2.1",
            platform: "win-x64",
            sha256: "a".repeat(64),
            size: 123,
        });
        (0, vitest_1.expect)(() => (0, update_js_1.parseReleaseUploadCreateInput)({
            version: "0.2.1",
            platform: "win-x64",
            sha256: "a".repeat(64),
            size: 123,
            psk: "secret",
        })).toThrow("必须且只能包含");
    });
    (0, vitest_1.it)("严格解析刷新分片和完成输入", () => {
        (0, vitest_1.expect)((0, update_js_1.parseReleaseUploadPartRefresh)({ partNumbers: [1, 2] })).toEqual({
            partNumbers: [1, 2],
        });
        (0, vitest_1.expect)(() => (0, update_js_1.parseReleaseUploadPartRefresh)({ partNumbers: [1, 1] })).toThrow("不重复");
        (0, vitest_1.expect)((0, update_js_1.parseReleaseUploadComplete)({ uploadedBytes: 123 })).toEqual({
            uploadedBytes: 123,
        });
        (0, vitest_1.expect)(() => (0, update_js_1.parseReleaseUploadComplete)({ uploadedBytes: 0 })).toThrow("uploadedBytes");
    });
});
