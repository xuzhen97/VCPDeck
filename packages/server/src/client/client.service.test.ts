import { describe, expect, it, vi } from "vitest";
import { ClientService } from "./client.service.js";

/** 构造 Prisma mock：register 流程（findUnique → findFirst → upsert）与 rename 流程（findFirst → update） */
const prismaMock = (overrides: Record<string, unknown> = {}) => ({
	client: {
		findUnique: vi.fn().mockResolvedValue(null),
		findFirst: vi.fn().mockResolvedValue(null),
		upsert: vi.fn().mockResolvedValue({}),
		update: vi.fn().mockResolvedValue({}),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		findMany: vi.fn().mockResolvedValue([]),
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
	capabilities: [] as string[],
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

describe("ClientService 别名注册", () => {
	it("新机器注册时以 hostname 作为别名", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await service.register(registerDto, "socket-1");

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ name: "host" }),
			}),
		);
	});

	it("hostname 重名时自动追加 _1 后缀保证唯一", async () => {
		const findFirst = vi
			.fn()
			.mockResolvedValueOnce({ id: "c-other" }) // "host" 被占用
			.mockResolvedValue(null); // "host_1" 可用
		const prisma = prismaMock({ findFirst }) as never;
		const service = new ClientService(prisma);

		await service.register(registerDto, "socket-1");

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ name: "host_1" }),
			}),
		);
	});

	it("已有别名的机器重连不覆盖别名", async () => {
		const findUnique = vi.fn().mockResolvedValue({ name: "my-nas" });
		const prisma = prismaMock({ findUnique }) as never;
		const service = new ClientService(prisma);

		await service.register(registerDto, "socket-1");

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		const update = (upsert.mock.calls[0][0] as { update: object }).update;
		expect(update).not.toHaveProperty("name");
	});

	it("迁移前的旧记录（name 为 null）重连时补齐唯一别名", async () => {
		const findUnique = vi.fn().mockResolvedValue({ name: null });
		const prisma = prismaMock({ findUnique }) as never;
		const service = new ClientService(prisma);

		await service.register(registerDto, "socket-1");

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		const update = (upsert.mock.calls[0][0] as { update: object }).update;
		expect(update).toMatchObject({ name: "host" });
	});

	it("注册时持久化 capabilityDetails JSON", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await service.register(
			{
				...registerDto,
				capabilityDetails: {
					pi: {
						available: true,
						sdkVersion: "0.84.0",
						nodeVersion: "22.19.0",
						shellKind: "git-bash",
					},
				},
			},
			"socket-1",
		);

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					capabilityDetails: expect.stringContaining('"sdkVersion":"0.84.0"'),
				}),
				update: expect.objectContaining({
					capabilityDetails: expect.stringContaining('"shellKind":"git-bash"'),
				}),
			}),
		);
	});
});

describe("ClientService rename", () => {
	it("改名成功并返回更新后的 ClientInfo", async () => {
		const update = vi.fn().mockResolvedValue({ ...clientRow, name: "new-name" });
		const prisma = prismaMock({ update }) as never;
		const service = new ClientService(prisma);

		const result = await service.rename("c1", "new-name");

		expect(result).toMatchObject({ clientId: "c1", name: "new-name" });
		expect(update).toHaveBeenCalledWith({
			where: { id: "c1" },
			data: { name: "new-name" },
		});
	});

	it("改名为已存在的别名时拒绝并抛 CLIENT_NAME_TAKEN", async () => {
		const update = vi.fn();
		const findFirst = vi.fn().mockResolvedValue({ id: "c2" });
		const prisma = prismaMock({ findFirst, update }) as never;
		const service = new ClientService(prisma);

		await expect(service.rename("c1", "c2-name")).rejects.toMatchObject({
			code: "CLIENT_NAME_TAKEN",
			statusCode: 409,
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("别名不能为空白字符串", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await expect(service.rename("c1", "   ")).rejects.toMatchObject({
			code: "INVALID_CLIENT_NAME",
			statusCode: 400,
		});
	});

	it("目标客户端不存在时抛 CLIENT_NOT_FOUND", async () => {
		const update = vi.fn().mockRejectedValue({ code: "P2025" });
		const prisma = prismaMock({ update }) as never;
		const service = new ClientService(prisma);

		await expect(service.rename("ghost", "name")).rejects.toMatchObject({
			code: "CLIENT_NOT_FOUND",
			statusCode: 404,
		});
	});
});

describe("ClientService heartbeat liveness", () => {
	it("超过 30 秒未收到心跳的在线 Client 被标记离线", async () => {
		const findMany = vi.fn().mockResolvedValue([
			{ id: "c1", socketId: "socket-1" },
		]);
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = prismaMock({ findMany, updateMany }) as never;
		const service = new ClientService(prisma);

		await expect(
			service.expireStaleClients(new Date("2026-08-26T09:35:08.000Z")),
		).resolves.toEqual([{ clientId: "c1", socketId: "socket-1" }]);
		expect(findMany).toHaveBeenCalledWith({
			where: {
				online: true,
				OR: [
					{ lastHeartbeatAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
					{ lastHeartbeatAt: null, connectedAt: { lt: new Date("2026-08-26T09:34:38.000Z") } },
				],
			},
			select: { id: true, socketId: true },
		});
		expect(updateMany).toHaveBeenCalledWith({
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

	it("注册和状态重绑刷新存活基线", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await service.register(registerDto, "socket-1");
		await service.bindSocket("c1", "socket-2");

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } })
			.client.upsert;
		const update = (prisma as { client: { update: ReturnType<typeof vi.fn> } })
			.client.update;
		expect(upsert.mock.calls[0]?.[0].create).toEqual(
			expect.objectContaining({ lastHeartbeatAt: expect.any(Date) }),
		);
		expect(update).toHaveBeenCalledWith({
			where: { id: "c1" },
			data: expect.objectContaining({ lastHeartbeatAt: expect.any(Date) }),
		});
	});
});

describe("ClientService listOnline", () => {
	it("name 为 null 时回退 hostname", async () => {
		const findMany = vi
			.fn()
			.mockResolvedValue([{ ...clientRow, name: null }]);
		const prisma = prismaMock({ findMany }) as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.name).toBe("host");
	});

	it("listOnline 安全解析 capabilityDetails", async () => {
		const findMany = vi.fn().mockResolvedValue([
			{
				...clientRow,
				capabilityDetails:
					'{"pi":{"available":true,"sdkVersion":"0.84.0","nodeVersion":"22.19.0","shellKind":"git-bash"}}',
			},
		]);
		const prisma = prismaMock({ findMany }) as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails.pi).toMatchObject({ available: true });
		expect(client?.capabilityDetails.pi).toMatchObject({
			sdkVersion: "0.84.0",
		});
	});

	it("listOnline 对损坏的 capabilityDetails 回退为 {}", async () => {
		const findMany = vi
			.fn()
			.mockResolvedValue([{ ...clientRow, capabilityDetails: "{not-json" }]);
		const prisma = prismaMock({ findMany }) as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails).toEqual({});
	});

	it("listOnline 安全投影 frp capability 详情（protocol v1）", async () => {
		const findMany = vi.fn().mockResolvedValue([
			{
				...clientRow,
				capabilityDetails: JSON.stringify({
					frp: { available: true, reconcileProtocolVersion: 1 },
				}),
			},
		]);
		const prisma = prismaMock({ findMany }) as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails.frp).toEqual({
			available: true,
			reconcileProtocolVersion: 1,
		});
	});

	it("frp 能力详情损坏时省略 frp 字段但保留其余详情", async () => {
		const findMany = vi.fn().mockResolvedValue([
			{
				...clientRow,
				capabilityDetails: JSON.stringify({
					pi: { available: true, sdkVersion: "0.84.0" },
					frp: { available: "yes" },
				}),
			},
		]);
		const prisma = prismaMock({ findMany }) as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails.pi).toMatchObject({ available: true });
		expect(client?.capabilityDetails.frp).toBeUndefined();
	});
});
