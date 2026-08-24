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

	it("mapping create 的 --env 与机器名解析使用同一环境", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/api/clients") {
				response.end(JSON.stringify([{ clientId: "prod-c1", name: "nas", online: true }]));
				return;
			}
			if (request.method === "POST") {
				response.end(JSON.stringify({ id: "fm_1", operationJobId: "job-1" }));
				return;
			}
			if (request.url === "/api/jobs/job-1") {
				response.end(JSON.stringify({ jobId: "job-1", status: "error", errorCode: "FRP_PROXY_CONFIRM_TIMEOUT" }));
				return;
			}
		});
		const { paths, processEnv } = await fixture(port);
		await expect(
			runFrpCommand(
				"mapping",
				["create", "nas", "--local-port=1919", "--env=test"],
				{ paths, processEnv, pollIntervalMs: 1 },
			),
		).rejects.toMatchObject({ code: "FRP_PROXY_CONFIRM_TIMEOUT" });
	});

	it("mapping create TCP name 可选，等待 active 后输出最终映射", async () => {
		const requests: Array<{ method?: string; url?: string; body?: string }> = [];
		let jobReads = 0;
		const { port } = await listen((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				requests.push({ method: request.method, url: request.url, body });
				response.setHeader("content-type", "application/json");
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([{ clientId: "c1", name: "nas", online: true }]));
					return;
				}
				if (request.method === "POST" && request.url === "/api/frp/mappings") {
					response.end(JSON.stringify({
						id: "fm_1", clientId: "c1", frpsInstanceId: "frps_1",
						name: "tcp-1919", proxyType: "tcp", localIp: "127.0.0.1",
						localPort: 1919, remotePort: 20000, customDomain: null,
						status: "provisioning", publicUrl: "frps.example.com:20000",
						operationJobId: "job-1", errorCode: null, errorMessage: null,
						createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
					}));
					return;
				}
				if (request.url === "/api/jobs/job-1") {
					jobReads++;
					response.end(JSON.stringify({ jobId: "job-1", status: "done", result: { mappingId: "fm_1", status: "active" } }));
					return;
				}
				if (request.url === "/api/frp/mappings/fm_1") {
					response.end(JSON.stringify({
						id: "fm_1", clientId: "c1", frpsInstanceId: "frps_1",
						name: "tcp-1919", proxyType: "tcp", localIp: "127.0.0.1",
						localPort: 1919, remotePort: 20000, customDomain: null,
						status: "active", publicUrl: "frps.example.com:20000",
						operationJobId: null, errorCode: null, errorMessage: null,
						createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:01Z",
					}));
					return;
				}
				response.statusCode = 404;
				response.end(JSON.stringify({ message: "not found" }));
			});
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFrpCommand(
			"mapping",
			["create", "nas", "--local-port=1919", "--json"],
			{ paths, processEnv, log: (message) => lines.push(message), pollIntervalMs: 1 },
		);
		const create = requests.find((entry) => entry.method === "POST");
		expect(JSON.parse(create?.body ?? "{}")).toEqual({
			clientId: "c1", proxyType: "tcp", localIp: "127.0.0.1",
			localPort: 1919, timeoutSeconds: 30,
		});
		expect(jobReads).toBe(1);
		expect(JSON.parse(lines.join("\n"))).toMatchObject({ status: "active" });
	});

	it.each(["http", "https"] as const)("mapping create %s 传递 domain/name/instance", async (proxyType) => {
		let createBody: Record<string, unknown> = {};
		const { port } = await listen((request, response) => {
			let body = "";
			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				response.setHeader("content-type", "application/json");
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([{ clientId: "c1", name: "nas", online: true }]));
					return;
				}
				if (request.method === "POST") {
					createBody = JSON.parse(body);
					response.end(JSON.stringify({ id: "fm_1", operationJobId: "job-1" }));
					return;
				}
				if (request.url === "/api/jobs/job-1") {
					response.end(JSON.stringify({ jobId: "job-1", status: "error", errorCode: "FRP_PROXY_CONFIRM_TIMEOUT", errorMessage: "已自动回滚" }));
					return;
				}
			});
		});
		const { paths, processEnv } = await fixture(port);
		await expect(runFrpCommand("mapping", [
			"create", "nas", `--type=${proxyType}`, "--local-port=8080",
			"--domain=app.example.com", "--name=web", "--instance=frps_1", "--timeout=45",
		], { paths, processEnv, pollIntervalMs: 1 })).rejects.toMatchObject({
			code: "FRP_PROXY_CONFIRM_TIMEOUT",
		});
		expect(createBody).toMatchObject({
			clientId: "c1", proxyType, localPort: 8080, customDomain: "app.example.com",
			name: "web", frpsInstanceId: "frps_1", timeoutSeconds: 45,
		});
		expect(createBody).not.toHaveProperty("remotePort");
	});

	it("mapping delete 等待 Dashboard 确认后才输出 deleted", async () => {
		const requested: string[] = [];
		const { port } = await listen((request, response) => {
			requested.push(`${request.method} ${request.url}`);
			response.setHeader("content-type", "application/json");
			if (request.method === "DELETE") {
				response.end(JSON.stringify({ id: "fm_1", status: "deleting", operationJobId: "delete-job" }));
				return;
			}
			if (request.url === "/api/jobs/delete-job") {
				response.end(JSON.stringify({ jobId: "delete-job", status: "done", result: { mappingId: "fm_1", deleted: true } }));
				return;
			}
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFrpCommand("mapping", ["delete", "fm_1", "--timeout=45", "--json"], {
			paths, processEnv, log: (message) => lines.push(message), pollIntervalMs: 1,
		});
		expect(requested).toContain("DELETE /api/frp/mappings/fm_1?timeoutSeconds=45");
		expect(JSON.parse(lines.join("\n"))).toEqual({ id: "fm_1", deleted: true });
	});

	it("mapping 参数边界严格拒绝", async () => {
		await expect(runFrpCommand("mapping", ["create", "nas"])).rejects.toThrow("--local-port");
		await expect(runFrpCommand("mapping", ["create", "nas", "--local-port=1919", "--type=udp"])).rejects.toThrow("--type");
		await expect(runFrpCommand("mapping", ["delete", "fm_1", "--timeout=0"])).rejects.toThrow("--timeout");
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
