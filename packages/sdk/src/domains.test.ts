import { expect, it, vi } from "vitest";
import { VcpDeckClient } from "./index.js";

it("calls clients and frp routes", async () => {
	const fetcher = vi.fn(async () => Response.json([]));
	const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: fetcher });

	await client.clients.list();
	await client.frp.list("c1");

	expect(fetcher).toHaveBeenNthCalledWith(1, "/api/clients", expect.any(Object));
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		"/api/frp/mappings?clientId=c1",
		expect.any(Object),
	);
});

it("switches storage backend without exposing a config reader", async () => {
	const fetcher = vi.fn(async () => Response.json({ kind: "alibaba" }));
	const client = new VcpDeckClient({ baseUrl: "", auth: { type: "cookie" }, fetch: fetcher });

	await client.storage.setBackend({ kind: "alibaba" });

	expect(fetcher).toHaveBeenCalledWith(
		"/api/storage/config",
		expect.objectContaining({ method: "PUT", body: JSON.stringify({ kind: "alibaba" }) }),
	);
	expect("getConfig" in client.storage).toBe(false);
});
