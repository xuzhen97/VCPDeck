"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const frp_service_js_1 = require("./frp.service.js");
const instance = {
    id: "frps_1",
    name: "prod",
    serverAddr: "frps.example.com",
    serverPort: 7000,
    authToken: "secret",
    dashboardScheme: "https",
    dashboardHost: "dashboard.internal",
    dashboardPort: 7500,
    dashboardUser: "operator",
    dashboardPassword: "password",
    portRangeStart: 20000,
    portRangeEnd: 21000,
    isDefault: true,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
};
function mockPrisma() {
    const prisma = {
        client: { findUnique: vitest_1.vi.fn() },
        frpMapping: {
            findFirst: vitest_1.vi.fn(),
            findUnique: vitest_1.vi.fn(),
            findMany: vitest_1.vi.fn().mockResolvedValue([]),
            count: vitest_1.vi.fn(),
            create: vitest_1.vi.fn(),
            update: vitest_1.vi.fn(),
            updateMany: vitest_1.vi.fn(),
            delete: vitest_1.vi.fn(),
        },
        job: { create: vitest_1.vi.fn(), findUnique: vitest_1.vi.fn(), update: vitest_1.vi.fn() },
    };
    prisma.$transaction = vitest_1.vi.fn(async (work) => work(prisma));
    return prisma;
}
(0, vitest_1.describe)("FrpService createMapping", () => {
    let prisma;
    let instances;
    let service;
    (0, vitest_1.beforeEach)(() => {
        prisma = mockPrisma();
        prisma.client.findUnique.mockResolvedValue({
            id: "client-1",
            online: true,
            capabilities: '["frp"]',
        });
        instances = {
            getDefault: vitest_1.vi.fn().mockResolvedValue(instance),
            getById: vitest_1.vi.fn().mockResolvedValue(instance),
            listDashboardProxies: vitest_1.vi.fn().mockResolvedValue({
                total: 0,
                byType: { tcp: 0, http: 0, https: 0 },
                list: [],
                usedPorts: [],
            }),
        };
        service = new frp_service_js_1.FrpService(prisma, instances);
    });
    (0, vitest_1.it)("为 TCP 自动生成不重复名称并持久化 provisioning/operationJobId", async () => {
        let nameChecks = 0;
        prisma.frpMapping.findFirst.mockImplementation(async ({ where }) => {
            if (where.clientId)
                return null;
            nameChecks++;
            return nameChecks === 1 ? { id: "collision" } : null;
        });
        prisma.job.create.mockResolvedValue({});
        prisma.frpMapping.create.mockImplementation(async ({ data }) => ({
            ...data,
            createdAt: new Date("2026-08-24T00:00:00.000Z"),
            updatedAt: new Date("2026-08-24T00:00:00.000Z"),
        }));
        const result = await service.createMapping({
            clientId: "client-1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
        });
        (0, vitest_1.expect)(result.mapping.name).toMatch(/^tcp-1919-[a-f0-9]{6}$/);
        (0, vitest_1.expect)(result.mapping.status).toBe("provisioning");
        (0, vitest_1.expect)(result.mapping.operationJobId).toBe(result.dispatch.jobId);
        (0, vitest_1.expect)(prisma.$transaction).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(prisma.job.create).toHaveBeenCalledWith({
            data: vitest_1.expect.objectContaining({
                type: "frp.create",
                status: "running",
                startedAt: vitest_1.expect.any(Date),
                timeout: 30,
            }),
        });
    });
    (0, vitest_1.it)("自动名称的短后缀冲突时继续生成新后缀", async () => {
        instances.listDashboardProxies.mockResolvedValue({
            total: 1,
            byType: { tcp: 1, http: 0, https: 0 },
            list: [{ name: "tcp-1919", proxyType: "tcp", status: "online", remotePort: 20000 }],
            usedPorts: [20000],
        });
        let nameChecks = 0;
        prisma.frpMapping.findFirst.mockImplementation(async ({ where }) => {
            if (where.clientId)
                return null;
            nameChecks++;
            return nameChecks === 1 ? { id: "existing" } : null;
        });
        prisma.frpMapping.create.mockImplementation(async ({ data }) => ({
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
        }));
        const result = await service.createMapping({
            clientId: "client-1",
            proxyType: "tcp",
            localPort: 1919,
        });
        (0, vitest_1.expect)(result.mapping.name).toMatch(/^tcp-1919-[a-f0-9]{6}$/);
        (0, vitest_1.expect)(nameChecks).toBe(2);
        (0, vitest_1.expect)(prisma.frpMapping.findFirst).toHaveBeenLastCalledWith({
            where: { frpsInstanceId: "frps_1", name: result.mapping.name },
            select: { id: true },
        });
    });
    vitest_1.it.each(["http", "https"])("%s 不分配 remotePort，并使用 domain 构造 URL", async (proxyType) => {
        prisma.frpMapping.create.mockImplementation(async ({ data }) => ({
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
        }));
        const result = await service.createMapping({
            clientId: "client-1",
            name: `${proxyType}-app`,
            proxyType,
            localIp: "127.0.0.1",
            localPort: 8080,
            customDomain: "app.example.com",
        });
        (0, vitest_1.expect)(result.mapping.remotePort).toBeNull();
        (0, vitest_1.expect)(result.mapping.publicUrl).toBe(`${proxyType}://app.example.com`);
    });
    (0, vitest_1.it)("显式名称在 DB 或 Dashboard 重复时拒绝", async () => {
        prisma.frpMapping.findFirst.mockImplementation(async ({ where }) => where.clientId ? null : { id: "existing" });
        await (0, vitest_1.expect)(service.createMapping({
            clientId: "client-1",
            name: "api",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
        })).rejects.toMatchObject({ code: "FRP_PROXY_NAME_CONFLICT" });
    });
    (0, vitest_1.it)("拒绝同一 Client 跨 FRPS 实例运行", async () => {
        prisma.frpMapping.findFirst.mockResolvedValue({ frpsInstanceId: "frps_2" });
        await (0, vitest_1.expect)(service.createMapping({
            clientId: "client-1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
        })).rejects.toThrow("同一 Client");
    });
    (0, vitest_1.it)("Client 创建完成且 Dashboard 出现 proxy 后收敛为 active", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "create-job",
            clientId: "client-1",
            type: "frp.create",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 30,
        });
        instances.listDashboardProxies.mockResolvedValue({
            total: 1,
            byType: { tcp: 1, http: 0, https: 0 },
            list: [{ name: "tcp-1919", proxyType: "tcp", status: "online", remotePort: 20000 }],
            usedPorts: [20000],
        });
        const outcome = await service.settleClientOperation("create-job", "frp.create");
        (0, vitest_1.expect)(outcome).toMatchObject({
            terminal: true,
            result: { mappingId: "fm_1", status: "active" },
        });
        (0, vitest_1.expect)(prisma.frpMapping.update).toHaveBeenCalledWith({
            where: { id: "fm_1" },
            data: vitest_1.expect.objectContaining({ status: "active", errorCode: null }),
        });
    });
    (0, vitest_1.it)("创建确认时 Dashboard 不可达也进入回滚", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "create-job",
            clientId: "client-1",
            type: "frp.create",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 0,
        });
        instances.listDashboardProxies.mockRejectedValue(Object.assign(new Error("FRPS Dashboard 不可达"), {
            code: "FRPS_DASHBOARD_UNREACHABLE",
        }));
        await (0, vitest_1.expect)(service.settleClientOperation("create-job", "frp.create")).resolves.toMatchObject({
            terminal: false,
            dispatch: { type: "frp.delete" },
        });
        (0, vitest_1.expect)(prisma.frpMapping.update).toHaveBeenCalledWith({
            where: { id: "fm_1" },
            data: vitest_1.expect.objectContaining({
                errorCode: "FRPS_DASHBOARD_UNREACHABLE",
                errorMessage: "FRPS Dashboard 不可达",
            }),
        });
    });
    (0, vitest_1.it)("创建确认超时后创建回滚 Job，原 Job 保持运行", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "create-job",
            clientId: "client-1",
            type: "frp.create",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 0,
        });
        const outcome = await service.settleClientOperation("create-job", "frp.create");
        (0, vitest_1.expect)(outcome).toMatchObject({
            terminal: false,
            dispatch: { type: "frp.delete", clientId: "client-1" },
        });
        (0, vitest_1.expect)(prisma.job.create).toHaveBeenCalledWith({
            data: vitest_1.expect.objectContaining({
                type: "frp.delete",
                payload: vitest_1.expect.stringContaining('"rollbackOfJobId":"create-job"'),
            }),
        });
    });
    (0, vitest_1.it)("删除离线 Client 时不创建 Job、不改变 mapping", async () => {
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            name: "tcp-1919",
        });
        prisma.client.findUnique.mockResolvedValue({ id: "client-1", online: false });
        await (0, vitest_1.expect)(service.deleteMapping("fm_1", 30)).rejects.toThrow("不在线");
        (0, vitest_1.expect)(prisma.$transaction).not.toHaveBeenCalled();
        (0, vitest_1.expect)(prisma.job.create).not.toHaveBeenCalled();
        (0, vitest_1.expect)(prisma.frpMapping.update).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("删除先进入 deleting，不提前删除记录", async () => {
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
            remotePort: 20000,
            customDomain: null,
            status: "active",
            publicUrl: "frps.example.com:20000",
            operationJobId: null,
            errorCode: null,
            errorMessage: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        prisma.frpMapping.update.mockImplementation(async ({ data }) => ({
            ...(await prisma.frpMapping.findUnique()),
            ...data,
        }));
        const result = await service.deleteMapping("fm_1", 45);
        (0, vitest_1.expect)(result?.mapping.status).toBe("deleting");
        (0, vitest_1.expect)(result?.mapping.operationJobId).toBe(result?.dispatch.jobId);
        (0, vitest_1.expect)(prisma.frpMapping.delete).not.toHaveBeenCalled();
        (0, vitest_1.expect)(prisma.$transaction).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(prisma.job.create).toHaveBeenCalledWith({
            data: vitest_1.expect.objectContaining({
                type: "frp.delete",
                status: "running",
                startedAt: vitest_1.expect.any(Date),
                timeout: 45,
            }),
        });
    });
    (0, vitest_1.it)("普通删除在 Dashboard 确认消失后才删除记录", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "delete-job",
            clientId: "client-1",
            type: "frp.delete",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 30,
        });
        const outcome = await service.settleClientOperation("delete-job", "frp.delete");
        (0, vitest_1.expect)(outcome).toEqual({
            terminal: true,
            result: { mappingId: "fm_1", deleted: true },
        });
        (0, vitest_1.expect)(prisma.frpMapping.delete).toHaveBeenCalledWith({
            where: { id: "fm_1" },
        });
    });
    (0, vitest_1.it)("普通删除确认时 Dashboard 不可达，保留 error 记录", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "delete-job",
            clientId: "client-1",
            type: "frp.delete",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 0,
        });
        instances.listDashboardProxies.mockRejectedValue(Object.assign(new Error("FRPS Dashboard 不可达"), {
            code: "FRPS_DASHBOARD_UNREACHABLE",
        }));
        await (0, vitest_1.expect)(service.settleClientOperation("delete-job", "frp.delete")).resolves.toMatchObject({
            terminal: true,
            errorCode: "FRPS_DASHBOARD_UNREACHABLE",
            errorMessage: "FRPS Dashboard 不可达",
        });
        (0, vitest_1.expect)(prisma.frpMapping.update).toHaveBeenCalledWith({
            where: { id: "fm_1" },
            data: vitest_1.expect.objectContaining({ status: "error" }),
        });
    });
    (0, vitest_1.it)("普通删除确认超时保留 error，之后允许重试", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "delete-job",
            clientId: "client-1",
            type: "frp.delete",
            payload: JSON.stringify({ mappingId: "fm_1", name: "tcp-1919" }),
        });
        const mapping = {
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 0,
        };
        prisma.frpMapping.findUnique.mockResolvedValue(mapping);
        instances.listDashboardProxies.mockResolvedValue({
            total: 1,
            byType: { tcp: 1, http: 0, https: 0 },
            list: [{ name: "tcp-1919", proxyType: "tcp", status: "online", remotePort: 20000 }],
            usedPorts: [20000],
        });
        const outcome = await service.settleClientOperation("delete-job", "frp.delete");
        (0, vitest_1.expect)(outcome).toMatchObject({
            terminal: true,
            errorCode: "FRP_PROXY_REMOVE_TIMEOUT",
        });
        (0, vitest_1.expect)(prisma.frpMapping.update).toHaveBeenCalledWith({
            where: { id: "fm_1" },
            data: vitest_1.expect.objectContaining({
                status: "error",
                errorCode: "FRP_PROXY_REMOVE_TIMEOUT",
            }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            ...mapping,
            localIp: "127.0.0.1",
            localPort: 1919,
            remotePort: 20000,
            customDomain: null,
            status: "error",
            publicUrl: "frps.example.com:20000",
            operationJobId: null,
            errorCode: "FRP_PROXY_REMOVE_TIMEOUT",
            errorMessage: "timeout",
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        prisma.frpMapping.update.mockImplementation(async ({ data }) => ({
            ...(await prisma.frpMapping.findUnique()),
            ...data,
        }));
        await (0, vitest_1.expect)(service.deleteMapping("fm_1", 30)).resolves.not.toBeNull();
    });
    (0, vitest_1.it)("Client 创建失败后回滚成功保留原始错误码", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "rollback-job",
            clientId: "client-1",
            type: "frp.delete",
            payload: JSON.stringify({
                mappingId: "fm_1",
                name: "tcp-1919",
                rollbackOfJobId: "create-job",
            }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 30,
            errorCode: "FRPC_START_FAILED",
            errorMessage: "frpc 启动失败",
        });
        await (0, vitest_1.expect)(service.settleClientOperation("rollback-job", "frp.delete")).resolves.toMatchObject({
            relatedJob: {
                jobId: "create-job",
                errorCode: "FRPC_START_FAILED",
                errorMessage: "frpc 启动失败",
            },
        });
    });
    (0, vitest_1.it)("回滚确认失败时保留 error 映射并终结原创建 Job", async () => {
        prisma.job.findUnique.mockResolvedValue({
            id: "rollback-job",
            clientId: "client-1",
            type: "frp.delete",
            payload: JSON.stringify({
                mappingId: "fm_1",
                name: "tcp-1919",
                rollbackOfJobId: "create-job",
            }),
        });
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            frpsInstanceId: "frps_1",
            name: "tcp-1919",
            proxyType: "tcp",
            operationTimeoutSeconds: 0,
        });
        instances.listDashboardProxies.mockResolvedValue({
            total: 1,
            byType: { tcp: 1, http: 0, https: 0 },
            list: [{ name: "tcp-1919", proxyType: "tcp", status: "online", remotePort: 20000 }],
            usedPorts: [20000],
        });
        const outcome = await service.settleClientOperation("rollback-job", "frp.delete");
        (0, vitest_1.expect)(outcome).toMatchObject({
            terminal: true,
            errorCode: "FRP_ROLLBACK_FAILED",
            relatedJob: {
                jobId: "create-job",
                errorCode: "FRP_ROLLBACK_FAILED",
            },
        });
        (0, vitest_1.expect)(prisma.frpMapping.update).toHaveBeenCalledWith({
            where: { id: "fm_1" },
            data: vitest_1.expect.objectContaining({
                status: "error",
                errorCode: "FRP_ROLLBACK_FAILED",
            }),
        });
    });
});
(0, vitest_1.describe)("FrpService 恢复周期写互斥", () => {
    function mockPrisma() {
        const prisma = {
            client: { findUnique: vitest_1.vi.fn() },
            frpMapping: {
                findFirst: vitest_1.vi.fn(),
                findUnique: vitest_1.vi.fn(),
                findMany: vitest_1.vi.fn().mockResolvedValue([]),
                count: vitest_1.vi.fn(),
                create: vitest_1.vi.fn(),
                update: vitest_1.vi.fn(),
                updateMany: vitest_1.vi.fn(),
                delete: vitest_1.vi.fn(),
            },
            job: { create: vitest_1.vi.fn(), findUnique: vitest_1.vi.fn(), update: vitest_1.vi.fn() },
        };
        prisma.$transaction = vitest_1.vi.fn(async (work) => work(prisma));
        return prisma;
    }
    function busyGuard() {
        const assertWritable = vitest_1.vi.fn(() => {
            const error = Object.assign(new Error("FRP 映射正在恢复"), {
                code: "FRP_RECONCILE_BUSY",
                statusCode: 409,
            });
            throw error;
        });
        return { assertWritable };
    }
    (0, vitest_1.it)("createMapping 在恢复周期内抛 FRP_RECONCILE_BUSY / 409", async () => {
        const prisma = mockPrisma();
        const instances = {
            getDefault: vitest_1.vi.fn(),
            getById: vitest_1.vi.fn(),
            listDashboardProxies: vitest_1.vi.fn(),
        };
        const service = new frp_service_js_1.FrpService(prisma, instances, busyGuard());
        await (0, vitest_1.expect)(service.createMapping({
            clientId: "client-1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
        })).rejects.toMatchObject({ code: "FRP_RECONCILE_BUSY", statusCode: 409 });
        (0, vitest_1.expect)(prisma.job.create).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("deleteMapping 在恢复周期内抛 FRP_RECONCILE_BUSY / 409", async () => {
        const prisma = mockPrisma();
        prisma.frpMapping.findUnique.mockResolvedValue({
            id: "fm_1",
            clientId: "client-1",
            name: "tcp-1919",
            status: "active",
        });
        const instances = {
            getDefault: vitest_1.vi.fn(),
            getById: vitest_1.vi.fn(),
            listDashboardProxies: vitest_1.vi.fn(),
        };
        const service = new frp_service_js_1.FrpService(prisma, instances, busyGuard());
        await (0, vitest_1.expect)(service.deleteMapping("fm_1")).rejects.toMatchObject({
            code: "FRP_RECONCILE_BUSY",
            statusCode: 409,
        });
        (0, vitest_1.expect)(prisma.job.create).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("未注入 reconciliation service 时行为不变（兼容旧构造）", async () => {
        const prisma = mockPrisma();
        prisma.client.findUnique.mockResolvedValue({
            id: "client-1",
            online: true,
            capabilities: '["frp"]',
        });
        const instances = {
            getDefault: vitest_1.vi.fn().mockResolvedValue(instance),
            getById: vitest_1.vi.fn().mockResolvedValue(instance),
            listDashboardProxies: vitest_1.vi.fn().mockResolvedValue({
                total: 0,
                byType: { tcp: 0, http: 0, https: 0 },
                list: [],
                usedPorts: [],
            }),
        };
        prisma.frpMapping.create.mockImplementation(async ({ data }) => ({
            ...data,
            createdAt: new Date("2026-08-24T00:00:00.000Z"),
            updatedAt: new Date("2026-08-24T00:00:00.000Z"),
        }));
        const service = new frp_service_js_1.FrpService(prisma, instances);
        await (0, vitest_1.expect)(service.createMapping({
            clientId: "client-1",
            proxyType: "tcp",
            localIp: "127.0.0.1",
            localPort: 1919,
        })).resolves.toMatchObject({ dispatch: { type: "frp.create" } });
    });
});
