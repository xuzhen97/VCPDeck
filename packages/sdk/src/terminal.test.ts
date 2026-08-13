import { describe, expect, it } from "vitest";
import { createTerminalsApi } from "./terminal.js";
import type { VcpDeckClient } from "./client.js";
import type { PaginatedResult, TerminalAuditInfo, TerminalSessionInfo, TerminalShellInfo } from "@vcpdeck/shared";

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

describe("createTerminalsApi", () => {
	it("shells 列表路径正确并 encode clientId", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		await api.shells("机器 A/1", undefined);
		expect(calls[0]).toMatchObject({ method: "GET", path: "/api/clients/%E6%9C%BA%E5%99%A8%20A%2F1/terminals/shells" });
	});

	it("list 用 URLSearchParams 拼接分页", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		await api.list("c1", { page: 2, pageSize: 50 }, undefined);
		expect(calls[0]?.path).toBe("/api/clients/c1/terminals?page=2&pageSize=50");
	});

	it("list 无选项时不带 query", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		await api.list("c1", undefined, undefined);
		expect(calls[0]?.path).toBe("/api/clients/c1/terminals");
	});

	it("create 只发送 shellId/cols/rows", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		const body = { shellId: "bash", cols: 100, rows: 40 } as TerminalSessionCreateBody;
		await api.create("c1", body, undefined);
		expect(calls[0]).toMatchObject({ method: "POST", path: "/api/clients/c1/terminals", body: { shellId: "bash", cols: 100, rows: 40 } });
	});

	it("get/remove/audit 路径正确并 encode sessionId", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		await api.get("c1", "s 1", undefined);
		await api.remove("c1", "s 1", undefined);
		await api.audit("c1", "s 1", { page: 1, pageSize: 10 }, undefined);
		expect(calls[0]?.path).toBe("/api/clients/c1/terminals/s%201");
		expect(calls[1]?.method).toBe("DELETE");
		expect(calls[1]?.path).toBe("/api/clients/c1/terminals/s%201");
		expect(calls[2]?.path).toBe("/api/clients/c1/terminals/s%201/audit?page=1&pageSize=10");
	});

	it("AbortSignal 透传", async () => {
		const { client, calls } = makeClient();
		const api = createTerminalsApi(client);
		const signal = new AbortController().signal;
		await api.list("c1", undefined, signal);
		expect(calls[0]?.signal).toBe(signal);
	});
});

/** 测试用（真实类型来自 @vcpdeck/shared）。 */
type TerminalSessionCreateBody = { shellId: string; cols: number; rows: number };
