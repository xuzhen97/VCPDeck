"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const frontend_origin_adapter_js_1 = require("./frontend-origin.adapter.js");
// 默认配置：VCPDECK_FRONTEND_ORIGIN / VCPDECK_CORS_ORIGIN 均为 http://localhost:5173
(0, vitest_1.describe)("isFrontendOriginAllowed", () => {
    (0, vitest_1.it)("无 Origin（Node/CLI 客户端）放行", () => {
        (0, vitest_1.expect)((0, frontend_origin_adapter_js_1.isFrontendOriginAllowed)(undefined, { headers: {} })).toBe(true);
    });
    (0, vitest_1.it)("显式配置的跨源放行", () => {
        (0, vitest_1.expect)((0, frontend_origin_adapter_js_1.isFrontendOriginAllowed)("http://localhost:5173", { headers: {} })).toBe(true);
    });
    (0, vitest_1.it)("同源（页面与 API 同机同端口）放行", () => {
        (0, vitest_1.expect)((0, frontend_origin_adapter_js_1.isFrontendOriginAllowed)("http://deck.local:3001", {
            headers: { host: "deck.local:3001" },
        })).toBe(true);
    });
    (0, vitest_1.it)("任意跨源被拒绝（防 CSWSH：/app 走 Cookie 会话）", () => {
        (0, vitest_1.expect)((0, frontend_origin_adapter_js_1.isFrontendOriginAllowed)("http://evil.example", {
            headers: { host: "deck.local:3001" },
        })).toBe(false);
    });
    (0, vitest_1.it)("Host 被篡改但 Origin 不符仍拒绝", () => {
        (0, vitest_1.expect)((0, frontend_origin_adapter_js_1.isFrontendOriginAllowed)("http://deck.local:3001", {
            headers: { host: "attacker.example" },
        })).toBe(false);
    });
});
