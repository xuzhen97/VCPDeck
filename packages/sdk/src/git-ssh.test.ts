import { describe, expect, it, vi } from "vitest";
import type { VcpDeckClient } from "./client.js";
import { createGitSshApi } from "./git-ssh.js";

function makeClient() {
	const calls: Array<{ method: string; path: string; body?: unknown; signal?: AbortSignal }> = [];
	const client = {
		request: async <T>(
			method: string,
			path: string,
			body?: unknown,
			signal?: AbortSignal,
		): Promise<T> => {
			calls.push({ method, path, body, signal });
			return { ok: true } as T;
		},
	} as unknown as Pick<VcpDeckClient, "request">;
	return { client, calls };
}

describe("createGitSshApi", () => {
	it("get / generate / status / targets 使用固定路径与动词", async () => {
		const { client, calls } = makeClient();
		const api = createGitSshApi(client);
		await api.get();
		await api.generate();
		await api.status();
		const result = await api.setTargets(["a", "b"]);

		expect(calls[0]).toMatchObject({ method: "GET", path: "/api/git-ssh" });
		expect(calls[1]).toMatchObject({ method: "POST", path: "/api/git-ssh/generate" });
		expect(calls[2]).toMatchObject({ method: "GET", path: "/api/git-ssh/status" });
		expect(calls[3]).toMatchObject({
			method: "PUT",
			path: "/api/git-ssh/targets",
			body: { clientIds: ["a", "b"] },
		});
		expect(result).toEqual({ ok: true });
	});

	it("setTargets 支持清空选机（全量替换为空数组）", async () => {
		const { client, calls } = makeClient();
		const api = createGitSshApi(client);
		await api.setTargets([]);
		expect(calls[0]).toMatchObject({ body: { clientIds: [] } });
	});

	it("透传 AbortSignal", async () => {
		const { client, calls } = makeClient();
		const api = createGitSshApi(client);
		const controller = new AbortController();
		await api.status(controller.signal);
		expect(calls[0]?.signal).toBe(controller.signal);
	});

	it("get 在 Server 返回空 body（无密钥）时归一化为 null", async () => {
		// Server 的 getPublicInfo() 无密钥时返回 null，Nest 序列化为 200 空 body，
		// SDK request 会解析成 undefined；API 必须把 undefined 归一化为 null。
		const request = vi.fn().mockResolvedValue(undefined);
		const client = { request } as unknown as Pick<VcpDeckClient, "request">;

		expect(await createGitSshApi(client).get()).toBeNull();
	});
});
