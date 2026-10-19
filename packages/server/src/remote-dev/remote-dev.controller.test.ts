import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RemoteDevController } from "./remote-dev.controller.js";
import { ACTOR } from "./test-helpers.js";

describe("RemoteDevController", () => {
	it("create 拒绝非法 body，不调用 service", async () => {
		const service = { create: vi.fn() };
		const controller = new RemoteDevController(service as never, {} as never);
		await expect(
			controller.create({ clientId: "" }, ACTOR),
		).rejects.toBeInstanceOf(BadRequestException);
		expect(service.create).not.toHaveBeenCalled();
	});

	it("create 解析后透传 actor", async () => {
		const created = { sessionId: "r1" };
		const service = { create: vi.fn().mockResolvedValue(created) };
		const controller = new RemoteDevController(service as never, {} as never);
		await expect(
			controller.create(
				{
					clientId: "c1",
					agentPlacementId: "p1",
					workspaceRoot: "/repo",
				},
				ACTOR,
			),
		).resolves.toBe(created);
		expect(service.create).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: "c1", workspaceRoot: "/repo" }),
			ACTOR,
		);
	});

	it("列表拒绝未知状态", async () => {
		const service = { list: vi.fn() };
		const controller = new RemoteDevController(service as never, {} as never);
		await expect(controller.list(undefined, "ghost")).rejects.toBeInstanceOf(
			BadRequestException,
		);
		expect(service.list).not.toHaveBeenCalled();
	});

	it("关闭会话时撤销已打开端口的 forward token", async () => {
		const closed = { sessionId: "r1", state: "closed" };
		const service = {
			ports: vi.fn().mockResolvedValue([
				{ portId: "p1", status: "open" },
				{ portId: "p2", status: "closed" },
			]),
			close: vi.fn().mockResolvedValue(closed),
		};
		const portTokens = { revokePort: vi.fn() };
		const controller = new RemoteDevController(
			service as never,
			portTokens as never,
		);
		await expect(controller.close("r1", ACTOR)).resolves.toBe(closed);
		expect(portTokens.revokePort).toHaveBeenCalledWith("p1");
		expect(portTokens.revokePort).toHaveBeenCalledWith("p2");
	});
});
