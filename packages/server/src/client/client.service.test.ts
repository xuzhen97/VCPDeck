import { describe, expect, it, vi } from "vitest";
import { ClientService } from "./client.service.js";

const prismaMock = () => ({
	client: {
		upsert: vi.fn().mockResolvedValue({}),
		findMany: vi.fn().mockResolvedValue([]),
	},
});

describe("ClientService Pi capability details", () => {
	it("注册时持久化 capabilityDetails JSON", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await service.register(
			{
				clientId: "c1",
				hostname: "host",
				os: "win32",
				cpuModel: "cpu",
				totalMemMB: 1,
				clientVersion: "1",
				capabilities: ["agent.pi"],
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

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } }).client.upsert;
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

	it("无 capabilityDetails 时回退为 {}", async () => {
		const prisma = prismaMock() as never;
		const service = new ClientService(prisma);

		await service.register(
			{
				clientId: "c1",
				hostname: "host",
				os: "win32",
				cpuModel: "cpu",
				totalMemMB: 1,
				clientVersion: "1",
				capabilities: [],
			},
			"socket-1",
		);

		const upsert = (prisma as { client: { upsert: ReturnType<typeof vi.fn> } }).client.upsert;
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({ capabilityDetails: "{}" }),
			}),
		);
	});

	it("listOnline 安全解析 capabilityDetails", async () => {
		const prisma = {
			client: {
				upsert: vi.fn(),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "c1",
						hostname: "host",
						os: "win32",
						cpuModel: "cpu",
						totalMemMB: 1,
						clientVersion: "1",
						capabilities: '["agent.pi"]',
						capabilityDetails:
							'{"pi":{"available":true,"sdkVersion":"0.84.0","nodeVersion":"22.19.0","shellKind":"git-bash"}}',
						disks: "[]",
						online: true,
						cpuPercent: null,
						memPercent: null,
						lastHeartbeatAt: null,
					},
				]),
			},
		} as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails.pi).toMatchObject({ available: true });
		expect(client?.capabilityDetails.pi).toMatchObject({ sdkVersion: "0.84.0" });
	});

	it("listOnline 对损坏的 capabilityDetails 回退为 {}", async () => {
		const prisma = {
			client: {
				upsert: vi.fn(),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "c1",
						hostname: "host",
						os: "win32",
						cpuModel: "cpu",
						totalMemMB: 1,
						clientVersion: "1",
						capabilities: "[]",
						capabilityDetails: "{not-json",
						disks: "[]",
						online: true,
						cpuPercent: null,
						memPercent: null,
						lastHeartbeatAt: null,
					},
				]),
			},
		} as never;
		const service = new ClientService(prisma);

		const [client] = await service.listOnline();
		expect(client?.capabilityDetails).toEqual({});
	});
});
