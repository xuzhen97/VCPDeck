import { describe, expect, it, vi } from "vitest";
import { createClientInstallerApi } from "./client-installer.js";

describe("createClientInstallerApi", () => {
	it("读取和更新安装配置", async () => {
		const request = vi.fn(async () => ({ enabled: false }));
		const api = createClientInstallerApi({ request } as never);
		await api.getConfig();
		await api.updateConfig(true);
		expect(request).toHaveBeenNthCalledWith(
			1,
			"GET",
			"/api/client-installer/config",
			undefined,
			undefined,
		);
		expect(request).toHaveBeenNthCalledWith(
			2,
			"PUT",
			"/api/client-installer/config",
			{ enabled: true },
			undefined,
		);
	});

	it("按平台请求公开 preflight", async () => {
		const request = vi.fn(async () => ({}));
		const api = createClientInstallerApi({ request } as never);
		await api.preflight("linux-x64");
		expect(request).toHaveBeenCalledWith(
			"GET",
			"/api/client-installer/preflight?platform=linux-x64",
			undefined,
			undefined,
		);
	});

	it("验收查询把 PSK 放在 header 而不是 URL", async () => {
		const requestRaw = vi.fn(async () => ({
			data: { registered: true },
			response: new Response(),
		}));
		const api = createClientInstallerApi({ requestRaw } as never);
		await api.getClientStatus("client/a", "shared-secret");
		expect(requestRaw).toHaveBeenCalledWith(
			"GET",
			"/api/client-installer/clients/client%2Fa/status",
			{
				headers: { "x-vcpdeck-psk": "shared-secret" },
				signal: undefined,
			},
		);
	});
});
