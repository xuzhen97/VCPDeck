import { describe, expect, it, vi } from "vitest";
import type { PiAgentState } from "@vcpdeck/shared";
import { createPiApi } from "./pi.js";
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

describe("createPiApi", () => {
	it("open/complete 使用 Session Job endpoint 与 body", async () => {
		const request = vi.fn(async () => ({}));
		const pi = createPiApi({ request: request as never });
		const cwdRef = { rootDir: "D:\\", relativePath: "repo" };

		await pi.agent.open("c1", "s1", cwdRef);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/agent/s1/open",
			cwdRef,
			undefined,
		);

		await pi.agent.complete("c1", "s1", "run-1");
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/agent/s1/complete",
			{ runId: "run-1" },
			undefined,
		);

		await pi.agent.complete("c1", "s1");
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/agent/s1/complete",
			{},
			undefined,
		);
	});

	it("run-scoped control body 使用 runId", async () => {
		const request = vi.fn(async () => ({}));
		const pi = createPiApi({ request: request as never });

		await pi.agent.abort("c1", "s1", "run-1");
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/agent/s1/abort",
			{ runId: "run-1" },
		);
	});

	it("commands 走只读 endpoint 并严格解析，拒绝含本地来源路径的上游响应", async () => {
		const cwdRef = { rootDir: "D:\\", relativePath: "repo" };
		const request = vi.fn(async () => ({
			runtimeInstanceId: "spec-1",
			runtimeRevision: "rev-1",
			commands: [{ name: "fixture_ok", description: "就绪探针" }],
		}));
		const pi = createPiApi({ request: request as never });

		await expect(pi.agent.commands("c/1", "s/1", cwdRef)).resolves.toEqual({
			runtimeInstanceId: "spec-1",
			runtimeRevision: "rev-1",
			commands: [{ name: "fixture_ok", description: "就绪探针" }],
		});
		expect(request).toHaveBeenLastCalledWith(
			"GET",
			"/api/clients/c%2F1/pi/agent/s%2F1/commands?rootDir=D%3A%5C&relativePath=repo",
			undefined,
			undefined,
		);

		// 上游夹带 sourceInfo（本地路径）必须被解析器拒绝。
		request.mockResolvedValueOnce({
			runtimeInstanceId: "spec-1",
			runtimeRevision: "rev-1",
			commands: [{ name: "x", description: "y", sourceInfo: { path: "C:\\s" } }],
		} as never);
		await expect(pi.agent.commands("c1", "s1", cwdRef)).rejects.toThrow();
	});

	it("extensionUi 走只读 endpoint 并严格解析快照", async () => {
		const cwdRef = { rootDir: "D:\\", relativePath: "repo" };
		const request = vi.fn(async () => ({
			runtimeInstanceId: "spec-1",
			runtimeRevision: "rev-1",
			sequence: 2,
			title: "构建中",
			statuses: [{ key: "k", text: "1" }],
			widgets: [{ key: "w", lines: ["a"], placement: "belowEditor" }],
		}));
		const pi = createPiApi({ request: request as never });

		const snapshot = await pi.agent.extensionUi("c1", "s1", cwdRef);
		expect(snapshot.sequence).toBe(2);
		expect(snapshot.widgets).toHaveLength(1);
		expect(request).toHaveBeenLastCalledWith(
			"GET",
			"/api/clients/c1/pi/agent/s1/extension-ui?rootDir=D%3A%5C&relativePath=repo",
			undefined,
			undefined,
		);

		request.mockResolvedValueOnce({ sequence: -1 } as never);
		await expect(pi.agent.extensionUi("c1", "s1", cwdRef)).rejects.toThrow();
	});

	it("executeCommand 由 Server 接纳 Run（不传 runId），携带 cwdRef/submissionId/name/args", async () => {
		const request = vi.fn(async () => ({
			jobId: "s1",
			runId: "run-1",
			sessionId: "s1",
		}));
		const pi = createPiApi({ request: request as never });
		const cwdRef = { rootDir: "D:\\", relativePath: "repo" };

		await pi.agent.executeCommand(
			"c/1",
			"s/1",
			cwdRef,
			"sub-1",
			"fixture_ok",
			"a b",
		);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c%2F1/pi/agent/s%2F1/command",
			{ ...cwdRef, submissionId: "sub-1", name: "fixture_ok", args: "a b" },
		);

		// 省略 args 时不得把 undefined 透传（Client 侧按缺省空串处理）。
		request.mockClear();
		await pi.agent.executeCommand("c1", "s1", cwdRef, "sub-2", "fixture_ok");
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/agent/s1/command",
			{ ...cwdRef, submissionId: "sub-2", name: "fixture_ok" },
		);
	});

	it("state 严格解析响应并拒绝畸形状态", async () => {
		const valid: PiAgentState = {
			status: "idle",
			streaming: false,
			prompting: false,
			compacting: false,
			thinkingLevel: "medium",
			queuedMessages: { steering: [], followUp: [] },
		};
		const request = vi.fn(async () => valid);
		const pi = createPiApi({ request: request as never });
		await expect(
			pi.agent.state("c1", "s1", { rootDir: "D:\\", relativePath: "repo" }),
		).resolves.toEqual(valid);

		request.mockResolvedValueOnce({
			...valid,
			streaming: "yes",
		} as unknown as PiAgentState);
		await expect(
			pi.agent.state("c1", "s1", { rootDir: "D:\\", relativePath: "repo" }),
		).rejects.toMatchObject({ code: "PI_PROTOCOL_INVALID" });
	});
});

describe("VcpDeckClient.pi", () => {
	it("sessions.list 编码 clientId 与查询参数", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.sessions.list("c/1", {
			rootDir: "D:\\",
			relativePath: "repo",
		});
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
		await client.pi.agent.prompt(
			"c1",
			"s1",
			{ rootDir: "D:\\", relativePath: "r" },
			{
				submissionId: "sub-1",
				prompt: "hello",
			},
		);
		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/api/clients/c1/pi/agent/s1"),
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"submissionId":"sub-1"'),
			}),
		);
	});

	it("agent.prompt 允许空文本搭配图片，且不补造任何提示词", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.agent.prompt(
			"c1",
			"s1",
			{ rootDir: "D:\\", relativePath: "r" },
			{
				submissionId: "sub-image",
				prompt: "",
				images: [
					{
						fileId: "f1",
						sha256: "sha",
						size: 42,
						mimeType: "image/png",
						url: "/api/storage/download/k1",
						expiresAt: Date.now() + 60_000,
					},
				],
			},
		);
		const body = String(fetcher.mock.calls[0]?.[1]?.body);
		expect(JSON.parse(body)).toMatchObject({ prompt: "", images: [{ fileId: "f1" }] });
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

	it("agent.setExecutionMode 支持设置与清除会话覆盖", async () => {
		const snapshot = {
			jobId: "s/1",
			sessionId: "s/1",
			status: "idle",
			runId: null,
			executionModeOverride: "automatic",
			effectiveExecutionMode: "automatic",
			ownerName: "User",
			isOwner: true,
		};
		const request = vi.fn(async () => snapshot);
		const pi = createPiApi({ request: request as never });
		const cwdRef = { rootDir: "D:\\\\", relativePath: "repo" };
		await expect(pi.agent.setExecutionMode("c/1", "s/1", cwdRef, "automatic")).resolves.toEqual(snapshot);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c%2F1/pi/agent/s%2F1/execution-mode",
			{ ...cwdRef, mode: "automatic" },
		);
		await pi.agent.setExecutionMode("c/1", "s/1", cwdRef, null);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c%2F1/pi/agent/s%2F1/execution-mode",
			{ ...cwdRef, mode: null },
		);
	});

	it("agent.setExecutionMode 拒绝字段非法或未知的执行模式响应", async () => {
		const cwdRef = { rootDir: "D:\\\\", relativePath: "repo" };
		const malformed = vi.fn(async () => ({ effectiveExecutionMode: "turbo" }));
		await expect(
			createPiApi({ request: malformed as never }).agent.setExecutionMode("c1", "s1", cwdRef, "supervised"),
		).rejects.toThrow();
		const unknownField = vi.fn(async () => ({
			jobId: "s1", sessionId: "s1", status: "idle", runId: null,
			executionModeOverride: null, effectiveExecutionMode: null,
			ownerName: null, isOwner: true, injected: true,
		}));
		await expect(
			createPiApi({ request: unknownField as never }).agent.setExecutionMode("c1", "s1", cwdRef, "supervised"),
		).rejects.toThrow();
	});

	it("agent.setModel/setThinking 使用当前 session endpoint", async () => {
		const { client, fetcher } = makeClient();
		const cwdRef = { rootDir: "D:\\\\", relativePath: "repo" };

		await client.pi.agent.setModel("c1", "s1", cwdRef, "provider", "model");
		await client.pi.agent.setThinking("c1", "s1", cwdRef, "high");

		expect(fetcher.mock.calls[0]?.[0]).toContain(
			"/api/clients/c1/pi/agent/s1/model",
		);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
		expect(fetcher.mock.calls[1]?.[0]).toContain(
			"/api/clients/c1/pi/agent/s1/thinking",
		);
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
	});

	it("attachments create/complete/delete 使用正确端点", async () => {
		const { client, fetcher } = makeClient();
		await client.pi.attachments.create("c1", [
			{ filename: "a.png", size: 100, mimeType: "image/png" },
		]);
		expect(fetcher.mock.calls[0]?.[0]).toContain(
			"/api/clients/c1/pi/attachments",
		);
		expect(fetcher.mock.calls[0]?.[1]?.method).toBe("POST");

		await client.pi.attachments.complete("c1", "f1");
		expect(fetcher.mock.calls[1]?.[0]).toContain(
			"/api/clients/c1/pi/attachments/f1/complete",
		);
		expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");

		await client.pi.attachments.delete("c1", "f1");
		expect(fetcher.mock.calls[2]?.[0]).toContain(
			"/api/clients/c1/pi/attachments/f1",
		);
		expect(fetcher.mock.calls[2]?.[1]?.method).toBe("DELETE");
	});
});

describe("Pi 显式导入三方法（list / preview / run）", () => {
	it("使用 client 作用域 URL；sourceName 走 URL 编码；import body 为 sourceNames", async () => {
		const request = vi.fn(async () => ({}));
		const pi = createPiApi({ request: request as never });

		await pi.sessions.importable("c1");
		expect(request).toHaveBeenLastCalledWith(
			"GET",
			"/api/clients/c1/pi/sessions/importable",
			undefined,
			undefined,
		);

		await pi.sessions.previewImportable("c1", "2026-09-01 10.00_a.jsonl");
		expect(request).toHaveBeenLastCalledWith(
			"GET",
			"/api/clients/c1/pi/sessions/importable/2026-09-01%2010.00_a.jsonl/preview",
			undefined,
			undefined,
		);

		await pi.sessions.import("c1", ["a.jsonl", "b.jsonl"]);
		expect(request).toHaveBeenLastCalledWith(
			"POST",
			"/api/clients/c1/pi/sessions/import",
			{ sourceNames: ["a.jsonl", "b.jsonl"] },
			undefined,
		);
	});
});
