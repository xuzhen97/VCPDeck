import { describe, expect, it, vi } from "vitest";
import { StorageShareController } from "./storage-share.controller.js";

const actor = {
	identityId: "identity-1",
	displayName: "Operator",
	isAdmin: false,
	credentialId: null,
	sessionId: "session-1",
	source: "web" as const,
	requestId: "request-1",
};

describe("StorageShareController", () => {
	it("创建和撤销分享传递 Actor，并返回服务层结果", async () => {
		const service = {
			create: vi.fn().mockResolvedValue({ id: "share-1", sharePath: "/api/public/storage-shares/token" }),
			revoke: vi.fn().mockResolvedValue({ id: "share-1", status: "revoked" }),
		};
		const controller = new StorageShareController(service as never);

		await expect(controller.create({ fileId: "file-1" }, actor)).resolves.toMatchObject({ id: "share-1" });
		expect(service.create).toHaveBeenCalledWith({ fileId: "file-1" }, actor);
		await controller.revoke("share-1", actor);
		expect(service.revoke).toHaveBeenCalledWith("share-1", actor);
	});

	it("列表限制 page/pageSize，并保留 fileId/status 筛选", async () => {
		const service = { list: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 100, totalPages: 0 }) };
		const controller = new StorageShareController(service as never);

		await controller.list("file-1", "active", "0", "999");
		expect(service.list).toHaveBeenCalledWith({ fileId: "file-1", status: "active", page: 1, pageSize: 100 });
	});
});
