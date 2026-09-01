import { describe, it, expect, vi, beforeEach } from "vitest";
import { FrpsInstancesService } from "./frp-instances.service.js";

function mockPrisma() {
	return {
		frpsInstance: {
			create: vi.fn(),
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			findMany: vi.fn(),
			count: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			updateMany: vi.fn(),
		},
		frpMapping: {
			count: vi.fn(),
		},
	} as any;
}

describe("FrpsInstancesService", () => {
	let service: FrpsInstancesService;
	let prisma: ReturnType<typeof mockPrisma>;

	beforeEach(() => {
		prisma = mockPrisma();
		service = new FrpsInstancesService(prisma);
	});

	describe("create", () => {
		it("should create an instance with defaults", async () => {
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
			expect(result.name).toBe("test");
			expect(result.id).toMatch(/^frps_/);
		});

		it("should clear other defaults when isDefault=true", async () => {
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
			expect(prisma.frpsInstance.updateMany).toHaveBeenCalledWith({
				where: { isDefault: true },
				data: { isDefault: false },
			});
			expect(result.isDefault).toBe(true);
		});
	});

	describe("delete", () => {
		it("should reject when mappings exist", async () => {
			prisma.frpsInstance.findUnique.mockResolvedValue({
				id: "frps_abc",
				name: "test",
			});
			prisma.frpMapping.count.mockResolvedValue(3);
			await expect(service.delete("frps_abc")).rejects.toThrow("3 个映射");
		});

		it("should delete when no mappings", async () => {
			prisma.frpMapping.count.mockResolvedValue(0);
			prisma.frpsInstance.findUnique.mockResolvedValue({
				id: "frps_abc",
			});
			prisma.frpsInstance.delete.mockResolvedValue({});
			const result = await service.delete("frps_abc");
			expect(result).toBe(true);
		});
	});

	describe("migrateFromEnvIfNeeded", () => {
		it("should skip if instances exist", async () => {
			prisma.frpsInstance.count.mockResolvedValue(1);
			const result = await service.migrateFromEnvIfNeeded();
			expect(result).toBeNull();
		});

		it("should create default from env when none exist", async () => {
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
			expect(result).not.toBeNull();
			expect(result!.name).toBe("默认（从环境变量迁移）");
			expect(result!.serverPort).toBe(17000);
			expect(result!.authToken).toBe("test-frp-token");
			expect(result!.dashboardHost).toBe("127.0.0.1");
			expect(prisma.frpsInstance.create).toHaveBeenCalled();
		});
	});

	describe("setDefault", () => {
		it("should clear other defaults and set the target", async () => {
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
			expect(result.isDefault).toBe(true);
			expect(prisma.frpsInstance.updateMany).toHaveBeenCalledWith({
				where: { isDefault: true },
				data: { isDefault: false },
			});
		});
	});

	describe("getDefault", () => {
		it("should throw when no default", async () => {
			prisma.frpsInstance.findFirst.mockResolvedValue(null);
			await expect(service.getDefault()).rejects.toThrow("没有默认");
		});

		it("should return the default instance", async () => {
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
			expect(result.isDefault).toBe(true);
		});
	});

	describe("listDashboardProxies", () => {
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
		} as const;

		it("严格返回三类 proxy，并携带正确 Basic Auth", async () => {
			const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
				const type = String(input).split("/").at(-1);
				return Response.json({
					proxies: [{ name: `${type}-proxy`, status: "online", conf: { remotePort: 20100 } }],
				});
			});
			vi.stubGlobal("fetch", fetcher);

			const result = await service.listDashboardProxies(instance);

			expect(result.list).toEqual([
				{ name: "tcp-proxy", proxyType: "tcp", status: "online", remotePort: 20100 },
				{ name: "http-proxy", proxyType: "http", status: "online", remotePort: 20100 },
				{ name: "https-proxy", proxyType: "https", status: "online", remotePort: 20100 },
			]);
			expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({
				Authorization: `Basic ${Buffer.from("operator:secret").toString("base64")}`,
			});
		});

		it("未配置 Dashboard 时返回稳定错误码", async () => {
			await expect(
				service.listDashboardProxies({ ...instance, dashboardHost: null }),
			).rejects.toMatchObject({ code: "FRPS_DASHBOARD_REQUIRED" });
		});

		it.each([
			[401, "FRPS_DASHBOARD_AUTH_FAILED"],
			[503, "FRPS_DASHBOARD_UNREACHABLE"],
		] as const)("HTTP %s 映射为 %s", async (status, code) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response("failure", { status })),
			);
			await expect(service.listDashboardProxies(instance)).rejects.toMatchObject({
				code,
			});
		});

		it("网络错误不泄露原始外部错误", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockRejectedValue(new Error("secret upstream detail")),
			);
			await expect(service.listDashboardProxies(instance)).rejects.toMatchObject({
				code: "FRPS_DASHBOARD_UNREACHABLE",
				message: "FRPS Dashboard 不可达",
			});
		});
	});
});
