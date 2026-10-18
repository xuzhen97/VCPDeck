import { HttpException } from "@nestjs/common";
import type { ActorContext } from "@vcpdeck/shared";
import { describe, expect, it, vi } from "vitest";
import { FeatureController } from "./feature.controller.js";
import { FeatureError } from "./feature.service.js";

const actor: ActorContext = {
	identityId: "i1",
	displayName: "Admin",
	isAdmin: true,
	credentialId: null,
	sessionId: null,
	source: "cli",
	requestId: "req-1",
};

function makeService(overrides: Record<string, unknown> = {}) {
	return {
		list: vi.fn(async () => ({
			data: [],
			total: 0,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		})),
		get: vi.fn(async () => ({})),
		create: vi.fn(async () => ({})),
		update: vi.fn(async () => ({})),
		reportVerification: vi.fn(async () => ({})),
		listByClient: vi.fn(async () => ({
			data: [],
			total: 0,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		})),
		...overrides,
	};
}

function controllerWith(overrides: Record<string, unknown> = {}) {
	const service = makeService(overrides);
	return {
		controller: new FeatureController(service as never),
		service,
	};
}

async function expectHttpError(
	promise: Promise<unknown>,
	status: number,
	code: string,
): Promise<void> {
	try {
		await promise;
		throw new Error("预期抛出 HttpException，但没有抛出");
	} catch (error) {
		expect(error).toBeInstanceOf(HttpException);
		const http = error as HttpException;
		expect(http.getStatus()).toBe(status);
		expect(http.getResponse()).toMatchObject({ code });
	}
}

describe("FeatureController", () => {
	it("空更新对象返回 400 INVALID_FEATURE_INPUT", async () => {
		const { controller } = controllerWith();
		await expectHttpError(controller.update("ft_1", {}), 400, "INVALID_FEATURE_INPUT");
	});

	it("把 status 改成 active 被拒绝", async () => {
		const { controller } = controllerWith();
		await expectHttpError(
			controller.update("ft_1", { status: "active" }),
			400,
			"INVALID_FEATURE_INPUT",
		);
	});

	it("未知条目返回 404 FEATURE_NOT_FOUND", async () => {
		const { controller } = controllerWith({
			get: vi.fn(async () => {
				throw new FeatureError("FEATURE_NOT_FOUND", "功能条目不存在", 404);
			}),
		});
		await expectHttpError(controller.get("missing"), 404, "FEATURE_NOT_FOUND");
	});

	it("pageSize 超过 100 被夹到 100", async () => {
		const { controller, service } = controllerWith();
		await controller.list(undefined, undefined, undefined, "2", "500");
		expect(service.list).toHaveBeenCalledWith({
			clientId: undefined,
			scope: undefined,
			status: undefined,
			page: 2,
			pageSize: 100,
		});
	});

	it("创建时把 Actor 透传给服务", async () => {
		const { controller, service } = controllerWith();
		await controller.create(
			{
				clientId: "c1",
				slug: "screenshot",
				name: "截图",
				summary: "截取本机屏幕",
				scope: "machine",
				invoke: { kind: "command", command: "screenshot.exe", timeoutSeconds: 30 },
				verify: { kind: "command", command: "screenshot.exe --check", timeoutSeconds: 30 },
			},
			actor,
		);
		expect(service.create).toHaveBeenCalledWith(
			expect.objectContaining({ slug: "screenshot", scope: "machine" }),
			actor,
		);
	});
});
