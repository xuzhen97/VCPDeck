import { describe, expect, it, vi } from "vitest";
import { createFeaturesApi } from "./features.js";

function fakeClient() {
	const request = vi.fn().mockResolvedValue({
		data: [],
		total: 0,
		page: 1,
		pageSize: 20,
		totalPages: 1,
	});
	return { request, api: createFeaturesApi({ request } as never) };
}

describe("createFeaturesApi", () => {
	it("list 拼接过滤与分页参数", async () => {
		const { request, api } = fakeClient();
		await api.list({ clientId: "c1", scope: "generic", page: 2, pageSize: 50 });
		const [method, path] = request.mock.calls[0] as [string, string];
		expect(method).toBe("GET");
		expect(path).toBe(
			"/api/features?clientId=c1&scope=generic&page=2&pageSize=50",
		);
	});

	it("list 无参数时不带查询串", async () => {
		const { request, api } = fakeClient();
		await api.list();
		expect(request.mock.calls[0]?.[1]).toBe("/api/features");
	});

	it("reportVerification 走 POST 子路径", async () => {
		const { request, api } = fakeClient();
		await api.reportVerification("ft_1", { ok: true, via: "cli" });
		const [method, path, body] = request.mock.calls[0] as [
			string,
			string,
			unknown,
		];
		expect(method).toBe("POST");
		expect(path).toBe("/api/features/ft_1/verifications");
		expect(body).toEqual({ ok: true, via: "cli" });
	});

	it("update 走 PATCH 且对 id 做编码", async () => {
		const { request, api } = fakeClient();
		await api.update("ft/1", { status: "retired" });
		const [method, path] = request.mock.calls[0] as [string, string];
		expect(method).toBe("PATCH");
		expect(path).toBe("/api/features/ft%2F1");
	});
});
