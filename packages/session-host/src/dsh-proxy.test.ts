import http from "node:http";
import type { AddressInfo } from "node:net";
import type net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDshProxy } from "./dsh-proxy.js";

const TOKEN = "t".repeat(64);

interface Seen {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** 假 DSH：普通路由 + 精确 pathname 的 upgrade 路由 + fallback seat。 */
async function startFakeDsh() {
	const seen: Seen[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			if (req.url === "/deny") {
				res.writeHead(403, { "content-type": "text/plain" });
				res.end("denied-by-dsh");
				return;
			}
			if (req.url === "/boom") {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end("upstream-error");
				return;
			}
			if (req.url === "/boot") {
				res.writeHead(302, { location: "/", "set-cookie": "dsh=abc; Path=/; HttpOnly" });
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/plain", "x-upstream": "dsh" });
			res.end(`upstream:${req.method}:${req.url}`);
		});
	});
	server.on("upgrade", (req, socket, head) => {
		seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
		// 行为良好的服务端：对端不再说话就关掉自己这一半，不留半开连接。
		socket.on("end", () => socket.destroy());
		const key = String(req.headers["sec-websocket-key"] ?? "");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`,
		);
		if (head.length > 0) socket.write(head);
		socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
	});
	await listen(server);
	return { server, seen, port: (server.address() as AddressInfo).port };
}

function listen(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

const servers: Array<{ server: http.Server; sockets: Set<net.Socket> }> = [];
function track<T extends http.Server>(server: T): T {
	const sockets = new Set<net.Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	servers.push({ server, sockets });
	return server;
}

afterEach(async () => {
	const list = servers.splice(0);
	// upgraded 连接不会被 closeAllConnections 回收，必须显式销毁。
	for (const { sockets } of list) {
		for (const socket of sockets) socket.destroy();
	}
	await Promise.all(
		list.map(
			({ server }) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections?.();
					server.close(() => resolve());
				}),
		),
	);
});

async function startProxy(target: { host: string; port: number }, token = TOKEN) {
	const proxy = track(createDshProxy({ target, token }));
	await listen(proxy);
	return { proxy, port: (proxy.address() as AddressInfo).port };
}

async function request(
	port: number,
	method: string,
	path: string,
	options: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path, headers: options.headers ?? {} },
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk.toString();
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

function upgradeRequest(
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; socket: net.Socket; head: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: "127.0.0.1",
			port,
			path,
			headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
		});
		req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode ?? 0, socket, head }));
		req.on("response", (res) => reject(new Error(`expected upgrade, got ${res.statusCode}`)));
		req.on("error", reject);
		req.end();
	});
}

describe("DSH 反向代理：透明转发", () => {
	it("普通 GET 按原方法与原路径转发", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const res = await request(port, "GET", "/rpc?x=1&y=2");
		expect(res.status).toBe(200);
		expect(res.body).toBe("upstream:GET:/rpc?x=1&y=2");
		expect(res.headers["x-upstream"]).toBe("dsh");
		expect(dsh.seen[0]?.url).toBe("/rpc?x=1&y=2");
	});

	it("静态资源与 fallback seat（未知路径）原样转发", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await request(port, "GET", "/assets/app.js");
		await request(port, "GET", "/some/spa/route");
		expect(dsh.seen.map((entry) => entry.url)).toEqual(["/assets/app.js", "/some/spa/route"]);
	});

	it("请求体流式转发，不截断也不改写", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const payload = "x".repeat(200 * 1024);
		const res = await request(port, "POST", "/rpc", { body: payload });
		expect(res.status).toBe(200);
		expect(dsh.seen[0]?.body.length).toBe(payload.length);
	});

	it("Host 保持客户端目标的 authority，不注入伪造 authority", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await request(port, "GET", "/", { headers: { host: "dsh.example.internal:8443" } });
		const seen = dsh.seen[0];
		expect(seen?.headers.host).toBe("dsh.example.internal:8443");
		expect(seen?.headers["x-forwarded-host"]).toBeUndefined();
		expect(seen?.headers["x-forwarded-proto"]).toBeUndefined();
		expect(seen?.headers["x-forwarded-for"]).toBeUndefined();
	});

	it("丢弃入站的 x-forwarded-* 伪造头，也不新增", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await request(port, "GET", "/", {
			headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
		});
		expect(dsh.seen[0]?.headers["x-forwarded-host"]).toBeUndefined();
		expect(dsh.seen[0]?.headers["x-forwarded-proto"]).toBeUndefined();
	});

	it("Cookie 与 Set-Cookie 原样透传（authority 绑定不被破坏）", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await request(port, "GET", "/rpc", { headers: { cookie: "dsh=abc" } });
		expect(dsh.seen[0]?.headers.cookie).toBe("dsh=abc");

		const boot = await request(port, "GET", "/boot");
		expect(boot.status).toBe(302);
		expect(boot.headers.location).toBe("/");
		expect(boot.headers["set-cookie"]?.[0]).toContain("dsh=abc");
	});

	it("上游 4xx/5xx 原样透传，不改判为成功", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const denied = await request(port, "GET", "/deny");
		expect(denied.status).toBe(403);
		expect(denied.body).toBe("denied-by-dsh");
		const boom = await request(port, "GET", "/boom");
		expect(boom.status).toBe(500);
		expect(boom.body).toBe("upstream-error");
	});

	it("Origin 与 sec-fetch-site 原样交给 DSH 判定，代理不自己放行也不改写", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const res = await request(port, "POST", "/deny", {
			headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
			body: "{}",
		});
		expect(res.status).toBe(403);
		expect(dsh.seen[0]?.headers.origin).toBe("http://evil.example");
		expect(dsh.seen[0]?.headers["sec-fetch-site"]).toBe("cross-site");
	});

	it("上游不可达时返回稳定 502，不伪装成功", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await new Promise<void>((resolve) => dsh.server.close(() => resolve()));
		const res = await request(port, "GET", "/");
		expect(res.status).toBe(502);
		expect(res.body).not.toContain("ECONNREFUSED");
	});
});

describe("DSH 反向代理：凭据与日志", () => {
	it("绝不把本机令牌转发给上游，也不出现在响应里", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const res = await request(port, "GET", "/rpc", { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(dsh.seen[0]?.headers.authorization).toBeUndefined();
		expect(res.body).not.toContain(TOKEN);
		expect(res.headers["x-upstream"]).toBe("dsh");
	});

	it("proxy-authorization 同样不转发", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		await request(port, "GET", "/", { headers: { "proxy-authorization": `Bearer ${TOKEN}` } });
		expect(dsh.seen[0]?.headers["proxy-authorization"]).toBeUndefined();
	});

	it("代理不打印任何日志（正文与令牌都不进日志）", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await request(port, "POST", "/rpc", {
				headers: { authorization: `Bearer ${TOKEN}` },
				body: "secret-body-content",
			});
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
			error.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("DSH 反向代理：WebSocket upgrade", () => {
	it("按精确 pathname 建立 upgrade 并双向传字节", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const { status, socket } = await upgradeRequest(port, "/ws/session?token=abc");
		expect(status).toBe(101);
		expect(dsh.seen[0]?.url).toBe("/ws/session?token=abc");

		const echoed = await new Promise<string>((resolve) => {
			socket.once("data", (chunk) => resolve(chunk.toString()));
			socket.write(Buffer.from("ping"));
		});
		expect(echoed).toBe("echo:ping");
		socket.destroy();
	});

	it("upgrade 也不向上游转发本机令牌", async () => {
		const dsh = await startFakeDsh();
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const { socket } = await upgradeRequest(port, "/ws", { authorization: `Bearer ${TOKEN}` });
		expect(dsh.seen[0]?.headers.authorization).toBeUndefined();
		socket.destroy();
	});

	it("上游拒绝 upgrade 时原样回状态码，不伪装成 101", async () => {
		const upstream = track(
			http.createServer((_req, res) => {
				res.writeHead(403, { "content-type": "text/plain" });
				res.end("no-upgrade");
			}),
		);
		await listen(upstream);
		const { port } = await startProxy({ host: "127.0.0.1", port: (upstream.address() as AddressInfo).port });
		await expect(upgradeRequest(port, "/ws")).rejects.toThrow(/expected upgrade, got 403/);
	});

	it("客户端断开后上游连接也被回收（不留悬挂管道）", async () => {
		const dsh = await startFakeDsh();
		let upstreamClosed = false;
		dsh.server.on("upgrade", (_req, socket) => {
			socket.on("close", () => {
				upstreamClosed = true;
			});
		});
		const { port } = await startProxy({ host: "127.0.0.1", port: dsh.port });
		const { socket } = await upgradeRequest(port, "/ws");
		await new Promise<void>((resolve) => socket.once("close", () => resolve()).destroy());
		const deadline = Date.now() + 5000;
		while (!upstreamClosed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(upstreamClosed).toBe(true);
	});
});
