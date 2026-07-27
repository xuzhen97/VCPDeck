import { describe, expect, it, vi } from "vitest";
import { type VcpDeckApiError, VcpDeckClient } from "./client.js";

describe("VcpDeckClient", () => {
	it("calls the default global fetch without rebinding its receiver", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(function (this: unknown) {
			if (this !== globalThis) throw new TypeError("Illegal invocation");
			return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		});
		globalThis.fetch = fetchMock as typeof fetch;
		try {
			const client = new VcpDeckClient({ baseUrl: "https://deck.example", auth: { type: "cookie" } });
			await expect(client.health.get()).resolves.toEqual({ ok: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses browser cookie credentials", async () => {
		const fetcher = vi.fn(async () => Response.json({ ok: true }));
		const client = new VcpDeckClient({
			baseUrl: "",
			auth: { type: "cookie" },
			fetch: fetcher,
		});

		await client.request("GET", "/api/health");

		expect(fetcher).toHaveBeenCalledWith(
			"/api/health",
			expect.objectContaining({ credentials: "include" }),
		);
	});

	it("uses bearer authorization", async () => {
		const fetcher = vi.fn(async () => Response.json({ ok: true }));
		const client = new VcpDeckClient({
			baseUrl: "http://localhost:3001/",
			auth: { type: "bearer", token: "vcp_secret" },
			fetch: fetcher,
		});

		await client.request("GET", "/api/health");

		expect(fetcher).toHaveBeenCalledWith(
			"http://localhost:3001/api/health",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer vcp_secret",
				}),
			}),
		);
	});

	it("normalizes non-json failures", async () => {
		const client = new VcpDeckClient({
			baseUrl: "",
			auth: { type: "cookie" },
			fetch: async () => new Response("bad gateway", { status: 502 }),
		});

		await expect(client.request("GET", "/api/jobs")).rejects.toMatchObject({
			status: 502,
		} satisfies Partial<VcpDeckApiError>);
	});
});
