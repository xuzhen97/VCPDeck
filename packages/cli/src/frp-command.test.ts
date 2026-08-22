import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFrpCommand } from "./frp-command.js";
import { saveCliConfig, type ConfigPaths } from "./config.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-frp-command-"));
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

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ port: number }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("测试 Server 未监听");
	return { port: address.port };
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

describe("frp command", () => {
	it("未知子命令与未知选项返回错误", async () => {
		await expect(runFrpCommand("create", [])).rejects.toThrow("FRP 命令");
		await expect(runFrpCommand(undefined, ["--help"])).resolves.toBeUndefined();
		await expect(runFrpCommand("instances", ["--watch"])).rejects.toThrow(
			"未知选项",
		);
	});

	it("instances 输出安全字段，绝不泄露 token 与 dashboard 密码", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if (url0(request) === "/api/frp/instances") {
				response.end(
					JSON.stringify({
						data: [
							{
								id: "i1",
								name: "prod-frps",
								serverAddr: "175.24.0.1",
								serverPort: 7000,
								authToken: "SUPER_SECRET_TOKEN",
								dashboardScheme: "http",
								dashboardHost: "175.24.0.1",
								dashboardPort: 7500,
								dashboardUser: "admin",
								dashboardPassword: "SUPER_SECRET_PASS",
								portRangeStart: 6000,
								portRangeEnd: 6100,
								isDefault: true,
								createdAt: "2026-08-01T00:00:00Z",
								updatedAt: "2026-08-22T00:00:00Z",
							},
						],
						total: 1,
						page: 1,
						pageSize: 100,
						totalPages: 1,
					}),
				);
				return;
			}
			response.end(JSON.stringify({}));
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFrpCommand("instances", ["--json"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		const output = lines.join("\n");
		expect(output).toContain("prod-frps");
		expect(output).toContain("175.24.0.1:7000");
		expect(output).not.toContain("SUPER_SECRET_TOKEN");
		expect(output).not.toContain("SUPER_SECRET_PASS");
		expect(output).not.toContain("vcp_test_token");
	});

	it("mappings 支持 --client 名称解析过滤", async () => {
		const requested: string[] = [];
		const { port } = await listen((request, response) => {
			const url = request.url ?? "";
			requested.push(url);
			response.setHeader("content-type", "application/json");
			if (url === "/api/clients") {
				response.end(
					JSON.stringify([
						{ clientId: "c9", name: "nas", online: true },
					]),
				);
				return;
			}
			if (url.startsWith("/api/frp/mappings")) {
				response.end(
					JSON.stringify({
						data: [
							{
								id: "m1",
								clientId: "c9",
								name: "nas-web",
								proxyType: "http",
								localIp: "127.0.0.1",
								localPort: 8080,
								remotePort: null,
								customDomain: "nas.example.com",
								status: "running",
								publicUrl: "https://nas.example.com",
								createdAt: "2026-08-01T00:00:00Z",
								updatedAt: "2026-08-22T00:00:00Z",
							},
						],
						total: 1,
						page: 1,
						pageSize: 20,
						totalPages: 1,
					}),
				);
				return;
			}
			response.end(JSON.stringify({}));
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFrpCommand("mappings", ["--client=nas"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		expect(requested.some((u) => u.startsWith("/api/frp/mappings?clientId=c9"))).toBe(
			true,
		);
		const output = lines.join("\n");
		expect(output).toContain("nas-web");
		expect(output).toContain("https://nas.example.com");
	});
});

function url0(request: IncomingMessage): string {
	return (request.url ?? "").split("?")[0];
}
