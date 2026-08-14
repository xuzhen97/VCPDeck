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
});
