import type { ActorContext } from "@vcpdeck/shared";
import { describe, expect, it, vi } from "vitest";
import { ClientInstallerController } from "./client-installer.controller.js";
import { ClientInstallerError } from "./client-installer.service.js";

const actor: ActorContext = {
	identityId: "identity-1",
	displayName: "Operator",
	isAdmin: false,
	credentialId: null,
	sessionId: "session-1",
	source: "web",
	requestId: "request-1",
};

function service() {
	return {
		getConfig: vi.fn(async () => ({ enabled: false })),
		updateConfig: vi.fn(async (enabled: boolean) => ({ enabled })),
		readAsset: vi.fn(() => Buffer.from("echo installer")),
		preflight: vi.fn(async () => ({ platform: "linux-x64" })),
		bootstrap: vi.fn(async () => ({ psk: "secret" })),
		assertPsk: vi.fn((value?: string) => {
			if (value !== "secret") {
				throw new ClientInstallerError(
					"CLIENT_INSTALLER_PSK_INVALID",
					"Client 安装凭据无效",
					401,
				);
			}
		}),
		getClientStatus: vi.fn(async () => ({ registered: true })),
		renameClient: vi.fn(),
	};
}

function response(psk?: string) {
	return {
		req: { header: vi.fn(() => psk) },
		type: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
}

describe("ClientInstallerController", () => {
	it("普通已登录操作者可以更新开关", async () => {
		const mock = service();
		const controller = new ClientInstallerController(mock as never);
		await controller.updateConfig({ enabled: true }, actor);
		expect(mock.updateConfig).toHaveBeenCalledWith(true, actor);
	});

	it("bootstrap 严格拒绝未知字段", async () => {
		const controller = new ClientInstallerController(service() as never);
		expect(() =>
			controller.bootstrap({ platform: "linux-x64", extra: true }),
		).toThrowError(expect.objectContaining({ status: 400 }));
	});

	it("安装状态使用 header PSK 并稳定映射 401", async () => {
		const controller = new ClientInstallerController(service() as never);
		expect(() =>
			controller.getClientStatus("client-1", undefined, response() as never),
		).toThrowError(expect.objectContaining({ status: 401 }));
	});

	it("拒绝通过 query 传递 PSK", () => {
		const controller = new ClientInstallerController(service() as never);
		expect(() =>
			controller.getClientStatus(
				"client-1",
				"secret",
				response("secret") as never,
			),
		).toThrowError(expect.objectContaining({ status: 400 }));
	});

	it("公开脚本响应不包含 PSK", () => {
		const mock = service();
		const controller = new ClientInstallerController(mock as never);
		const res = response();
		controller.getScript("linux-x64", res as never);
		expect(res.send).toHaveBeenCalledWith(Buffer.from("echo installer"));
		expect(String(res.send.mock.calls[0]?.[0])).not.toContain("secret");
	});

	it("公开卸载资产可以读取", () => {
		const mock = service();
		const controller = new ClientInstallerController(mock as never);
		const res = response();
		controller.getAsset("uninstall-client.cjs", res as never);
		expect(mock.readAsset).toHaveBeenCalledWith("uninstall-client.cjs");
		expect(res.send).toHaveBeenCalledWith(Buffer.from("echo installer"));
	});
});
