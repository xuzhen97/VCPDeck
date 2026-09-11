"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const client_service_js_1 = require("./client.service.js");
/** 构造 Prisma mock：register 流程（findUnique → findFirst → upsert）与 rename 流程（findFirst → update） */
const prismaMock = (overrides = {}) => ({
    client: {
        findUnique: vitest_1.vi.fn().mockResolvedValue(null),
        findFirst: vitest_1.vi.fn().mockResolvedValue(null),
        upsert: vitest_1.vi.fn().mockResolvedValue({}),
        update: vitest_1.vi.fn().mockResolvedValue({}),
        updateMany: vitest_1.vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vitest_1.vi.fn().mockResolvedValue([]),
        ...overrides,
    },
});
const registerDto = {
    clientId: "c1",
    hostname: "host",
    os: "win32",
    cpuModel: "cpu",
    totalMemMB: 1,
    clientVersion: "1",
    capabilities: [],
};
const clientRow = {
    id: "c1",
    name: "host",
    hostname: "host",
    os: "win32",
    cpuModel: "cpu",
    totalMemMB: 1,
    clientVersion: "1",
    capabilities: "[]",
    capabilityDetails: "{}",
    disks: "[]",
    online: true,
    cpuPercent: null,
    memPercent: null,
    lastHeartbeatAt: null,
};
(0, vitest_1.describe)("ClientService 别名注册", () => {
    (0, vitest_1.it)("新机器注册时以 hostname 作为别名", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(registerDto, "socket-1");
        const upsert = prisma
            .client.upsert;
        (0, vitest_1.expect)(upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            create: vitest_1.expect.objectContaining({ name: "host" }),
        }));
    });
    (0, vitest_1.it)("hostname 重名时自动追加 _1 后缀保证唯一", async () => {
        const findFirst = vitest_1.vi
            .fn()
            .mockResolvedValueOnce({ id: "c-other" }) // "host" 被占用
            .mockResolvedValue(null); // "host_1" 可用
        const prisma = prismaMock({ findFirst });
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(registerDto, "socket-1");
        const upsert = prisma
            .client.upsert;
        (0, vitest_1.expect)(upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            create: vitest_1.expect.objectContaining({ name: "host_1" }),
        }));
    });
    (0, vitest_1.it)("已有别名的机器重连不覆盖别名", async () => {
        const findUnique = vitest_1.vi.fn().mockResolvedValue({ name: "my-nas" });
        const prisma = prismaMock({ findUnique });
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(registerDto, "socket-1");
        const upsert = prisma
            .client.upsert;
        const update = upsert.mock.calls[0][0].update;
        (0, vitest_1.expect)(update).not.toHaveProperty("name");
    });
    (0, vitest_1.it)("迁移前的旧记录（name 为 null）重连时补齐唯一别名", async () => {
        const findUnique = vitest_1.vi.fn().mockResolvedValue({ name: null });
        const prisma = prismaMock({ findUnique });
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(registerDto, "socket-1");
        const upsert = prisma
            .client.upsert;
        const update = upsert.mock.calls[0][0].update;
        (0, vitest_1.expect)(update).toMatchObject({ name: "host" });
    });
    (0, vitest_1.it)("注册时持久化 capabilityDetails JSON", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        await service.register({
            ...registerDto,
            capabilityDetails: {
                pi: {
                    available: true,
                    sdkVersion: "0.84.0",
                    nodeVersion: "22.19.0",
                    shellKind: "git-bash",
                },
            },
        }, "socket-1");
        const upsert = prisma
            .client.upsert;
        (0, vitest_1.expect)(upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            create: vitest_1.expect.objectContaining({
                capabilityDetails: vitest_1.expect.stringContaining('"sdkVersion":"0.84.0"'),
            }),
            update: vitest_1.expect.objectContaining({
                capabilityDetails: vitest_1.expect.stringContaining('"shellKind":"git-bash"'),
            }),
        }));
    });
});
(0, vitest_1.describe)("ClientService rename", () => {
    (0, vitest_1.it)("改名成功并返回更新后的 ClientInfo", async () => {
        const update = vitest_1.vi.fn().mockResolvedValue({ ...clientRow, name: "new-name" });
        const prisma = prismaMock({ update });
        const service = new client_service_js_1.ClientService(prisma);
        const result = await service.rename("c1", "new-name");
        (0, vitest_1.expect)(result).toMatchObject({ clientId: "c1", name: "new-name" });
        (0, vitest_1.expect)(update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { name: "new-name" },
        });
    });
    (0, vitest_1.it)("改名为已存在的别名时拒绝并抛 CLIENT_NAME_TAKEN", async () => {
        const update = vitest_1.vi.fn();
        const findFirst = vitest_1.vi.fn().mockResolvedValue({ id: "c2" });
        const prisma = prismaMock({ findFirst, update });
        const service = new client_service_js_1.ClientService(prisma);
        await (0, vitest_1.expect)(service.rename("c1", "c2-name")).rejects.toMatchObject({
            code: "CLIENT_NAME_TAKEN",
            statusCode: 409,
        });
        (0, vitest_1.expect)(update).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("别名不能为空白字符串", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        await (0, vitest_1.expect)(service.rename("c1", "   ")).rejects.toMatchObject({
            code: "INVALID_CLIENT_NAME",
            statusCode: 400,
        });
    });
    (0, vitest_1.it)("目标客户端不存在时抛 CLIENT_NOT_FOUND", async () => {
        const update = vitest_1.vi.fn().mockRejectedValue({ code: "P2025" });
        const prisma = prismaMock({ update });
        const service = new client_service_js_1.ClientService(prisma);
        await (0, vitest_1.expect)(service.rename("ghost", "name")).rejects.toMatchObject({
            code: "CLIENT_NOT_FOUND",
            statusCode: 404,
        });
    });
});
(0, vitest_1.describe)("ClientService heartbeat liveness", () => {
    (0, vitest_1.it)("超过 30 秒未收到心跳的在线 Client 被标记离线", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            { id: "c1", socketId: "socket-1" },
        ]);
        const updateMany = vitest_1.vi.fn().mockResolvedValue({ count: 1 });
        const prisma = prismaMock({ findMany, updateMany });
        const service = new client_service_js_1.ClientService(prisma);
        await (0, vitest_1.expect)(service.expireStaleClients(new Date("2026-08-26T09:35:08.000Z"))).resolves.toEqual([{ clientId: "c1", socketId: "socket-1" }]);
        (0, vitest_1.expect)(findMany).toHaveBeenCalledWith({
            where: {
                online: true,
                OR: [
                    { lastHeartbeatAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
                    { lastHeartbeatAt: null, connectedAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
                ],
            },
            select: { id: true, socketId: true },
        });
        (0, vitest_1.expect)(updateMany).toHaveBeenCalledWith({
            where: {
                id: "c1",
                online: true,
                socketId: "socket-1",
                OR: [
                    { lastHeartbeatAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
                    { lastHeartbeatAt: null, connectedAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
                ],
            },
            data: { online: false, socketId: null },
        });
    });
    (0, vitest_1.it)("注册和状态重绑刷新存活基线", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(registerDto, "socket-1");
        await service.bindSocket("c1", "socket-2");
        const upsert = prisma
            .client.upsert;
        const update = prisma
            .client.update;
        (0, vitest_1.expect)(upsert.mock.calls[0]?.[0].create).toEqual(vitest_1.expect.objectContaining({ lastHeartbeatAt: vitest_1.expect.any(Date) }));
        (0, vitest_1.expect)(update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: vitest_1.expect.objectContaining({ lastHeartbeatAt: vitest_1.expect.any(Date) }),
        });
    });
});
(0, vitest_1.describe)("ClientService ADR-0023 安装/特权摘要", () => {
    const a2Register = {
        ...registerDto,
        capabilityDetails: {
            privileged: {
                available: true,
                mode: "sudo-all",
                nonInteractive: true,
                runAsUser: "vcpdeck",
            },
        },
        installation: { mode: "systemd-root-equivalent" },
    };
    (0, vitest_1.it)("注册时持久化 privileged 与 installation 到 capabilityDetails 存储", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        await service.register(a2Register, "socket-1");
        const upsert = prisma
            .client.upsert;
        (0, vitest_1.expect)(upsert).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            create: vitest_1.expect.objectContaining({
                capabilityDetails: vitest_1.expect.stringContaining('"runAsUser":"vcpdeck"'),
            }),
        }));
        const blob = JSON.parse(upsert.mock.calls[0][0].create
            .capabilityDetails);
        (0, vitest_1.expect)(blob.installation).toEqual({ mode: "systemd-root-equivalent" });
    });
    (0, vitest_1.it)("listOnline 严格投影 privileged 与 installation", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            {
                ...clientRow,
                capabilityDetails: JSON.stringify({
                    privileged: {
                        available: true,
                        mode: "sudo-all",
                        nonInteractive: true,
                        runAsUser: "vcpdeck",
                    },
                    installation: { mode: "systemd-root-equivalent" },
                }),
            },
        ]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails.privileged).toEqual({
            available: true,
            mode: "sudo-all",
            nonInteractive: true,
            runAsUser: "vcpdeck",
        });
        (0, vitest_1.expect)(client?.installation).toEqual({ mode: "systemd-root-equivalent" });
    });
    (0, vitest_1.it)("旧 Client 未报告时省略 installation 与 privileged（不推断）", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.installation).toBeUndefined();
        (0, vitest_1.expect)(client?.capabilityDetails.privileged).toBeUndefined();
    });
    (0, vitest_1.it)("privileged 摘要损坏时省略该字段但保留其余详情", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            {
                ...clientRow,
                capabilityDetails: JSON.stringify({
                    privileged: { available: "yes" },
                    installation: { mode: "pm2" },
                }),
            },
        ]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails.privileged).toBeUndefined();
        (0, vitest_1.expect)(client?.installation).toBeUndefined();
    });
    (0, vitest_1.it)("getInstallerStatus 投影 installationMode 与 nonInteractiveSudo", async () => {
        const findUnique = vitest_1.vi.fn().mockResolvedValue({
            ...clientRow,
            name: "nas",
            capabilityDetails: JSON.stringify({
                privileged: {
                    available: true,
                    mode: "sudo-all",
                    nonInteractive: true,
                    runAsUser: "vcpdeck",
                },
                installation: { mode: "systemd-root-equivalent" },
            }),
        });
        const prisma = prismaMock({ findUnique });
        const service = new client_service_js_1.ClientService(prisma);
        const status = await service.getInstallerStatus("c1");
        (0, vitest_1.expect)(status.installationMode).toBe("systemd-root-equivalent");
        (0, vitest_1.expect)(status.nonInteractiveSudo).toBe(true);
    });
    (0, vitest_1.it)("getInstallerStatus 对未报告的旧 Client 返回 null 摘要", async () => {
        const findUnique = vitest_1.vi.fn().mockResolvedValue({ ...clientRow, name: "nas" });
        const prisma = prismaMock({ findUnique });
        const service = new client_service_js_1.ClientService(prisma);
        const status = await service.getInstallerStatus("c1");
        (0, vitest_1.expect)(status.installationMode).toBeNull();
        (0, vitest_1.expect)(status.nonInteractiveSudo).toBeNull();
    });
    (0, vitest_1.it)("getInstallerStatus 对未注册 Client 返回未注册且 null 摘要", async () => {
        const prisma = prismaMock();
        const service = new client_service_js_1.ClientService(prisma);
        const status = await service.getInstallerStatus("ghost");
        (0, vitest_1.expect)(status.registered).toBe(false);
        (0, vitest_1.expect)(status.installationMode).toBeNull();
        (0, vitest_1.expect)(status.nonInteractiveSudo).toBeNull();
    });
});
(0, vitest_1.describe)("ClientService listOnline", () => {
    (0, vitest_1.it)("name 为 null 时回退 hostname", async () => {
        const findMany = vitest_1.vi
            .fn()
            .mockResolvedValue([{ ...clientRow, name: null }]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.name).toBe("host");
    });
    (0, vitest_1.it)("listOnline 安全解析 capabilityDetails", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            {
                ...clientRow,
                capabilityDetails: '{"pi":{"available":true,"sdkVersion":"0.84.0","nodeVersion":"22.19.0","shellKind":"git-bash"}}',
            },
        ]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails.pi).toMatchObject({ available: true });
        (0, vitest_1.expect)(client?.capabilityDetails.pi).toMatchObject({
            sdkVersion: "0.84.0",
        });
    });
    (0, vitest_1.it)("listOnline 对损坏的 capabilityDetails 回退为 {}", async () => {
        const findMany = vitest_1.vi
            .fn()
            .mockResolvedValue([{ ...clientRow, capabilityDetails: "{not-json" }]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails).toEqual({});
    });
    (0, vitest_1.it)("listOnline 安全投影 frp capability 详情（protocol v1）", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            {
                ...clientRow,
                capabilityDetails: JSON.stringify({
                    frp: { available: true, reconcileProtocolVersion: 1 },
                }),
            },
        ]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails.frp).toEqual({
            available: true,
            reconcileProtocolVersion: 1,
        });
    });
    (0, vitest_1.it)("frp 能力详情损坏时省略 frp 字段但保留其余详情", async () => {
        const findMany = vitest_1.vi.fn().mockResolvedValue([
            {
                ...clientRow,
                capabilityDetails: JSON.stringify({
                    pi: { available: true, sdkVersion: "0.84.0" },
                    frp: { available: "yes" },
                }),
            },
        ]);
        const prisma = prismaMock({ findMany });
        const service = new client_service_js_1.ClientService(prisma);
        const [client] = await service.listOnline();
        (0, vitest_1.expect)(client?.capabilityDetails.pi).toMatchObject({ available: true });
        (0, vitest_1.expect)(client?.capabilityDetails.frp).toBeUndefined();
    });
});
