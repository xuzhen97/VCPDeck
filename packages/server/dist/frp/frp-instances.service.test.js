"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const frp_instances_service_js_1 = require("./frp-instances.service.js");
function mockPrisma() {
    return {
        frpsInstance: {
            create: vitest_1.vi.fn(),
            findUnique: vitest_1.vi.fn(),
            findFirst: vitest_1.vi.fn(),
            findMany: vitest_1.vi.fn(),
            count: vitest_1.vi.fn(),
            update: vitest_1.vi.fn(),
            delete: vitest_1.vi.fn(),
            updateMany: vitest_1.vi.fn(),
        },
        frpMapping: {
            count: vitest_1.vi.fn(),
        },
    };
}
(0, vitest_1.describe)("FrpsInstancesService", () => {
    let service;
    let prisma;
    (0, vitest_1.beforeEach)(() => {
        prisma = mockPrisma();
        service = new frp_instances_service_js_1.FrpsInstancesService(prisma);
    });
    (0, vitest_1.describe)("create", () => {
        (0, vitest_1.it)("should create an instance with defaults", async () => {
            prisma.frpsInstance.create.mockResolvedValue({
                id: "frps_abc",
                name: "test",
                serverAddr: "1.2.3.4",
                serverPort: 7000,
                authToken: "",
                dashboardScheme: "http",
                dashboardHost: null,
                dashboardPort: 7500,
                dashboardUser: "admin",
                dashboardPassword: "admin",
                portRangeStart: 20000,
                portRangeEnd: 21000,
                isDefault: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const result = await service.create({
                name: "test",
                serverAddr: "1.2.3.4",
            });
            (0, vitest_1.expect)(result.name).toBe("test");
            (0, vitest_1.expect)(result.id).toMatch(/^frps_/);
        });
        (0, vitest_1.it)("should clear other defaults when isDefault=true", async () => {
            prisma.frpsInstance.updateMany.mockResolvedValue({});
            prisma.frpsInstance.create.mockResolvedValue({
                id: "frps_xyz",
                name: "default",
                serverAddr: "1.2.3.4",
                serverPort: 7000,
                authToken: "",
                dashboardScheme: "http",
                dashboardHost: null,
                dashboardPort: 7500,
                dashboardUser: "admin",
                dashboardPassword: "admin",
                portRangeStart: 20000,
                portRangeEnd: 21000,
                isDefault: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const result = await service.create({
                name: "default",
                serverAddr: "1.2.3.4",
                isDefault: true,
            });
            (0, vitest_1.expect)(prisma.frpsInstance.updateMany).toHaveBeenCalledWith({
                where: { isDefault: true },
                data: { isDefault: false },
            });
            (0, vitest_1.expect)(result.isDefault).toBe(true);
        });
    });
    (0, vitest_1.describe)("delete", () => {
        (0, vitest_1.it)("should reject when mappings exist", async () => {
            prisma.frpsInstance.findUnique.mockResolvedValue({
                id: "frps_abc",
                name: "test",
            });
            prisma.frpMapping.count.mockResolvedValue(3);
            await (0, vitest_1.expect)(service.delete("frps_abc")).rejects.toThrow("3 个映射");
        });
        (0, vitest_1.it)("should delete when no mappings", async () => {
            prisma.frpMapping.count.mockResolvedValue(0);
            prisma.frpsInstance.findUnique.mockResolvedValue({
                id: "frps_abc",
            });
            prisma.frpsInstance.delete.mockResolvedValue({});
            const result = await service.delete("frps_abc");
            (0, vitest_1.expect)(result).toBe(true);
        });
    });
    (0, vitest_1.describe)("migrateFromEnvIfNeeded", () => {
        (0, vitest_1.it)("should skip if instances exist", async () => {
            prisma.frpsInstance.count.mockResolvedValue(1);
            const result = await service.migrateFromEnvIfNeeded();
            (0, vitest_1.expect)(result).toBeNull();
        });
        (0, vitest_1.it)("should create default from env when none exist", async () => {
            prisma.frpsInstance.count.mockResolvedValue(0);
            prisma.frpsInstance.create.mockResolvedValue({
                id: "frps_mig",
                name: "默认（从环境变量迁移）",
                serverAddr: "127.0.0.1",
                serverPort: 17000,
                authToken: "test-frp-token",
                dashboardScheme: "http",
                dashboardHost: "127.0.0.1",
                dashboardPort: 17500,
                dashboardUser: "admin",
                dashboardPassword: "admin",
                portRangeStart: 20000,
                portRangeEnd: 21000,
                isDefault: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const result = await service.migrateFromEnvIfNeeded();
            (0, vitest_1.expect)(result).not.toBeNull();
            (0, vitest_1.expect)(result.name).toBe("默认（从环境变量迁移）");
            (0, vitest_1.expect)(result.serverPort).toBe(17000);
            (0, vitest_1.expect)(result.authToken).toBe("test-frp-token");
            (0, vitest_1.expect)(result.dashboardHost).toBe("127.0.0.1");
            (0, vitest_1.expect)(prisma.frpsInstance.create).toHaveBeenCalled();
        });
    });
    (0, vitest_1.describe)("setDefault", () => {
        (0, vitest_1.it)("should clear other defaults and set the target", async () => {
            prisma.frpsInstance.updateMany.mockResolvedValue({});
            prisma.frpsInstance.update.mockResolvedValue({
                id: "frps_abc",
                name: "primary",
                serverAddr: "1.2.3.4",
                serverPort: 7000,
                authToken: "",
                dashboardScheme: "http",
                dashboardHost: null,
                dashboardPort: 7500,
                dashboardUser: "admin",
                dashboardPassword: "admin",
                portRangeStart: 20000,
                portRangeEnd: 21000,
                isDefault: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const result = await service.setDefault("frps_abc");
            (0, vitest_1.expect)(result.isDefault).toBe(true);
            (0, vitest_1.expect)(prisma.frpsInstance.updateMany).toHaveBeenCalledWith({
                where: { isDefault: true },
                data: { isDefault: false },
            });
        });
    });
    (0, vitest_1.describe)("getDefault", () => {
        (0, vitest_1.it)("should throw when no default", async () => {
            prisma.frpsInstance.findFirst.mockResolvedValue(null);
            await (0, vitest_1.expect)(service.getDefault()).rejects.toThrow("没有默认");
        });
        (0, vitest_1.it)("should return the default instance", async () => {
            prisma.frpsInstance.findFirst.mockResolvedValue({
                id: "frps_def",
                name: "default",
                serverAddr: "1.2.3.4",
                serverPort: 7000,
                authToken: "",
                dashboardScheme: "http",
                dashboardHost: null,
                dashboardPort: 7500,
                dashboardUser: "admin",
                dashboardPassword: "admin",
                portRangeStart: 20000,
                portRangeEnd: 21000,
                isDefault: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const result = await service.getDefault();
            (0, vitest_1.expect)(result.isDefault).toBe(true);
        });
    });
    (0, vitest_1.describe)("listDashboardProxies", () => {
        const instance = {
            id: "frps_def",
            name: "default",
            serverAddr: "1.2.3.4",
            serverPort: 7000,
            authToken: "token",
            dashboardScheme: "http",
            dashboardHost: "dashboard.internal",
            dashboardPort: 7500,
            dashboardUser: "operator",
            dashboardPassword: "secret",
            portRangeStart: 20000,
            portRangeEnd: 21000,
            isDefault: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        (0, vitest_1.it)("严格返回三类 proxy，并携带正确 Basic Auth", async () => {
            const fetcher = vitest_1.vi.fn(async (input, _init) => {
                const type = String(input).split("/").at(-1);
                return Response.json({
                    proxies: [{ name: `${type}-proxy`, status: "online", conf: { remotePort: 20100 } }],
                });
            });
            vitest_1.vi.stubGlobal("fetch", fetcher);
            const result = await service.listDashboardProxies(instance);
            (0, vitest_1.expect)(result.list).toEqual([
                { name: "tcp-proxy", proxyType: "tcp", status: "online", remotePort: 20100 },
                { name: "http-proxy", proxyType: "http", status: "online", remotePort: 20100 },
                { name: "https-proxy", proxyType: "https", status: "online", remotePort: 20100 },
            ]);
            (0, vitest_1.expect)(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
                Authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`,
            });
        });
        (0, vitest_1.it)("未配置 Dashboard 时返回稳定错误码", async () => {
            await (0, vitest_1.expect)(service.listDashboardProxies({ ...instance, dashboardHost: null })).rejects.toMatchObject({ code: "FRPS_DASHBOARD_REQUIRED" });
        });
        vitest_1.it.each([
            [401, "FRPS_DASHBOARD_AUTH_FAILED"],
            [503, "FRPS_DASHBOARD_UNREACHABLE"],
        ])("HTTP %s 映射为 %s", async (status, code) => {
            vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockResolvedValue(new Response("failure", { status })));
            await (0, vitest_1.expect)(service.listDashboardProxies(instance)).rejects.toMatchObject({
                code,
            });
        });
        (0, vitest_1.it)("网络错误不泄露原始外部错误", async () => {
            vitest_1.vi.stubGlobal("fetch", vitest_1.vi.fn().mockRejectedValue(new Error("secret upstream detail")));
            await (0, vitest_1.expect)(service.listDashboardProxies(instance)).rejects.toMatchObject({
                code: "FRPS_DASHBOARD_UNREACHABLE",
                message: "FRPS Dashboard 不可达",
            });
        });
    });
});
