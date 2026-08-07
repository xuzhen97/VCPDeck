import { describe, expect, it, vi } from "vitest";
import { VcpDeckClient } from "./client.js";

function makeClient() {
	const fetcher = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({ ok: true }),
	);
	const client = new VcpDeckClient({
		baseUrl: "https://deck",
		auth: { type: "cookie" },
		fetch: fetcher,
	});
	return { client, fetcher };
}

describe("VcpDeckClient.pi", () => {
	it("sessions.list 编码 clientId 与查询参数", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.sessions.list("c/1", { rootDir: "D:\\", relativePath: "repo" });
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/api/clients/c%2F1/pi/sessions?"),
			expect.any(Object),
		);
		const url = fetcher.mock.calls[0]?.[0] as string;
		expect(url).toContain("rootDir=D%3A%5C");
		expect(url).toContain("relativePath=repo");
	});

	it("agent.eventsPath 是 session 级且编码 clientId", () => {
		const { client } = makeClient();
		expect(client.pi.agent.eventsPath("c/1", "s/1")).toBe(
			"/api/clients/c%2F1/pi/agent/s%2F1/events",
		);
	});

	it("agent.prompt 发送 submissionId 与 prompt", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.agent.prompt("c1", "s1", { rootDir: "D:\\", relativePath: "r" }, {
			submissionId: "sub-1",
			prompt: "hello",
		});
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/api/clients/c1/pi/agent/s1"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"submissionId":"sub-1"'),
			}),
		);
	});

	it("sessions.rename/delete/fork 使用正确 method", async () => {
		const { client, fetcher } = makeClient();
		const cwdRef = { rootDir: "D:\\", relativePath: "r" };

		await client.pi.sessions.rename("c1", "s1", cwdRef, "新名字");
		await client.pi.sessions.delete("c1", "s1", cwdRef);
		await client.pi.sessions.fork("c1", "s1", cwdRef, "m1");

		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
		expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
	});

	it("capability/models/running 是 GET", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.capability("c1");
		await client.pi.models("c1", { rootDir: "D:\\", relativePath: "r" });
		await client.pi.running("c1");
		expect(fetcher.mock.calls.every((c) => c[1]?.method === "GET")).toBe(true);
	});
});
