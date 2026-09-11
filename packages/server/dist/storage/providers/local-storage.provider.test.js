"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_path_1 = require("node:path");
const local_storage_provider_js_1 = require("./local-storage.provider.js");
(0, vitest_1.describe)("resolveStorageBaseDir 锚定", () => {
    (0, vitest_1.it)("绝对 baseDir 原样返回，不受 app-dir 影响", () => {
        (0, vitest_1.expect)((0, local_storage_provider_js_1.resolveStorageBaseDir)("/data/storage", "/app")).toBe((0, node_path_1.resolve)("/data/storage"));
    });
    (0, vitest_1.it)("相对 baseDir + VCPDECK_APP_DIR 锚定到版本目录外", () => {
        (0, vitest_1.expect)((0, local_storage_provider_js_1.resolveStorageBaseDir)("./data/storage", "/vcpdeck/app")).toBe((0, node_path_1.resolve)("/vcpdeck/app", "data/storage"));
    });
    (0, vitest_1.it)("相对 baseDir 无 app-dir 时按 cwd 解析（现状）", () => {
        (0, vitest_1.expect)((0, local_storage_provider_js_1.resolveStorageBaseDir)("./data/storage")).toBe((0, node_path_1.resolve)(process.cwd(), "data/storage"));
    });
    (0, vitest_1.it)("默认取 process.env.VCPDECK_APP_DIR", () => {
        vitest_1.vi.stubEnv("VCPDECK_APP_DIR", "/env-app");
        try {
            (0, vitest_1.expect)((0, local_storage_provider_js_1.resolveStorageBaseDir)("./data/storage")).toBe((0, node_path_1.resolve)("/env-app", "data/storage"));
        }
        finally {
            vitest_1.vi.unstubAllEnvs();
        }
    });
});
(0, vitest_1.describe)("LocalStorageProvider download signature", () => {
    let provider;
    (0, vitest_1.beforeEach)(() => {
        provider = new local_storage_provider_js_1.LocalStorageProvider({ baseDir: "./data/storage-test" });
    });
    (0, vitest_1.it)("ttlSeconds <= 0 签出 expires=0（永久），verify 通过", () => {
        const qs = provider.signDownloadUrl("abc/def.txt", 0);
        (0, vitest_1.expect)(qs).toContain("expires=0");
        const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
        const sig = new URLSearchParams(qs).get("sig") || "";
        (0, vitest_1.expect)(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(true);
    });
    (0, vitest_1.it)("正常 ttl 签出的签名过期后 verify 拒绝", () => {
        vitest_1.vi.useFakeTimers();
        try {
            const qs = provider.signDownloadUrl("abc/def.txt", 1); // 1 秒有效期
            const expires = parseInt(new URLSearchParams(qs).get("expires") || "0", 10);
            const sig = new URLSearchParams(qs).get("sig") || "";
            (0, vitest_1.expect)(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(true);
            vitest_1.vi.setSystemTime(expires + 1000); // 越过过期时刻
            (0, vitest_1.expect)(provider.verifyDownloadSignature("abc/def.txt", expires, sig)).toBe(false);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("对象不存在时抛出可识别的永久缺失错误", async () => {
        await (0, vitest_1.expect)(provider.download("missing/file.txt")).rejects.toMatchObject({
            name: "StorageObjectNotFoundError",
        });
    });
});
