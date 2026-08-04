import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliyunDriveController } from "./aliyundrive.controller.js";

function mockPrisma() {
	return {
		storageBackendConfig: {
			findFirst: vi.fn(),
			upsert: vi.fn(),
		},
	};
}

function makeStorage() {
	return { reload: vi.fn() };
}

describe("AliyunDriveController.verify", () => {
	let prisma: ReturnType<typeof mockPrisma>;
	let controller: AliyunDriveController;
	let storage: ReturnType<typeof makeStorage>;

	beforeEach(() => {
		prisma = mockPrisma();
		storage = makeStorage();
		controller = new AliyunDriveController(prisma as never, storage as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("verifies a live token through getDriveInfo without exposing secrets", async () => {
		prisma.storageBackendConfig.findFirst.mockResolvedValue({
			kind: "alibaba",
			config: JSON.stringify({
				clientId: "app-id",
				accessToken: "access-token",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		const fetcher = vi
			.fn()
			.mockResolvedValue(Response.json({ default_drive_id: "drive-1" }));
		vi.stubGlobal("fetch", fetcher);

		const result = await controller.verify();

		expect(result).toMatchObject({ valid: true, driveId: "drive-1" });
		expect(result.checkedAt).toEqual(expect.any(String));
		expect(fetcher).toHaveBeenCalledWith(
			"https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer access-token",
				}),
			}),
		);
		expect(JSON.stringify(result)).not.toContain("access-token");
		expect(prisma.storageBackendConfig.upsert).toHaveBeenCalled();
		expect(storage.reload).toHaveBeenCalled();
	});

	it("reports revoked when the OpenAPI token is rejected", async () => {
		prisma.storageBackendConfig.findFirst.mockResolvedValue({
			kind: "alibaba",
			config: JSON.stringify({
				clientId: "app-id",
				accessToken: "revoked-token",
				expiresAt: Date.now() + 3_600_000,
			}),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("invalid token", { status: 401 })),
		);

		expect(await controller.verify()).toMatchObject({
			valid: false,
			reason: "revoked",
		});
	});

	it("refreshes a near-expiry token before verifying it", async () => {
		prisma.storageBackendConfig.findFirst.mockResolvedValue({
			kind: "alibaba",
			config: JSON.stringify({
				clientId: "app-id",
				clientSecret: "client-secret",
				accessToken: "old-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() + 60_000,
			}),
		});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					access_token: "new-token",
					refresh_token: "new-refresh-token",
					expires_in: 3600,
				}),
			)
			.mockResolvedValueOnce(Response.json({ default_drive_id: "drive-2" }));
		vi.stubGlobal("fetch", fetcher);

		const result = await controller.verify();

		expect(result).toMatchObject({ valid: true, driveId: "drive-2" });
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			"https://openapi.alipan.com/oauth/access_token",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			"https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer new-token",
				}),
			}),
		);
		expect(storage.reload).toHaveBeenCalled();
	});

	describe("completeOAuth", () => {
		it("OAuth 成功后重新加载存储 provider 使内存 token 生效", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "alibaba",
				config: JSON.stringify({ clientId: "app-id" }),
			});
			const { state } = await controller.startOAuth();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					Response.json({
						access_token: "fresh-token",
						refresh_token: "fresh-refresh",
						expires_in: 3600,
					}),
				),
			);

			await controller.completeOAuth({ state, code: "auth-code" });

			expect(storage.reload).toHaveBeenCalled();
			expect(prisma.storageBackendConfig.upsert).toHaveBeenCalledWith(
				expect.objectContaining({
					update: expect.objectContaining({
						config: expect.stringContaining("fresh-token"),
					}),
				}),
			);
		});
	});

	describe("saveConfig / revoke", () => {
		it("保存配置后同步内存 provider", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "alibaba",
				config: JSON.stringify({ clientId: "old-id" }),
			});

			await controller.saveConfig({ clientId: "new-id" });

			expect(storage.reload).toHaveBeenCalled();
		});

		it("撤销授权后同步内存 provider", async () => {
			prisma.storageBackendConfig.findFirst.mockResolvedValue({
				kind: "alibaba",
				config: JSON.stringify({ clientId: "app-id", accessToken: "t" }),
			});

			await controller.revoke();

			expect(storage.reload).toHaveBeenCalled();
		});
	});
});
