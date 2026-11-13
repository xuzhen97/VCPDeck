import { describe, expect, it, vi } from "vitest";
import { createTailnetApi } from "./tailnet.js";

const KEY_INFO = {
	id: "key-1",
	name: "home",
	declaredReuse: "single",
	declaredExpiresAt: null,
	use: "available",
	createdAt: "2026-11-11T10:00:00.000Z",
};

const SNAPSHOT = {
	installed: "yes",
	version: "1.104.5",
	service: "running",
	backend: "needs-login",
	nodeName: null,
	ipv4: [],
	ipv6: [],
	observedAt: "2026-11-11T10:00:00.000Z",
	errorCode: null,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Tailnet SDK", () => {
	it("status 对 clientId 编码并透传 abort signal", async () => {
		const request = vi.fn().mockResolvedValue({
			clientId: "a/b",
			online: false,
			supported: false,
			snapshot: null,
		});
		const api = createTailnetApi({ request });
		const signal = new AbortController().signal;
		await api.status("a/b", signal);
		expect(request).toHaveBeenCalledWith(
			"GET",
			"/api/tailnet/clients/a%2Fb",
			undefined,
			signal,
		);
	});

	it("status 响应经严格 parser（非法快照拒绝）", async () => {
		const request = vi.fn().mockResolvedValue({
			clientId: "c1",
			online: true,
			supported: true,
			snapshot: { ...SNAPSHOT, peer: { HostName: "must-not-leak" } },
		});
		const api = createTailnetApi({ request });
		await expect(api.status("c1")).rejects.toThrow();
	});

	it("listKeys 用 URLSearchParams 构造分页并逐项校验", async () => {
		const request = vi.fn().mockResolvedValue({
			data: [KEY_INFO],
			total: 1,
			page: 2,
			pageSize: 10,
			totalPages: 1,
		});
		const api = createTailnetApi({ request });
		const result = await api.listKeys({ page: 2, pageSize: 10 });
		expect(request).toHaveBeenCalledWith(
			"GET",
			"/api/tailnet/keys?page=2&pageSize=10",
			undefined,
			undefined,
		);
		expect(result.data[0]).toEqual(KEY_INFO);
	});

	it("listKeys 遇到坏条目整体拒绝", async () => {
		const request = vi.fn().mockResolvedValue({
			data: [{ ...KEY_INFO, use: "leaked" }],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		});
		const api = createTailnetApi({ request });
		await expect(api.listKeys()).rejects.toThrow();
	});

	it("importKey 只发送契约字段并校验返回投影", async () => {
		const request = vi.fn().mockResolvedValue(KEY_INFO);
		const api = createTailnetApi({ request });
		const input = {
			name: "home",
			authKey: "tskey-auth-secret",
			declaredReuse: "single" as const,
			declaredExpiresAt: null,
		};
		await api.importKey(input);
		expect(request).toHaveBeenCalledWith(
			"POST",
			"/api/tailnet/keys",
			{
				name: "home",
				authKey: "tskey-auth-secret",
				declaredReuse: "single",
				declaredExpiresAt: null,
			},
			undefined,
		);
	});

	it("deleteKey 只删除本地记录，无远端撤销参数", async () => {
		const request = vi.fn().mockResolvedValue({ deleted: true });
		const api = createTailnetApi({ request });
		await api.deleteKey("key/1");
		expect(request).toHaveBeenCalledWith(
			"DELETE",
			"/api/tailnet/keys/key%2F1",
			undefined,
			undefined,
		);
	});

	it("manage 只发送 action 与安装开关，夹带 authKey 也不会外发", async () => {
		const request = vi.fn().mockResolvedValue({
			jobId: "job-1",
			status: "pending",
			type: "tailnet.manage",
		});
		const api = createTailnetApi({ request });
		const payload = {
			action: "ensure",
			credentialId: "key-1",
			installIfMissing: false,
			authKey: "must-not-send",
		};
		await api.manage("client/1", payload as never);
		const body = request.mock.calls[0][2] as Record<string, unknown>;
		expect(body).toEqual({
			action: "ensure",
			credentialId: "key-1",
			installIfMissing: false,
		});
		expect(JSON.stringify(body)).not.toContain("must-not-send");
	});

	it("manage 只在显式确认时携带 allowUncertainReuse（ADR-0064）", async () => {
		const request = vi.fn().mockResolvedValue({
			jobId: "job-1",
			status: "pending",
			type: "tailnet.manage",
		});
		const api = createTailnetApi({ request });
		await api.manage("client/1", {
			action: "ensure",
			credentialId: "key-uncertain",
			installIfMissing: true,
			allowUncertainReuse: true,
		});
		expect((request.mock.calls[0][2] as Record<string, unknown>).allowUncertainReuse)
			.toBe(true);

		// 未确认时请求体逐字与旧版本一致，不出现该字段（哪怕是 false）
		await api.manage("client/1", {
			action: "ensure",
			credentialId: "key-available",
			installIfMissing: false,
		});
		const body = request.mock.calls[1][2] as Record<string, unknown>;
		expect(body).toEqual({
			action: "ensure",
			credentialId: "key-available",
			installIfMissing: false,
		});
		expect("allowUncertainReuse" in body).toBe(false);
	});

	it("错误传播不携带请求正文", async () => {
		const fetcher = vi.fn(async () =>
			jsonResponse({ code: "INVALID_TAILNET_INPUT", message: "输入无效" }, 400),
		);
		const { VcpDeckClient } = await import("./client.js");
		const client = new VcpDeckClient({
			baseUrl: "",
			auth: { type: "cookie" },
			fetch: fetcher as unknown as typeof fetch,
		});
		const error = await client.tailnet
			.importKey({
				name: "home",
				authKey: "tskey-auth-secret",
				declaredReuse: "single",
				declaredExpiresAt: null,
			})
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ status: 400, code: "INVALID_TAILNET_INPUT" });
		expect((error as Error).message).toBe("输入无效");
		expect((error as Error).message).not.toContain("tskey-auth-secret");
	});
});
