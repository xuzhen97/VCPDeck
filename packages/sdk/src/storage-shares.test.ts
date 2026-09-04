import { describe, expect, it, vi } from "vitest";
import { createStorageSharesApi } from "./storage-shares.js";

function makeClient() {
	return { request: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }) };
}

describe("storageShares API", () => {
	it("creates, lists, gets and revokes shares using the management routes", async () => {
		const client = makeClient();
		const api = createStorageSharesApi(client as never);

		await api.create({ fileId: "file-1" });
		await api.list({ fileId: "file/1", status: "active", page: 2, pageSize: 50 });
		await api.get("share/1");
		await api.revoke("share/1");

		expect(client.request).toHaveBeenNthCalledWith(1, "POST", "/api/storage/shares", { fileId: "file-1" }, undefined);
		expect(client.request).toHaveBeenNthCalledWith(2, "GET", "/api/storage/shares?fileId=file%2F1&status=active&page=2&pageSize=50", undefined, undefined);
		expect(client.request).toHaveBeenNthCalledWith(3, "GET", "/api/storage/shares/share%2F1", undefined, undefined);
		expect(client.request).toHaveBeenNthCalledWith(4, "DELETE", "/api/storage/shares/share%2F1", undefined, undefined);
	});
});
