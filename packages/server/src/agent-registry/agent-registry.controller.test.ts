import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryController } from "./agent-registry.controller.js";
import { AgentRegistryError } from "./agent-registry.service.js";

function makeController(serviceOverrides: Record<string, unknown> = {}) {
	const service = {
		list: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 1 })),
		get: vi.fn(async () => ({})),
		create: vi.fn(async () => ({})),
		update: vi.fn(async () => ({})),
		remove: vi.fn(async () => undefined),
		...serviceOverrides,
	};
	return { controller: new AgentRegistryController(service as never), service };
}

async function expectHttpError(
	promise: Promise<unknown>,
	status: number,
	code: string,
): Promise<void> {
	try {
		await promise;
		throw new Error("预期抛出 HttpException");
	} catch (error) {
		expect(error).toBeInstanceOf(HttpException);
		const http = error as HttpException;
		expect(http.getStatus()).toBe(status);
		expect(http.getResponse()).toMatchObject({ code });
	}
}

describe("AgentRegistryController", () => {
	it("非法输入返回 400 INVALID_AGENT_PLACEMENT", async () => {
		const { controller } = makeController();
		await expectHttpError(
			controller.create({ agentId: "Reviewer" }, null as never),
			400,
			"INVALID_AGENT_PLACEMENT",
		);
	});

	it("未知 placement 返回 404 AGENT_NOT_FOUND", async () => {
		const { controller } = makeController({
			get: vi.fn(async () => {
				throw new AgentRegistryError("AGENT_NOT_FOUND", "not found", 404);
			}),
		});
		await expectHttpError(controller.get("missing"), 404, "AGENT_NOT_FOUND");
	});

	it("pageSize 夹到 100", async () => {
		const { controller, service } = makeController();
		await controller.list("2", "500");
		expect(service.list).toHaveBeenCalledWith(2, 100);
	});
});
