import { describe, expect, it, vi } from "vitest";
import type { SessionHostService } from "./session-host.service.js";
import { SessionHostController } from "./session-host.controller.js";

function controllerWith(list = vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }))) {
	const service = { list } as unknown as SessionHostService;
	return { controller: new SessionHostController(service), list };
}

describe("SessionHostController", () => {
	it("pageSize 上限固定为 100", async () => {
		const { controller, list } = controllerWith();
		await controller.list(undefined, "1", "9999");
		expect(list).toHaveBeenCalledWith({ clientId: undefined }, 1, 100);
	});

	it("非法分页参数回落默认值，不把 NaN 带进查询", async () => {
		const { controller, list } = controllerWith();
		await controller.list(undefined, "abc", "0");
		expect(list).toHaveBeenCalledWith({ clientId: undefined }, 1, 20);
	});

	it("clientId 透传给服务", async () => {
		const { controller, list } = controllerWith();
		await controller.list("c1", undefined, undefined);
		expect(list).toHaveBeenCalledWith({ clientId: "c1" }, 1, 20);
	});
});
