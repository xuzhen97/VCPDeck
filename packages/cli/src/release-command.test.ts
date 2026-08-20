import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCliConfig, type ConfigPaths } from "./config.js";
import { runReleaseCommand } from "./release-command.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	root: string;
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-release-command-"));
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
	return {
		root,
		paths,
		processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" },
	};
}

function release(
	status: string,
	clientStates: Record<string, { state: string; reason?: string }> = {},
) {
	return {
		version: "1.2.3",
		archives: {},
		status,
		errorMessage: status === "failed" ? "prepare 失败" : null,
		createdAt: "2026-08-18T00:00:00.000Z",
		updatedAt: "2026-08-18T00:00:00.000Z",
		clientStates: Object.fromEntries(
			Object.entries(clientStates).map(([clientId, entry]) => [
				clientId,
				{ ...entry, at: "2026-08-18T00:00:00.000Z" },
			]),
		),
	};
}

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("测试 Server 未监听");
	return { server, port: address.port };
}

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) => new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("release command", () => {
	it("先校验本地构件，再要求环境配置", async () => {
		await expect(
			runReleaseCommand("upload", [
				"vcpdeck-1.2.3-win-x64.zip",
				"vcpdeck-1.2.4-linux-x64.zip",
			]),
		).rejects.toThrow("必须使用相同版本号");
	});

	it("使用命名 Bearer 环境上传两个平台构件", async () => {
		const requests: Array<{ url: string; authorization?: string; body: string }> =
			[];
		const { port } = await listen((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					url: request.url ?? "",
					authorization: request.headers.authorization,
					body: Buffer.concat(chunks).toString("utf8"),
				});
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ release: release("uploaded") }));
			});
		});
		const state = await fixture(port);
		const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
		const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
		await writeFile(win, "win-archive");
		await writeFile(linux, "linux-archive");
		const logs: string[] = [];

		await runReleaseCommand("upload", [win, linux], {
			paths: state.paths,
			processEnv: state.processEnv,
			log: (message) => logs.push(message),
		});

		expect(requests).toHaveLength(2);
		expect(requests.map((request) => request.authorization)).toEqual([
			"Bearer vcp_test_token",
			"Bearer vcp_test_token",
		]);
		expect(requests.map((request) => request.body)).toEqual([
			"win-archive",
			"linux-archive",
		]);
		expect(
			requests.every((request) => request.url.startsWith("/api/releases/upload?")),
		).toBe(true);
		expect(logs.join("\n")).toContain("环境: test");
		expect(logs.join("\n")).toContain("上传成功不代表更新完成");
		expect(logs.join("\n")).not.toContain("vcp_test_token");
	});

	it("upload --wait 上传后直接验收终态", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.method === "POST") {
				request.resume();
				request.on("end", () =>
					response.end(JSON.stringify({ release: release("uploaded") })),
				);
				return;
			}
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/releases?")
						? {
								data: [release("done", { c1: { state: "done" } })],
								total: 1,
								page: 1,
								pageSize: 100,
								totalPages: 1,
							}
						: { serverVersion: "1.2.3", activeRelease: null },
				),
			);
		});
		const state = await fixture(port);
		const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
		const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
		await writeFile(win, "win-archive");
		await writeFile(linux, "linux-archive");
		const logs: string[] = [];

		await runReleaseCommand(
			"upload",
			[win, linux, "--wait", "--timeout=2"],
			{
				paths: state.paths,
				processEnv: state.processEnv,
				pollIntervalMs: 10,
				requestTimeoutMs: 500,
				log: (message) => logs.push(message),
			},
		);

		expect(logs.join("\n")).toContain("发版 1.2.3 验收完成");
	});

	it("status 显示权威 Release、Server 和 Client 摘要", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/releases?")
						? {
								data: [release("done", { c1: { state: "done" } })],
								total: 1,
								page: 1,
								pageSize: 100,
								totalPages: 1,
							}
						: { serverVersion: "1.2.3", activeRelease: null },
				),
			);
		});
		const state = await fixture(port);
		const logs: string[] = [];

		await runReleaseCommand("status", ["1.2.3"], {
			paths: state.paths,
			processEnv: state.processEnv,
			log: (message) => logs.push(message),
		});

		expect(logs.join("\n")).toContain("Release: done");
		expect(logs.join("\n")).toContain("成功 1 · 失败 0");
	});

	it("wait 容忍 Server 暂时不可达，并等待全部 Client 成功", async () => {
		let listRequests = 0;
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.url?.startsWith("/api/releases?")) {
				listRequests++;
				if (listRequests === 1) {
					response.statusCode = 503;
					response.end(JSON.stringify({ message: "restarting" }));
					return;
				}
				const done = listRequests >= 3;
				response.end(
					JSON.stringify({
						data: [
							release(done ? "done" : "updating_clients", {
								c1: { state: done ? "done" : "updating" },
							}),
						],
						total: 1,
						page: 1,
						pageSize: 100,
						totalPages: 1,
					}),
				);
				return;
			}
			response.end(
				JSON.stringify({ serverVersion: "1.2.3", activeRelease: null }),
			);
		});
		const state = await fixture(port);
		const logs: string[] = [];

		await runReleaseCommand("wait", ["1.2.3", "--timeout=2"], {
			paths: state.paths,
			processEnv: state.processEnv,
			pollIntervalMs: 10,
			requestTimeoutMs: 500,
			log: (message) => logs.push(message),
		});

		expect(logs.join("\n")).toContain("Server 暂时不可达");
		expect(logs.join("\n")).toContain("发版 1.2.3 验收完成");
	});

	it("wait 在 Release failed 时立即返回失败", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/releases?")
						? {
								data: [release("failed")],
								total: 1,
								page: 1,
								pageSize: 100,
								totalPages: 1,
							}
						: { serverVersion: "1.2.2", activeRelease: null },
				),
			);
		});
		const state = await fixture(port);

		await expect(
			runReleaseCommand("wait", ["1.2.3", "--timeout=1"], {
				paths: state.paths,
				processEnv: state.processEnv,
				pollIntervalMs: 10,
				requestTimeoutMs: 500,
				log: () => undefined,
			}),
		).rejects.toThrow("prepare 失败");
	});

	it("wait 在 Release done 但 Client failed 时返回失败", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/releases?")
						? {
								data: [
									release("done", {
										c1: { state: "failed", reason: "launcher 回退" },
									}),
								],
								total: 1,
								page: 1,
								pageSize: 100,
								totalPages: 1,
							}
						: { serverVersion: "1.2.3", activeRelease: null },
				),
			);
		});
		const state = await fixture(port);

		await expect(
			runReleaseCommand("wait", ["1.2.3", "--timeout=1"], {
				paths: state.paths,
				processEnv: state.processEnv,
				pollIntervalMs: 10,
				requestTimeoutMs: 500,
				log: () => undefined,
			}),
		).rejects.toThrow("1 个 Client 更新失败");
	});

	it("wait 在终态未到达时超时", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.startsWith("/api/releases?")
						? {
								data: [
									release("updating_clients", {
										c1: { state: "updating" },
									}),
								],
								total: 1,
								page: 1,
								pageSize: 100,
								totalPages: 1,
							}
						: { serverVersion: "1.2.3", activeRelease: null },
				),
			);
		});
		const state = await fixture(port);

		await expect(
			runReleaseCommand("wait", ["1.2.3", "--timeout=1"], {
				paths: state.paths,
				processEnv: state.processEnv,
				pollIntervalMs: 10,
				requestTimeoutMs: 500,
				log: () => undefined,
			}),
		).rejects.toThrow("等待发版 1.2.3 超时");
	});
});
