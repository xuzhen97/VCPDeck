import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionHostClient } from "./client.js";

const VALID = { port: 51234, token: "t".repeat(64), hostId: "host-1" };

const dirs: string[] = [];
async function dir(): Promise<string> {
	const created = await mkdtemp(path.join(os.tmpdir(), "session-host-client-"));
	dirs.push(created);
	return created;
}

async function controlFileWith(content: string | unknown): Promise<string> {
	const file = path.join(await dir(), "control.json");
	await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
	return file;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((created) => rm(created, { recursive: true, force: true })));
});

const REPORT = {
	available: true,
	hostId: "host-1",
	instances: [
		{ instanceId: "inst_1", kind: "pi", state: "running", startedAt: "2026-10-10T00:00:00.000Z", lastSeq: 3 },
	],
};
const UNAVAILABLE = { available: false, hostId: null, instances: [] };

interface Call {
	url: string;
	method: string;
	authorization?: string;
	body?: string;
	signal?: AbortSignal;
}

function fakeFetch(handler: (call: Call) => Promise<Response> | Response) {
	const calls: Call[] = [];
	const impl = (async (input: unknown, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			authorization: headers.authorization,
			body: typeof init?.body === "string" ? init.body : undefined,
			signal: init?.signal ?? undefined,
		};
		calls.push(call);
		return handler(call);
	}) as unknown as typeof fetch;
	return { impl, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 永不返回，只在超时信号触发时拒绝：用于验证超时语义。 */
function hangUntilAborted(call: Call): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});
}

describe("会话宿主本机客户端：不可达语义", () => {
	it("控制文件缺失时按不可达处理，且不发起任何请求", async () => {
		const file = path.join(await dir(), "control.json");
		const { impl, calls } = fakeFetch(() => json(REPORT));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.status()).toEqual(UNAVAILABLE);
		expect(calls).toHaveLength(0);
	});

	it("控制文件含多余字段、非法端口或非 JSON 时按不可达处理，不发起请求", async () => {
		const cases: Array<string | unknown> = [
			{ ...VALID, extra: 1 },
			{ ...VALID, port: 0 },
			{ ...VALID, port: 1.5 },
			{ ...VALID, token: "" },
			{ ...VALID, hostId: "" },
			"{not json",
		];
		for (const content of cases) {
			const file = await controlFileWith(content);
			const { impl, calls } = fakeFetch(() => json(REPORT));
			const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
			expect(await client.status()).toEqual(UNAVAILABLE);
			expect(calls).toHaveLength(0);
		}
	});

	it("连接失败按不可达处理，不抛出", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.status()).toEqual(UNAVAILABLE);
	});

	it("宿主报告非法 state 时按不可达处理，不把未知态当实例", async () => {
		const file = await controlFileWith(VALID);
		const broken = {
			available: true,
			hostId: "host-1",
			instances: [
				{ instanceId: "inst_1", kind: "pi", state: "zombie", startedAt: "2026-10-10T00:00:00.000Z", lastSeq: 0 },
			],
		};
		const { impl } = fakeFetch(() => json(broken));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.status()).toEqual(UNAVAILABLE);
	});

	it("非 200 响应按不可达处理", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch(() => json({ error: { message: "内部错误" } }, 500));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.status()).toEqual(UNAVAILABLE);
	});

	it("超时按不可达处理，且不重试", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch((call) => hangUntilAborted(call));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl, timeoutMs: 20 });
		expect(await client.status()).toEqual(UNAVAILABLE);
		expect(calls).toHaveLength(1);
	});
});

describe("会话宿主本机客户端：请求", () => {
	it("返回严格解析后的报告", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch(() => json(REPORT));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.status()).toEqual(REPORT);
	});

	it("请求指向本机端口并带 Bearer 令牌", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch(() => json(REPORT));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await client.status();
		expect(calls[0]?.url).toBe(`http://127.0.0.1:${VALID.port}/status`);
		expect(calls[0]?.authorization).toBe(`Bearer ${VALID.token}`);
	});

	it("每次调用都重新读取控制文件，跟上宿主重启后的新端口", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch(() => json(REPORT));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await client.status();
		await writeFile(file, JSON.stringify({ ...VALID, port: 51999 }), "utf8");
		await client.status();
		expect(calls[1]?.url).toBe("http://127.0.0.1:51999/status");
	});
});

describe("会话宿主本机客户端：start", () => {
	const REQUEST = { operationId: "op_1", kind: "pi" as const, cwd: "/w" };

	it("非法请求在本地就被拒绝，不发起请求", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch(() => json(REPORT));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await expect(client.start({ ...REQUEST, kind: "node" as never })).rejects.toThrow();
		await expect(client.start({ ...REQUEST, extra: 1 } as never)).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("启动后按 instanceId 在状态中定位并返回实例", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch((call) =>
			call.url.endsWith("/start") ? json({ hostId: "host-1", instanceId: "inst_1", reused: false }) : json(REPORT),
		);
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.start(REQUEST)).toEqual(REPORT.instances[0]);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
	});

	it("宿主不可达时明确失败，不返回伪造实例", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await expect(client.start(REQUEST)).rejects.toThrow();
	});

	it("宿主返回的实例不在状态中时明确失败", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch((call) =>
			call.url.endsWith("/start")
				? json({ hostId: "host-1", instanceId: "inst_other", reused: false })
				: json(REPORT),
		);
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await expect(client.start(REQUEST)).rejects.toThrow();
	});

	it("启动超时后不重发请求", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch((call) => hangUntilAborted(call));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl, timeoutMs: 20 });
		await expect(client.start(REQUEST)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
});

describe("会话宿主本机客户端：stop", () => {
	it("返回宿主确认的退出结果", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch(() => json({ hostId: "host-1", instanceId: "inst_1", exited: true }));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.stop("inst_1")).toEqual({ exited: true });
		expect(calls[0]?.method).toBe("POST");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ instanceId: "inst_1" });
	});

	it("宿主不可达时返回 exited: false，不伪装成已停止", async () => {
		const file = await controlFileWith(VALID);
		const { impl } = fakeFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		expect(await client.stop("inst_1")).toEqual({ exited: false });
	});

	it("宿主未确认退出（超时）时同样返回 false 且不重发", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch((call) => hangUntilAborted(call));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl, timeoutMs: 20 });
		expect(await client.stop("inst_1")).toEqual({ exited: false });
		expect(calls).toHaveLength(1);
	});

	it("非法 instanceId 在本地被拒绝，不发起请求", async () => {
		const file = await controlFileWith(VALID);
		const { impl, calls } = fakeFetch(() => json({ exited: true }));
		const client = createSessionHostClient({ controlFile: file, fetchImpl: impl });
		await expect(client.stop("")).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});
});
