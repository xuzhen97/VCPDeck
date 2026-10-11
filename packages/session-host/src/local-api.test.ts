import type { AddressInfo } from "node:net";
import { parseSessionHostStatusReport } from "@vcpdeck/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createInstanceRegistry } from "./instance-registry.js";
import { createLocalApi } from "./local-api.js";
import { type PtySession, SnapshotTooLargeError } from "./pty-session.js";

const TOKEN = "a".repeat(64);
const HOST_ID = "host-1";

function fakeSession(instanceId: string, snapshotTooLarge = false) {
	let state: PtySession["state"] = "running";
	const written: string[] = [];
	const session: PtySession = {
		instanceId,
		get state() {
			return state;
		},
		lastSeq: 0,
		pendingBytes: 0,
		write(data: string) {
			written.push(data);
		},
		resize() {},
		async snapshot() {
			if (snapshotTooLarge) throw new SnapshotTooLargeError();
			return { seq: 0, snapshot: `screen:${written.join("")}`, cols: 80, rows: 24 };
		},
		async stop() {
			state = "stopped";
			return { exited: true };
		},
	};
	return { session, written };
}

type Harness = Awaited<ReturnType<typeof startServer>>;

async function startServer(
	overrides: { maxBodyBytes?: number; maxInputBytes?: number; snapshotTooLarge?: boolean } = {},
) {
	let next = 0;
	const spawned: string[] = [];
	const written: string[][] = [];
	const registry = createInstanceRegistry({
		createId: () => `inst_${++next}`,
		now: () => "2026-10-10T00:00:00.000Z",
		start: ({ instanceId }) => {
			spawned.push(instanceId);
			const { session, written: chunks } = fakeSession(instanceId, overrides.snapshotTooLarge === true);
			written.push(chunks);
			return session;
		},
	});
	const server = createLocalApi({ registry, token: TOKEN, hostId: HOST_ID, ...overrides });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		registry,
		spawned,
		written,
		base: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const open: Harness[] = [];
async function boot(
	overrides: { maxBodyBytes?: number; maxInputBytes?: number; snapshotTooLarge?: boolean } = {},
): Promise<Harness> {
	const harness = await startServer(overrides);
	open.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((h) => h.close()));
});

async function call(
	base: string,
	method: "GET" | "POST",
	route: string,
	options: { body?: unknown; token?: string | null } = {},
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
	const headers: Record<string, string> = {};
	const token = options.token === undefined ? TOKEN : options.token;
	if (token !== null) headers.authorization = `Bearer ${token}`;
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
	}
	const res = await fetch(`${base}${route}`, { method, headers, body });
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { status: res.status, text, json };
}

function errorOf(json: Record<string, unknown> | null): { code?: string; message?: string } {
	return (json?.error ?? {}) as { code?: string; message?: string };
}

describe("宿主本机接口：认证", () => {
	it("缺失令牌返回 401，且不触发任何实例操作", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", {
			token: null,
			body: { operationId: "op_1", kind: "pi", cwd: "/w" },
		});
		expect(res.status).toBe(401);
		expect(h.spawned).toEqual([]);
		expect(h.registry.size()).toBe(0);
	});

	it("错误令牌返回 401，且不触发任何实例操作", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", {
			token: "b".repeat(64),
			body: { operationId: "op_1", kind: "pi", cwd: "/w" },
		});
		expect(res.status).toBe(401);
		expect(h.spawned).toEqual([]);
	});

	it("认证先于路由与实例匹配：未认证访问未知路由也是 401 而非 404", async () => {
		const h = await boot();
		const res = await call(h.base, "GET", "/nope", { token: null });
		expect(res.status).toBe(401);
	});
});

describe("宿主本机接口：路由与严格输入", () => {
	it("身份接口返回 hostId", async () => {
		const h = await boot();
		const res = await call(h.base, "GET", "/identity");
		expect(res.status).toBe(200);
		expect(res.json?.hostId).toBe(HOST_ID);
	});

	it("未知路由返回 404，且响应不回显请求路径", async () => {
		const h = await boot();
		const res = await call(h.base, "GET", "/canary/route");
		expect(res.status).toBe(404);
		expect(res.text).not.toContain("/canary/route");
	});

	it("未知字段返回 400 与协议错误码", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", {
			body: { operationId: "op_1", kind: "pi", cwd: "/w", extra: 1 },
		});
		expect(res.status).toBe(400);
		expect(errorOf(res.json).code).toBe("SESSION_HOST_PROTOCOL_INVALID");
		expect(h.spawned).toEqual([]);
	});

	it("未知 kind 返回 400", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "node", cwd: "/w" } });
		expect(res.status).toBe(400);
	});

	it("无法解析的请求体返回 400", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", { body: "{not json" });
		expect(res.status).toBe(400);
	});

	it("缺失请求体返回 400", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", { body: "" });
		expect(res.status).toBe(400);
	});
});

describe("宿主本机接口：实例匹配与幂等", () => {
	it("同一 operationId 重复启动幂等复用，不重复创建", async () => {
		const h = await boot();
		const first = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const second = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(second.json?.instanceId).toBe(first.json?.instanceId);
		expect(second.json?.reused).toBe(true);
		expect(h.spawned).toHaveLength(1);
	});

	it("向不在运行的实例写输入返回 409", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const stop = await call(h.base, "POST", "/stop", { body: { instanceId } });
		expect(stop.status).toBe(200);
		expect(stop.json?.exited).toBe(true);
		const input = await call(h.base, "POST", "/input", { body: { instanceId, data: "hi" } });
		expect(input.status).toBe(409);
		expect(errorOf(input.json).code).toBe("SESSION_HOST_INSTANCE_CONFLICT");
	});

	it("未知实例返回 404 与 NOT_FOUND", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/input", { body: { instanceId: "inst_missing", data: "hi" } });
		expect(res.status).toBe(404);
		expect(errorOf(res.json).code).toBe("SESSION_HOST_INSTANCE_NOT_FOUND");
	});

	it("向匹配实例写输入被接受并写入会话", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const res = await call(h.base, "POST", "/input", { body: { instanceId, data: "hello" } });
		expect(res.status).toBe(200);
		expect(h.written[0]).toEqual(["hello"]);
	});

	it("resize 只接受受限整数尺寸", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const bad = await call(h.base, "POST", "/resize", { body: { instanceId, cols: 5, rows: 1 } });
		expect(bad.status).toBe(400);
		const ok = await call(h.base, "POST", "/resize", { body: { instanceId, cols: 120, rows: 30 } });
		expect(ok.status).toBe(200);
	});

	it("快照返回画面正文与尺寸", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		await call(h.base, "POST", "/input", { body: { instanceId, data: "hello" } });
		const res = await call(h.base, "POST", "/snapshot", { body: { instanceId } });
		expect(res.status).toBe(200);
		expect(res.json?.snapshot).toBe("screen:hello");
		expect(res.json?.cols).toBe(80);
		expect(res.json?.rows).toBe(24);
	});

	it("快照超限时明确返回 413", async () => {
		const h = await boot({ snapshotTooLarge: true });
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const res = await call(h.base, "POST", "/snapshot", { body: { instanceId } });
		expect(res.status).toBe(413);
	});

	it("快照未知实例返回 404", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/snapshot", { body: { instanceId: "inst_missing" } });
		expect(res.status).toBe(404);
		expect(errorOf(res.json).code).toBe("SESSION_HOST_INSTANCE_NOT_FOUND");
	});
});

describe("宿主本机接口：上限与有界失败", () => {
	it("输入超过 64 KiB 字节（汉字）返回 413", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const data = "汉".repeat(25000); // 75000 字节 > 65536，但 < 请求体上限
		expect(Buffer.byteLength(data, "utf8")).toBeGreaterThan(64 * 1024);
		const res = await call(h.base, "POST", "/input", { body: { instanceId, data } });
		expect(res.status).toBe(413);
		expect(h.written[0]).toEqual([]);
	});

	it("输入超过 64 KiB 字节（emoji 代理对）返回 413", async () => {
		const h = await boot();
		const started = await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "/w" } });
		const instanceId = started.json?.instanceId as string;
		const data = "🙂".repeat(20000); // 80000 字节
		expect(Buffer.byteLength(data, "utf8")).toBeGreaterThan(64 * 1024);
		const res = await call(h.base, "POST", "/input", { body: { instanceId, data } });
		expect(res.status).toBe(413);
	});

	it("请求体超过 128 KiB 返回 413，且服务仍可用", async () => {
		const h = await boot();
		const res = await call(h.base, "POST", "/start", { body: "x".repeat(140 * 1024) });
		expect(res.status).toBe(413);
		const after = await call(h.base, "GET", "/status");
		expect(after.status).toBe(200);
	});
});

describe("宿主本机接口：状态报告与泄露边界", () => {
	it("状态报告可被 shared 严格 parser 接受，且不含 cwd", async () => {
		const h = await boot();
		await call(h.base, "POST", "/start", { body: { operationId: "op_1", kind: "pi", cwd: "C:/secret/project" } });
		const res = await call(h.base, "GET", "/status");
		expect(res.status).toBe(200);
		const parsed = parseSessionHostStatusReport(res.json);
		expect(parsed.available).toBe(true);
		expect(parsed.hostId).toBe(HOST_ID);
		expect(parsed.instances).toHaveLength(1);
		expect(res.text).not.toContain("secret");
	});

	it("所有响应都不含令牌、工作目录与请求正文", async () => {
		const h = await boot();
		const canary = "CANARY-payload-9931";
		const responses = [
			await call(h.base, "GET", "/identity"),
			await call(h.base, "POST", "/start", {
				body: { operationId: canary, kind: "pi", cwd: "C:/secret/project" },
			}),
			await call(h.base, "GET", "/status"),
			await call(h.base, "POST", "/input", { body: { instanceId: "inst_missing", data: canary } }),
			await call(h.base, "GET", "/missing-route"),
			await call(h.base, "POST", "/start", { body: { operationId: "op_x", kind: "pi", cwd: "/w", extra: canary } }),
		];
		for (const res of responses) {
			expect(res.text).not.toContain(TOKEN);
			expect(res.text).not.toContain(canary);
			expect(res.text).not.toContain("secret");
		}
	});
});
