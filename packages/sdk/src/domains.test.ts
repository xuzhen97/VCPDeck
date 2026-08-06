import { expect, it, vi } from "vitest";
import { VcpDeckClient } from "./index.js";

it("clients.list returns full machine info", async () => {
	const serverResponse = [
		{
			clientId: "c1",
			hostname: "workstation",
			os: "win32 10.0.26200",
			cpuModel: "Intel(R) Core(TM) i7-12700",
			totalMemMB: 16384,
			disks: [{ name: "C:", totalMB: 512000, usedPercent: 67.8 }],
			clientVersion: "0.0.0",
			capabilities: ["exec", "file.read", "file.write"],
			online: true,
			cpuPercent: 23.5,
			memPercent: 45.2,
			lastHeartbeatAt: "2026-07-28T10:21:56.000Z",
		},
	];
	const fetcher = vi.fn(async () => Response.json(serverResponse));
	const client = new VcpDeckClient({
		baseUrl: "",
		auth: { type: "cookie" },
		fetch: fetcher,
	});

	const clients = await client.clients.list();
	expect(clients).toHaveLength(1);
	const c = clients[0];
	expect(c.clientId).toBe("c1");
	expect(c.hostname).toBe("workstation");
	expect(c.os).toBe("win32 10.0.26200");
	expect(c.cpuModel).toBe("Intel(R) Core(TM) i7-12700");
	expect(c.totalMemMB).toBe(16384);
	expect(c.disks).toEqual([{ name: "C:", totalMB: 512000, usedPercent: 67.8 }]);
	expect(c.clientVersion).toBe("0.0.0");
	expect(c.capabilities).toEqual(["exec", "file.read", "file.write"]);
	expect(c.online).toBe(true);
	expect(c.cpuPercent).toBe(23.5);
	expect(c.memPercent).toBe(45.2);
	expect(c.lastHeartbeatAt).toBe("2026-07-28T10:21:56.000Z");
});

it("calls clients and frp routes", async () => {
	const fetcher = vi.fn(async () => Response.json([]));
	const client = new VcpDeckClient({
		baseUrl: "",
		auth: { type: "cookie" },
		fetch: fetcher,
	});

	await client.clients.list();
	await client.frp.list({ clientId: "c1" });

	expect(fetcher).toHaveBeenNthCalledWith(
		1,
		"/api/clients",
		expect.any(Object),
	);
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		"/api/frp/mappings?clientId=c1",
		expect.any(Object),
	);
});

it("calls the Aliyun Drive remote authorization verification endpoint", async () => {
	const fetcher = vi.fn(async () =>
		Response.json({
			valid: true,
			checkedAt: "2026-07-31T12:00:00.000Z",
			driveId: "drive-1",
		}),
	);
	const client = new VcpDeckClient({
		baseUrl: "",
		auth: { type: "cookie" },
		fetch: fetcher,
	});

	expect(await client.aliyundrive.verify()).toEqual({
		valid: true,
		checkedAt: "2026-07-31T12:00:00.000Z",
		driveId: "drive-1",
	});
	expect(fetcher).toHaveBeenCalledWith(
		"/api/aliyundrive/verify",
		expect.objectContaining({ method: "POST" }),
	);
});

it("reads a safe storage backend summary and switches the backend", async () => {
	const responses = [
		Response.json({ kind: "local", updatedAt: null }),
		Response.json({ kind: "alibaba", updatedAt: "2026-07-31T12:00:00.000Z" }),
	];
	const fetcher = vi.fn(async () => responses.shift()!);
	const client = new VcpDeckClient({
		baseUrl: "",
		auth: { type: "cookie" },
		fetch: fetcher,
	});

	expect(await client.storage.getBackendConfig()).toEqual({
		kind: "local",
		updatedAt: null,
	});
	expect(await client.storage.setBackend({ kind: "alibaba" })).toEqual({
		kind: "alibaba",
		updatedAt: "2026-07-31T12:00:00.000Z",
	});

	expect(fetcher).toHaveBeenNthCalledWith(
		1,
		"/api/storage/config",
		expect.objectContaining({ method: "GET" }),
	);
	expect(fetcher).toHaveBeenNthCalledWith(
		2,
		"/api/storage/config",
		expect.objectContaining({
			method: "PUT",
			body: JSON.stringify({ kind: "alibaba" }),
		}),
	);
	expect("getConfig" in client.storage).toBe(false);
});
