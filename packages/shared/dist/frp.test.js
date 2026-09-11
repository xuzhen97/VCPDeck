"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const index_js_1 = require("./index.js");
(0, vitest_1.describe)("FRP shared contract", () => {
    (0, vitest_1.it)("公开收敛状态和稳定错误码", () => {
        (0, vitest_1.expect)(index_js_1.FRP_MAPPING_STATUSES).toEqual([
            "provisioning",
            "active",
            "inactive",
            "deleting",
            "error",
            "reconciling",
        ]);
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRPS_DASHBOARD_REQUIRED");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_PROXY_CONFIRM_TIMEOUT");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_ROLLBACK_FAILED");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_RECONCILE_BUSY");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_RECONCILE_FAILED");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_RUNTIME_GENERATION_STALE");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_RUNTIME_STATE_INVALID");
        (0, vitest_1.expect)(index_js_1.FRP_ERROR_CODES).toContain("FRP_RECONCILE_TIMEOUT");
    });
    (0, vitest_1.it)("两个 Job type 集合均包含 frp.reconcile", () => {
        (0, vitest_1.expect)(index_js_1.JobType.FRP_RECONCILE).toBe("frp.reconcile");
        (0, vitest_1.expect)(index_js_1.FrpJobType.FRP_RECONCILE).toBe("frp.reconcile");
    });
    (0, vitest_1.it)("解析 TCP 请求并补齐默认值，name 可省略", () => {
        (0, vitest_1.expect)((0, index_js_1.parseFrpMappingCreateRequest)({
            clientId: "client-1",
            proxyType: "tcp",
            localPort: 1919,
        })).toEqual({
            clientId: "client-1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            timeoutSeconds: 30,
        });
    });
    vitest_1.it.each(["http", "https"])("解析 %s 请求并要求 customDomain", (proxyType) => {
        (0, vitest_1.expect)((0, index_js_1.parseFrpMappingCreateRequest)({
            clientId: "client-1",
            name: "web-1",
            proxyType,
            localIp: "127.0.0.1",
            localPort: 8080,
            customDomain: "app.example.com",
            timeoutSeconds: 45,
        })).toMatchObject({ proxyType, customDomain: "app.example.com" });
        (0, vitest_1.expect)(() => (0, index_js_1.parseFrpMappingCreateRequest)({
            clientId: "client-1",
            proxyType,
            localPort: 8080,
        })).toThrow(index_js_1.FrpProtocolError);
    });
    (0, vitest_1.it)("拒绝类型冲突、注入字符、未知字段和非法端口", () => {
        const invalid = [
            {
                clientId: "client-1",
                proxyType: "tcp",
                localPort: 1919,
                customDomain: "app.example.com",
            },
            {
                clientId: "client-1",
                proxyType: "http",
                localPort: 8080,
                remotePort: 20000,
                customDomain: "app.example.com",
            },
            {
                clientId: "client-1",
                name: "bad\"\nname",
                proxyType: "tcp",
                localPort: 1919,
            },
            {
                clientId: "client-1",
                proxyType: "tcp",
                localPort: 0,
            },
            {
                clientId: "client-1",
                proxyType: "tcp",
                localPort: 1919,
                secret: "unexpected",
            },
        ];
        for (const value of invalid) {
            (0, vitest_1.expect)(() => (0, index_js_1.parseFrpMappingCreateRequest)(value)).toThrow(index_js_1.FrpProtocolError);
        }
    });
    (0, vitest_1.it)("限制确认超时为 1–300 秒", () => {
        (0, vitest_1.expect)((0, index_js_1.parseFrpOperationTimeout)(undefined)).toBe(30);
        (0, vitest_1.expect)((0, index_js_1.parseFrpOperationTimeout)("45")).toBe(45);
        for (const value of [0, 301, 1.5, "x"]) {
            (0, vitest_1.expect)(() => (0, index_js_1.parseFrpOperationTimeout)(value)).toThrow(index_js_1.FrpProtocolError);
        }
    });
});
