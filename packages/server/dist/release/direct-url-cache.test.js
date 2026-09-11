"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const direct_url_cache_js_1 = require("./direct-url-cache.js");
const NOW = 1_800_000_000_000;
(0, vitest_1.describe)("DirectUrlCache", () => {
    (0, vitest_1.it)("set 后未过期可命中", () => {
        const cache = new direct_url_cache_js_1.DirectUrlCache();
        cache.set("k", "https://storage/x", NOW + 900_000);
        (0, vitest_1.expect)(cache.get("k", NOW)).toBe("https://storage/x");
    });
    (0, vitest_1.it)("超过有效期（含安全余量）返回 null 并淘汰", () => {
        const cache = new direct_url_cache_js_1.DirectUrlCache();
        cache.set("k", "https://storage/x", NOW + 30_000);
        // 距过期不足默认 60s 安全余量 → 视为已过期
        (0, vitest_1.expect)(cache.get("k", NOW + 1)).toBeNull();
        (0, vitest_1.expect)(cache.get("k", NOW + 1)).toBeNull();
    });
    (0, vitest_1.it)("expiresAt 以秒给出时换算为毫秒", () => {
        const cache = new direct_url_cache_js_1.DirectUrlCache();
        cache.set("k", "https://storage/x", NOW / 1000 + 900);
        (0, vitest_1.expect)(cache.get("k", NOW)).toBe("https://storage/x");
    });
    (0, vitest_1.it)("expiresAt 为 0 表示不设过期，始终命中", () => {
        const cache = new direct_url_cache_js_1.DirectUrlCache();
        cache.set("k", "https://storage/x", 0);
        (0, vitest_1.expect)(cache.get("k", NOW + 3_600_000)).toBe("https://storage/x");
    });
    (0, vitest_1.it)("delete 后不再命中", () => {
        const cache = new direct_url_cache_js_1.DirectUrlCache();
        cache.set("k", "https://storage/x", NOW + 900_000);
        cache.delete("k");
        (0, vitest_1.expect)(cache.get("k", NOW)).toBeNull();
    });
});
