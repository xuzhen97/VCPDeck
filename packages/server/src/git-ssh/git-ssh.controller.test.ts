import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { GitSshController } from "./git-ssh.controller.js";
import type { GitSshService } from "./git-ssh.service.js";

const PUBLIC_INFO = {
	version: 3,
	publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBtestkey",
	fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
};

const STATUS = {
	key: PUBLIC_INFO,
	targets: [
		{
			clientId: "client-a",
			desiredVersion: 3,
			observedVersion: 3,
			state: "installed" as const,
		},
		{
			clientId: "client-b",
			desiredVersion: null,
			observedVersion: null,
			state: "clear-pending" as const,
		},
	],
};

function makeController(overrides: Partial<Record<keyof GitSshService, unknown>> = {}) {
	const service = {
		getPublicInfo: vi.fn().mockResolvedValue(PUBLIC_INFO),
		generate: vi.fn().mockResolvedValue(PUBLIC_INFO),
		setTargets: vi.fn().mockResolvedValue(STATUS),
		status: vi.fn().mockResolvedValue(STATUS),
		...overrides,
	};
	return {
		controller: new GitSshController(service as never),
		service,
	};
}

/** 捕获 HttpException 并返回其状态码（非 HttpException 视为 0）。 */
async function statusOf(promise: Promise<unknown>): Promise<number> {
	try {
		await promise;
		return 0;
	} catch (thrown) {
		return thrown instanceof HttpException ? thrown.getStatus() : -1;
	}
}

describe("GitSshController", () => {
	it("GET /api/git-ssh 返回公钥投影", async () => {
		const { controller } = makeController();
		await expect(controller.getKey()).resolves.toEqual(PUBLIC_INFO);
	});

	it("POST /api/git-ssh/generate 返回公钥投影且不含私钥", async () => {
		const { controller } = makeController();
		const result = await controller.generate();
		expect(result).toEqual(PUBLIC_INFO);
		expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
	});

	it("PUT /api/git-ssh/targets 严格解析后只传递 clientIds", async () => {
		const { controller, service } = makeController();
		await expect(
			controller.setTargets({ clientIds: ["a", "b"] }),
		).resolves.toEqual(STATUS);
		expect(service.setTargets).toHaveBeenCalledWith(["a", "b"]);
	});

	it("非法选机请求映射为 400 与 GIT_SSH_PROTOCOL_INVALID", async () => {
		const { controller } = makeController();
		await expect(
			controller.setTargets({ clientIds: ["a", "a"] }),
		).rejects.toMatchObject({
			response: { code: "GIT_SSH_PROTOCOL_INVALID" },
		});
		expect(await statusOf(controller.setTargets({ clientIds: ["a", "a"] }))).toBe(400);
	});

	it("未生成密钥时映射为 400 与 GIT_SSH_KEY_UNAVAILABLE", async () => {
		const { controller } = makeController({
			setTargets: vi.fn().mockRejectedValue(
				Object.assign(new Error("尚未生成 Git SSH 密钥"), {
					code: "GIT_SSH_KEY_UNAVAILABLE",
				}),
			),
		});
		await expect(
			controller.setTargets({ clientIds: ["a"] }),
		).rejects.toMatchObject({
			response: { code: "GIT_SSH_KEY_UNAVAILABLE" },
		});
	});

	it("未知故障映射为 500 GIT_SSH_OPERATION_FAILED 且不回显原始异常", async () => {
		const { controller } = makeController({
			generate: vi.fn().mockRejectedValue(new Error("ECONNRESET at 10.0.0.1")),
		});
		const error = (await controller
			.generate()
			.then(() => null)
			.catch((thrown: unknown) => thrown)) as HttpException | null;
		expect(error?.getStatus()).toBe(500);
		expect(error?.getResponse()).toEqual({
			code: "GIT_SSH_OPERATION_FAILED",
			message: "Git SSH 密钥生成失败",
		});
		expect(JSON.stringify(error?.getResponse())).not.toContain("10.0.0.1");
	});

	it("GET /api/git-ssh/status 只投影安全状态", async () => {
		const { controller } = makeController();
		const status = await controller.status();
		expect(status).toEqual(STATUS);
		expect(JSON.stringify(status)).not.toContain("ciphertext");
		expect(JSON.stringify(status)).not.toContain("privateKey");
	});
});
