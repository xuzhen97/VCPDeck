import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTerminalCommand } from "./terminal-command.js";
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
