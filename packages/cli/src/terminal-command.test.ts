import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadReconnectToken,
	runTerminalCommand,
} from "./terminal-command.js";
import { saveCliConfig, type ConfigPaths } from "./config.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-terminal-command-"));
	tempDirectories.push(root);
	const paths = { globalConfigPath: join(root, "config.json"), cwd: root };
	await saveCliConfig(paths.globalConfigPath, {
		version: 1,
		defaultEnvironment: "test",
		environments: {
			test: {
				server: `http://127.0.0.1:${port}`,
				auth: { type: "bearer", tokenEnv: "VCPDECK_TEST_TOKEN" },
			},
		},
	});
	return { paths, processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" } };
}

interface RecordedRequest {
	method: string;
	path: string;
}

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("terminal command", () => {
	it("未知子命令与缺参数返回错误；--help 零开销输出", async () => {
		await expect(runTerminalCommand("create", [])).rejects.toThrow(
			"Terminal 命令",
		);
		await expect(
			runTerminalCommand(undefined, ["--help"]),
		).resolves.toBeUndefined();
		await expect(runTerminalCommand("close", ["ws"])).rejects.toThrow(
			"Terminal 命令",
		);
	});

	it("shells 列出可用 shell", async () => {
		const server: Server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").split("?")[0] === "/api/clients") {
				response.end(
					JSON.stringify([{ clientId: "c1", name: "ws", online: true }]),
				);
				return;
			}
			if ((request.url ?? "").endsWith("/terminals/shells")) {
				response.end(
					JSON.stringify([
						{
							id: "pwsh",
							label: "PowerShell 7",
							kind: "pwsh",
							isDefault: true,
						},
						{ id: "cmd", label: "CMD", kind: "cmd", isDefault: false },
					]),
				);
				return;
			}
			response.end(JSON.stringify({}));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runTerminalCommand("shells", ["ws", "--json"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		const parsed = JSON.parse(lines.join("\n")) as Array<{ id: string }>;
		expect(parsed).toHaveLength(2);
		expect(parsed[0].id).toBe("pwsh");
	});

	it("new 创建终端会话：缺省选默认 shell，输出 attach 连接命令", async () => {
		let createBody: unknown = null;
		const server: Server = createServer((request, response) => {
			const path = (request.url ?? "").split("?")[0];
			response.setHeader("content-type", "application/json");
			if (path === "/api/clients") {
				response.end(
					JSON.stringify([{ clientId: "c1", name: "ws", online: true }]),
				);
				return;
			}
			if (path.endsWith("/terminals/shells")) {
				response.end(
					JSON.stringify([
						{ id: "pwsh", label: "PowerShell", kind: "powershell", isDefault: false },
						{ id: "cmd", label: "CMD", kind: "cmd", isDefault: true },
					]),
				);
				return;
			}
			if (path === "/api/clients/c1/terminals" && request.method === "POST") {
				let body = "";
				request.on("data", (c) => (body += c));
				request.on("end", () => {
					createBody = JSON.parse(body || "{}");
					response.end(
						JSON.stringify({
							sessionId: "ts-1",
							clientId: "c1",
							status: "active",
							shellId: "cmd",
							cols: 120,
							rows: 30,
							createdAt: "2026-08-23T00:00:00.000Z",
						}),
					);
				});
				return;
			}
			response.statusCode = 404;
			response.end("{}");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runTerminalCommand("new", ["ws"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		expect(createBody).toEqual({ shellId: "cmd", cols: 120, rows: 30 });
		const text = lines.join("\n");
		expect(text).toContain("已创建终端会话 ts-1");
		expect(text).toContain("vcpdeck terminal attach ws ts-1");
	});

	it("list 输出会话表格；--status 本地过滤", async () => {
		const requests: RecordedRequest[] = [];
		const server: Server = createServer((request, response) => {
			const url = request.url ?? "";
			requests.push({ method: request.method ?? "", path: url.split("?")[0] });
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").split("?")[0] === "/api/clients") {
				response.end(
					JSON.stringify([{ clientId: "c1", name: "ws", online: true }]),
				);
				return;
			}
			if (url.includes("/terminals") && !url.includes("/terminals/")) {
				response.end(
					JSON.stringify({
						data: [
							{
								sessionId: "t-1",
								clientId: "c1",
								shellId: "pwsh",
								shellLabel: "PowerShell 7",
								status: "active",
								cols: 120,
								rows: 30,
								createdByIdentityId: "i1",
								createdByName: "admin",
								createdAt: "2026-08-22T00:00:00Z",
								lastAttachedAt: null,
								detachedAt: null,
								expiresAt: null,
								endedAt: null,
								endReason: null,
								errorCode: null,
							},
							{
								sessionId: "t-2",
								clientId: "c1",
								shellId: "pwsh",
								shellLabel: "PowerShell 7",
								status: "ended",
								cols: 120,
								rows: 30,
								createdByIdentityId: "i1",
								createdByName: "admin",
								createdAt: "2026-08-21T00:00:00Z",
								lastAttachedAt: null,
								detachedAt: null,
								expiresAt: null,
								endedAt: "2026-08-21T01:00:00Z",
								endReason: "closed",
								errorCode: null,
							},
						],
						total: 2,
						page: 1,
						pageSize: 100,
						totalPages: 1,
					}),
				);
				return;
			}
			response.end(JSON.stringify({}));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runTerminalCommand("list", ["ws"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		expect(lines.join("\n")).toContain("终端会话（2）");
		expect(lines.join("\n")).toContain("t-1");

		const filtered: string[] = [];
		await runTerminalCommand("list", ["ws", "--status=ended"], {
			paths,
			processEnv,
			log: (m) => filtered.push(m),
		});
		expect(filtered.join("\n")).toContain("t-2");
		expect(filtered.join("\n")).not.toContain("t-1");
		expect(requests.some((r) => r.path.includes("/terminals"))).toBe(true);
	});

	it("close 先取详情再删除，输出目标摘要", async () => {
		const requests: RecordedRequest[] = [];
		const server: Server = createServer((request, response) => {
			const url = request.url ?? "";
			const path = url.split("?")[0];
			requests.push({ method: request.method ?? "", path });
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").split("?")[0] === "/api/clients") {
				response.end(
					JSON.stringify([{ clientId: "c1", name: "ws", online: true }]),
				);
				return;
			}
			if (
				path === "/api/clients/c1/terminals/t-9" &&
				request.method === "GET"
			) {
				response.end(
					JSON.stringify({
						sessionId: "t-9",
						clientId: "c1",
						shellId: "pwsh",
						shellLabel: "PowerShell 7",
						status: "active",
						cols: 120,
						rows: 30,
						createdByIdentityId: "i1",
						createdByName: "admin",
						createdAt: "2026-08-22T00:00:00Z",
						lastAttachedAt: null,
						detachedAt: null,
						expiresAt: null,
						endedAt: null,
						endReason: null,
						errorCode: null,
					}),
				);
				return;
			}
			response.end(
				JSON.stringify({
					sessionId: "t-9",
					clientId: "c1",
					shellId: "pwsh",
					shellLabel: "PowerShell 7",
					status: "ended",
					cols: 120,
					rows: 30,
					createdByIdentityId: "i1",
					createdByName: "admin",
					createdAt: "2026-08-22T00:00:00Z",
					lastAttachedAt: null,
					detachedAt: null,
					expiresAt: null,
					endedAt: "2026-08-22T01:00:00Z",
					endReason: "closed",
					errorCode: null,
				}),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runTerminalCommand("close", ["ws", "t-9"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		expect(
			requests.some(
				(r) => r.method === "DELETE" && r.path.endsWith("/terminals/t-9"),
			),
		).toBe(true);
		expect(lines.join("\n")).toContain("已关闭");
		expect(lines.join("\n")).toContain("创建者 admin");
	});
});

describe("terminal attach 重连令牌", () => {
	class FakeSocket {
		handlers = new Map<string, (payload?: unknown) => void>();
		attachPayloads: Array<Record<string, unknown>> = [];
		on(event: string, cb: (payload?: unknown) => void) {
			this.handlers.set(event, cb);
		}
		emit(
			event: string,
			payload?: unknown,
			cb?: (response: unknown) => void,
		) {
			if (event === "terminal:attach") {
				this.attachPayloads.push(payload as Record<string, unknown>);
				const token = (payload as { reconnectToken?: string }).reconnectToken;
				cb?.({
					ok: true,
					data: {
						attachmentId: `ta_${this.attachPayloads.length}`,
						reconnectToken: token ? "rt_2" : "rt_1",
						mode: "operator",
					},
				});
			}
		}
		disconnect() {}
	}

	function makeRestMock(): Server {
		const server: Server = createServer((request, response) => {
			const path = (request.url ?? "").split("?")[0];
			response.setHeader("content-type", "application/json");
			if (path === "/api/clients") {
				response.end(
					JSON.stringify([{ clientId: "c1", name: "ws", online: true }]),
				);
				return;
			}
			if (path === "/api/clients/c1/terminals/ts-1") {
				response.end(JSON.stringify({ shellLabel: "pwsh", status: "detached" }));
				return;
			}
			response.statusCode = 404;
			response.end("{}");
		});
		servers.push(server);
		return server;
	}

	async function waitFor(
		cond: () => boolean | Promise<boolean>,
		timeoutMs = 2000,
	) {
		const start = Date.now();
		while (!(await cond())) {
			if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	it("attach 后持久化重连令牌；再次 attach 回传令牌恢复操作权", async () => {
		makeRestMock();
		const sockets: FakeSocket[] = [];
		const input1 = new PassThrough();
		const server = servers[servers.length - 1];
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const { paths, processEnv } = await fixture(port);

		// 第一次 attach：无令牌 → ack 下发 rt_1 并落盘
		await runTerminalCommand("attach", ["ws", "ts-1"], {
			paths,
			processEnv,
			log: () => {},
			input: input1,
			stdout: new PassThrough(),
			socketFactory: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s as never;
			},
		});
		const storePath = join(
			dirname(paths.globalConfigPath),
			"terminal-reconnect.json",
		);
		await waitFor(() =>
			loadReconnectToken(storePath, "ts-1").then((t) => t === "rt_1"),
		);
		expect(await readFile(storePath, "utf8")).toContain("rt_1");
		expect(sockets[0].attachPayloads[0]).toEqual({ sessionId: "ts-1" });

		// 模拟 Ctrl+Q 结束第一次连接
		input1.write(Buffer.from([0x11]));
		await new Promise((r) => setTimeout(r, 30));

		// 第二次 attach：回传 rt_1，服务端下发新令牌 rt_2
		const input2 = new PassThrough();
		await runTerminalCommand("attach", ["ws", "ts-1"], {
			paths,
			processEnv,
			log: () => {},
			input: input2,
			stdout: new PassThrough(),
			socketFactory: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s as never;
			},
		});
		await waitFor(() => sockets.length >= 2 && sockets[1].attachPayloads.length > 0);
		expect(sockets[1].attachPayloads[0]).toEqual({
			sessionId: "ts-1",
			reconnectToken: "rt_1",
		});
		await waitFor(() =>
			loadReconnectToken(storePath, "ts-1").then((t) => t === "rt_2"),
		);

		// 收尾：Ctrl+Q 清理，避免悬挂句柄
		input2.write(Buffer.from([0x11]));
		await new Promise((r) => setTimeout(r, 30));
	});
});
