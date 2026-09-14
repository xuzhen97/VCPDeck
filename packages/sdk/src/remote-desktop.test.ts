import { describe, expect, it } from "vitest";
import type { VcpDeckClient } from "./client.js";
import { createRemoteDesktopApi } from "./remote-desktop.js";

function makeClient() {
	const calls: Array<{ method: string; path: string; body?: unknown; signal?: AbortSignal }> = [];
	const client = {
		request: async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
			calls.push({ method, path, body, signal });
			return { ok: true } as T;
		},
	} as unknown as Pick<VcpDeckClient, "request">;
	return { client, calls };
}

describe("createRemoteDesktopApi", () => {
	it("uses machine-scoped Session endpoints and encodes identifiers", async () => {
		const { client, calls } = makeClient();
		const api = createRemoteDesktopApi(client);
		await api.create("client/a", { qualityProfile: "balanced", clipboardMode: "off" });
		await api.get("client/a", "session 1");
		await api.remove("client/a", "session 1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/api/clients/client%2Fa/desktop-sessions",
			body: { qualityProfile: "balanced", clipboardMode: "off" },
		});
		expect(calls[1]?.path).toBe("/api/clients/client%2Fa/desktop-sessions/session%201");
		expect(calls[2]?.method).toBe("DELETE");
	});

	it("builds paginated list and audit queries with URLSearchParams", async () => {
		const { client, calls } = makeClient();
		const api = createRemoteDesktopApi(client);
		await api.list("c1", { page: 2, pageSize: 50 });
		await api.audit("c1", "s1", { page: 3, pageSize: 10 });

		expect(calls[0]?.path).toBe("/api/clients/c1/desktop-sessions?page=2&pageSize=50");
		expect(calls[1]?.path).toBe("/api/clients/c1/desktop-sessions/s1/audit?page=3&pageSize=10");
	});

	it("forwards AbortSignal to every operation", async () => {
		const { client, calls } = makeClient();
		const api = createRemoteDesktopApi(client);
		const signal = new AbortController().signal;
		await api.list("c1", undefined, signal);
		await api.create("c1", {}, signal);
		await api.get("c1", "s1", signal);
		await api.remove("c1", "s1", signal);
		await api.audit("c1", "s1", undefined, signal);
		expect(calls.every((call) => call.signal === signal)).toBe(true);
	});
});
