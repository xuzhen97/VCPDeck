import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
				auth: { type: "bearer", token: "vcp_test_token" },
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

/** 起一个只回 { mode: "server" } 的桩 Server，捕获每个上传会话的请求体。 */
async function uploadSessionsFixture(fileNames: string[]) {
	const sessions: Array<Record<string, unknown>> = [];
	const { port } = await listen((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			if (request.url === "/api/releases/uploads") {
				sessions.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				response.end(JSON.stringify({ mode: "server" }));
				return;
			}
			response.end(JSON.stringify({ release: release("uploaded") }));
		});
	});
	const state = await fixture(port);
	for (const name of fileNames) {
		await writeFile(join(state.root, name), `archive-${name}`);
	}
	return {
		sessions,
		state,
		zipPaths: fileNames.map((name) => join(state.root, name)),
	};
}

function runUploadFixture(
	fixture: Awaited<ReturnType<typeof uploadSessionsFixture>>,
) {
	return runReleaseCommand("upload", fixture.zipPaths, {
		paths: fixture.state.paths,
		processEnv: fixture.state.processEnv,
		log: () => undefined,
	});
}

describe("release command", () => {
	describe("内容寻址产物集合上传", () => {
		const V = "1.2.3";
		const full = (platform: string) => `vcpdeck-${V}-${platform}.zip`;
		const delta = (platform: string, from: string) =>
			`vcpdeck-${V}-${platform}-delta-${from}.zip`;
		/** 校验拒绝场景不应触碰环境解析，指向不存在的配置目录避免远程副作用。 */
		const offlineContext = {
			paths: {
				globalConfigPath: join(
					tmpdir(),
					"vcpdeck-release-offline",
					"config.json",
				),
				cwd: tmpdir(),
			},
			processEnv: {} as NodeJS.ProcessEnv,
			log: () => undefined,
		};

		it("platformOfFile 解析 full 与 delta 命名，uploadOne 透传 artifactKind/fromVersion，首个 full 会话带 expectedFromVersions", async () => {
			const f = await uploadSessionsFixture([
				full("win-x64"),
				full("linux-x64"),
				delta("win-x64", "1.2.2"),
				delta("linux-x64", "1.2.2"),
			]);

			await runUploadFixture(f);

			expect(f.sessions).toHaveLength(4);
			const fulls = f.sessions.filter((s) => s.artifactKind === "full");
			const deltas = f.sessions.filter((s) => s.artifactKind === "delta");
			expect(fulls).toHaveLength(2);
			expect(deltas).toHaveLength(2);
			expect(fulls.every((s) => s.fromVersion === "")).toBe(true);
			expect(deltas.map((s) => s.fromVersion).sort()).toEqual([
				"1.2.2",
				"1.2.2",
			]);
			const withExpected = f.sessions.filter(
				(s) => "expectedFromVersions" in s,
			);
			expect(withExpected).toHaveLength(1);
			expect(withExpected[0]).toMatchObject({
				artifactKind: "full",
				expectedFromVersions: ["1.2.2"],
			});
			expect(f.sessions[0]).toMatchObject({
				platform: "win-x64",
				artifactKind: "delta",
				fromVersion: "1.2.2",
			});
			// 上传顺序：增量先行，双平台 full 最后（服务端在双平台齐备后才启动更新）。
			expect(f.sessions.slice(2)).toEqual([
				expect.objectContaining({
					platform: "win-x64",
					artifactKind: "full",
					expectedFromVersions: ["1.2.2"],
				}),
				expect.objectContaining({
					platform: "linux-x64",
					artifactKind: "full",
					fromVersion: "",
				}),
			]);
			expect(deltas.every((s) => !("expectedFromVersions" in s))).toBe(true);
		});

		it("validateArchives 接受 2 full + 双平台各 3 delta 的完整集合", async () => {
			const from = ["1.2.0", "1.2.1", "1.2.2"];
			const f = await uploadSessionsFixture([
				full("win-x64"),
				full("linux-x64"),
				...from.map((v) => delta("win-x64", v)),
				...from.map((v) => delta("linux-x64", v)),
			]);

			await expect(runUploadFixture(f)).resolves.toBeUndefined();

			expect(f.sessions).toHaveLength(8);
			expect(
				f.sessions.find((s) => "expectedFromVersions" in s),
			).toMatchObject({
				artifactKind: "full",
				expectedFromVersions: ["1.2.0", "1.2.1", "1.2.2"],
			});
		});

		it("validateArchives 接受可选 musl 全量包，并优先上传 musl 构件", async () => {
			const f = await uploadSessionsFixture([
				full("linux-x64"),
				full("win-x64"),
				full("linux-x64-musl"),
			]);

			await runUploadFixture(f);

			expect(f.sessions).toHaveLength(3);
			expect(f.sessions[0]).toMatchObject({
				platform: "linux-x64-musl",
				artifactKind: "full",
			});
			const withExpected = f.sessions.filter(
				(s) => "expectedFromVersions" in s,
			);
			expect(withExpected).toHaveLength(1);
			expect(withExpected[0]).toMatchObject({
				platform: "linux-x64",
				expectedFromVersions: [],
			});
		});

		it("旧 Server 只接受四字段上传会话体时按兼容请求体重试直传会话", async () => {
			const sessions: Array<Record<string, unknown>> = [];
			const controlUrls: string[] = [];
			const { port } = await listen((request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					const url = request.url ?? "";
					controlUrls.push(url);
					response.setHeader("content-type", "application/json");
					if (url === "/api/releases/uploads") {
						const body = JSON.parse(
							Buffer.concat(chunks).toString("utf8"),
						) as Record<string, unknown>;
						sessions.push(body);
						// 0.23.4 的 Server 只接受四字段请求体，多带增量字段直接 400。
						if (Object.keys(body).length > 4) {
							response.statusCode = 400;
							response.end(
								JSON.stringify({
									message:
										"body 必须且只能包含 version/platform/sha256/size",
								}),
							);
							return;
						}
						response.end(
							JSON.stringify({
								mode: "direct",
								sessionId: `session-${String(body.platform)}`,
								partSize: 64,
								parts: [
									{
										partNumber: 1,
										url: `https://provider.example/${String(body.platform)}-p1`,
									},
								],
								expiresAt: "2026-08-22T00:00:00.000Z",
							}),
						);
						return;
					}
					response.end(JSON.stringify({ release: release("uploaded") }));
				});
			});
			const state = await fixture(port);
			const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
			const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
			await writeFile(win, "win-archive");
			await writeFile(linux, "linux-archive");
			const providerRequests: string[] = [];
			const directFetch = async (input: string | URL | Request) => {
				providerRequests.push(String(input));
				return new Response(null, { status: 200 });
			};
			const logs: string[] = [];

			await runReleaseCommand("upload", [win, linux], {
				paths: state.paths,
				processEnv: state.processEnv,
				directFetch: directFetch as typeof fetch,
				log: (message) => logs.push(message),
			});

			// 每个平台两次会话：多字段被旧 Server 拒绝 → 四字段重开成功
			expect(sessions).toHaveLength(4);
			expect(sessions.filter((body) => Object.keys(body).length === 4)).toHaveLength(
				2,
			);
			// 不再退到 legacy raw 上传，Alibaba 后端的旧 Server 会拒绝 raw 体
			expect(
				controlUrls.filter((url) => url.startsWith("/api/releases/upload?")),
			).toHaveLength(0);
			expect(providerRequests).toHaveLength(2);
			expect(logs.join("\n")).toContain("四字段上传会话");
		});

		it("旧 Server 不支持增量构件时跳过 delta，只直传全量包", async () => {
			const sessions: Array<Record<string, unknown>> = [];
			const controlUrls: string[] = [];
			const { port } = await listen((request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					const url = request.url ?? "";
					controlUrls.push(url);
					response.setHeader("content-type", "application/json");
					if (url === "/api/releases/uploads") {
						const body = JSON.parse(
							Buffer.concat(chunks).toString("utf8"),
						) as Record<string, unknown>;
						sessions.push(body);
						if (Object.keys(body).length > 4) {
							response.statusCode = 400;
							response.end(
								JSON.stringify({
									message:
										"body 必须且只能包含 version/platform/sha256/size",
								}),
							);
							return;
						}
						response.end(
							JSON.stringify({
								mode: "direct",
								sessionId: `session-${String(body.platform)}`,
								partSize: 64,
								parts: [
									{
										partNumber: 1,
										url: `https://provider.example/${String(body.platform)}-p1`,
									},
								],
								expiresAt: "2026-08-22T00:00:00.000Z",
							}),
						);
						return;
					}
					response.end(JSON.stringify({ release: release("uploaded") }));
				});
			});
			const state = await fixture(port);
			const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
			const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
			const delta = join(state.root, "vcpdeck-1.2.3-win-x64-delta-1.2.2.zip");
			const deltaLinux = join(
				state.root,
				"vcpdeck-1.2.3-linux-x64-delta-1.2.2.zip",
			);
			await writeFile(win, "win-archive");
			await writeFile(linux, "linux-archive");
			await writeFile(delta, "delta-archive");
			await writeFile(deltaLinux, "delta-archive-linux");
			const providerRequests: string[] = [];
			const directFetch = async (input: string | URL | Request) => {
				providerRequests.push(String(input));
				return new Response(null, { status: 200 });
			};
			const logs: string[] = [];

			await runReleaseCommand("upload", [win, linux, delta, deltaLinux], {
				paths: state.paths,
				processEnv: state.processEnv,
				directFetch: directFetch as typeof fetch,
				log: (message) => logs.push(message),
			});

			// 两个全量包各两次会话（多字段被拒 + 四字段成功），两个增量包各一次即放弃
			expect(sessions).toHaveLength(6);
			// 增量包未被当成全量上传
			expect(providerRequests).toHaveLength(2);
			expect(
				controlUrls.filter((url) => url.startsWith("/api/releases/upload?")),
			).toHaveLength(0);
			expect(logs.join("\n")).toContain("旧 Server 不支持增量构件");
		});

		const rejectCases: Array<{
			name: string;
			names: string[];
			message: string;
		}> = [
			{
				name: "拒绝缺一个平台的 delta",
				names: [
					full("win-x64"),
					full("linux-x64"),
					delta("win-x64", "1.2.0"),
					delta("win-x64", "1.2.1"),
					delta("win-x64", "1.2.2"),
					delta("linux-x64", "1.2.0"),
					delta("linux-x64", "1.2.1"),
				],
				message: "delta 基线版本集合必须一致",
			},
			{
				name: "拒绝两平台 fromVersion 集合不一致",
				names: [
					full("win-x64"),
					full("linux-x64"),
					delta("win-x64", "1.2.0"),
					delta("win-x64", "1.2.1"),
					delta("win-x64", "1.2.2"),
					delta("linux-x64", "1.2.0"),
					delta("linux-x64", "1.2.1"),
					delta("linux-x64", "1.1.9"),
				],
				message: "delta 基线版本集合必须一致",
			},
			{
				name: "拒绝 4 个 delta",
				names: [
					full("win-x64"),
					full("linux-x64"),
					delta("win-x64", "1.2.0"),
					delta("win-x64", "1.2.1"),
					delta("win-x64", "1.2.2"),
					delta("win-x64", "1.1.9"),
					delta("linux-x64", "1.2.0"),
					delta("linux-x64", "1.2.1"),
					delta("linux-x64", "1.2.2"),
					delta("linux-x64", "1.1.9"),
				],
				message: "delta 构件不得超过 3 个",
			},
			{
				name: "拒绝混用版本号",
				names: [
					full("win-x64"),
					full("linux-x64"),
					delta("win-x64", "1.2.2"),
					delta("linux-x64", "1.2.2"),
					"vcpdeck-1.2.4-linux-x64-delta-1.2.3.zip",
				],
				message: "必须使用相同版本号",
			},
			{
				name: "拒绝重复文件名",
				names: [full("win-x64"), full("win-x64"), full("linux-x64")],
				message: "构件文件名不得重复",
			},
			{
				name: "拒绝 musl 增量包",
				names: [
					full("win-x64"),
					full("linux-x64"),
					delta("linux-x64-musl", "1.2.2"),
				],
				message: "linux-x64-musl 只接受 full 构件",
			},
			{
				name: "拒绝重复的 musl 全量包",
				names: [
					full("win-x64"),
					full("linux-x64"),
					full("linux-x64-musl"),
					"vcpdeck-1.2.3-linux-x64-musl-delta-1.2.2.zip",
				],
				message: "linux-x64-musl 最多只能提供一个构件",
			},
		];
		for (const { name, names, message } of rejectCases) {
			it(name, async () => {
				await expect(
					runReleaseCommand("upload", names, offlineContext),
				).rejects.toThrow(message);
			});
		}
	});

	it("先校验本地构件，再要求环境配置", async () => {
		await expect(
			runReleaseCommand("upload", [
				"vcpdeck-1.2.3-win-x64.zip",
				"vcpdeck-1.2.4-linux-x64.zip",
			]),
		).rejects.toThrow("必须使用相同版本号");
	});

	it("Local 后端协商后使用命名 Bearer 环境上传两个平台构件", async () => {
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
				response.end(
					JSON.stringify(
						request.url === "/api/releases/uploads"
							? { mode: "server" }
							: { release: release("uploaded") },
					),
				);
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

		expect(requests).toHaveLength(4);
		expect(
			requests.every(
				(request) => request.authorization === "Bearer vcp_test_token",
			),
		).toBe(true);
		const raw = requests.filter((request) =>
			request.url.startsWith("/api/releases/upload?"),
		);
		expect(raw.map((request) => request.body)).toEqual([
			"win-archive",
			"linux-archive",
		]);
		expect(
			requests.filter((request) => request.url === "/api/releases/uploads"),
		).toHaveLength(2);
		expect(logs.join("\n")).toContain("环境: test");
		expect(logs.join("\n")).toContain("上传成功不代表更新完成");
		expect(logs.join("\n")).not.toContain("vcp_test_token");
	});

	it("Alibaba 模式只向 Provider 直传构件并在 403 时刷新 URL", async () => {
		const controlRequests: Array<{ url: string; body: string }> = [];
		const { port } = await listen((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8");
				const url = request.url ?? "";
				controlRequests.push({ url, body });
				response.setHeader("content-type", "application/json");
				if (url === "/api/releases/uploads") {
					const platform = JSON.parse(body).platform as string;
					response.end(
						JSON.stringify({
							mode: "direct",
							sessionId: `session-${platform}`,
							partSize: 64,
							parts: [
								{
									partNumber: 1,
									url: `https://provider.example/${platform}-stale`,
								},
							],
							expiresAt: "2026-08-22T00:00:00.000Z",
						}),
					);
					return;
				}
				if (url.endsWith("/parts")) {
					response.end(
						JSON.stringify({
							parts: [
								{
									partNumber: 1,
									url: "https://provider.example/win-x64-refreshed",
								},
							],
						}),
					);
					return;
				}
				response.end(JSON.stringify({ release: release("uploaded") }));
			});
		});
		const state = await fixture(port);
		const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
		const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
		await writeFile(win, "win-archive");
		await writeFile(linux, "linux-archive");
		const providerRequests: Array<{ url: string; body: string }> = [];
		const directFetch = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			const body = Buffer.from(init?.body as ArrayBuffer).toString("utf8");
			providerRequests.push({ url, body });
			if (url.endsWith("win-x64-stale"))
				return new Response(null, { status: 403 });
			return new Response(null, { status: 200 });
		};
		const logs: string[] = [];

		await runReleaseCommand("upload", [win, linux], {
			paths: state.paths,
			processEnv: state.processEnv,
			directFetch: directFetch as typeof fetch,
			directRetryDelayMs: 0,
			log: (message) => logs.push(message),
		});

		expect(
			controlRequests.some((request) =>
				request.url.startsWith("/api/releases/upload?"),
			),
		).toBe(false);
		expect(providerRequests.map((request) => request.body)).toEqual([
			"win-archive",
			"win-archive",
			"linux-archive",
		]);
		expect(
			controlRequests.some((request) => request.url.endsWith("/parts")),
		).toBe(true);
		expect(logs.join("\n")).not.toContain("provider.example");
		expect(logs.join("\n")).not.toContain("vcp_test_token");
	});

	it("Alibaba 恢复会话遇到已存在分片 409 时仍由 Provider 完成合并确认", async () => {
		const completed: string[] = [];
		const { port } = await listen((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/releases/uploads") {
					const platform = JSON.parse(Buffer.concat(chunks).toString("utf8")).platform as string;
					response.end(JSON.stringify({
						mode: "direct",
						sessionId: `session-${platform}`,
						partSize: 64,
						parts: [{ partNumber: 1, url: `https://provider.example/${platform}` }],
						expiresAt: "2026-08-22T00:00:00.000Z",
					}));
					return;
				}
				if (url.endsWith("/complete")) completed.push(url);
				response.end(JSON.stringify({ release: release("uploaded") }));
			});
		});
		const state = await fixture(port);
		const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
		const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
		await writeFile(win, "win-archive");
		await writeFile(linux, "linux-archive");
		const directFetch = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 409 }));

		await runReleaseCommand("upload", [win, linux], {
			paths: state.paths,
			processEnv: state.processEnv,
			directFetch: directFetch as typeof fetch,
			directRetryDelayMs: 0,
			log: () => undefined,
		});

		expect(completed).toHaveLength(2);
	});

	it("拒绝非 HTTPS Provider 分片 URL，且不发送构件正文", async () => {
		const { port } = await listen((request, response) => {
			request.resume();
			request.on("end", () => {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						mode: "direct",
						sessionId: "session-unsafe",
						partSize: 64,
						parts: [{ partNumber: 1, url: "http://provider.example/plain" }],
						expiresAt: "2026-08-22T00:00:00.000Z",
					}),
				);
			});
		});
		const state = await fixture(port);
		const win = join(state.root, "vcpdeck-1.2.3-win-x64.zip");
		const linux = join(state.root, "vcpdeck-1.2.3-linux-x64.zip");
		await writeFile(win, "win-archive");
		await writeFile(linux, "linux-archive");
		const directFetch = vi.fn();

		await expect(
			runReleaseCommand("upload", [win, linux], {
				paths: state.paths,
				processEnv: state.processEnv,
				directFetch: directFetch as typeof fetch,
				log: () => undefined,
			}),
		).rejects.toThrow("URL 不安全");
		expect(directFetch).not.toHaveBeenCalled();
	});

	it("upload --wait 上传后直接验收终态", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if (request.method === "POST") {
				request.resume();
				request.on("end", () =>
					response.end(
						JSON.stringify(
							request.url === "/api/releases/uploads"
								? { mode: "server" }
								: { release: release("uploaded") },
						),
					),
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

		await runReleaseCommand("upload", [win, linux, "--wait", "--timeout=2"], {
			paths: state.paths,
			processEnv: state.processEnv,
			pollIntervalMs: 10,
			requestTimeoutMs: 500,
			log: (message) => logs.push(message),
		});

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

	describe("release status 逐台明细", () => {
		it("列出机器名、失败类别与尝试次数", async () => {
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				if (request.url === "/api/clients") {
					response.end(
						JSON.stringify([
							{ clientId: "c1", name: "machine-a", online: true },
						]),
					);
					return;
				}
				if (request.url?.startsWith("/api/releases?")) {
					response.end(
						JSON.stringify({
							data: [
								{
									...release("done", {
										c1: { state: "failed", reason: "等待重连注册超时" },
									}),
									clientStates: {
										c1: {
											state: "failed",
											reason: "等待重连注册超时",
											at: "2026-08-18T00:00:00.000Z",
											kind: "transient",
											attempts: 2,
										},
									},
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
				response.end(JSON.stringify({ serverVersion: "1.2.3", activeRelease: null }));
			});
			const state = await fixture(port);
			const logs: string[] = [];

			await runReleaseCommand("status", ["1.2.3"], {
				paths: state.paths,
				processEnv: state.processEnv,
				log: (message) => logs.push(message),
			});

			const summary = logs.join("\n");
			expect(summary).toContain("逐台明细");
			expect(summary).toContain("machine-a");
			expect(summary).toContain("可重试");
			expect(summary).toContain("已试 2 次");
			expect(summary).toContain("等待重连注册超时");
		});
	});

	describe("release retry", () => {
		const clientInfo = {
			clientId: "c1",
			name: "machine-a",
			hostname: "machine-a",
			os: "win32 10.0.26200",
			clientVersion: "1.1.0",
			online: true,
		};

		it("按机器名解析 clientId 并显式指定版本重试", async () => {
			const requests: string[] = [];
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				requests.push(`${request.method} ${request.url}`);
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([clientInfo]));
					return;
				}
				if (request.url === "/api/releases/1.2.3/clients/c1/retry") {
					response.end(
						JSON.stringify({ version: "1.2.3", clientId: "c1", state: "retrying" }),
					);
					return;
				}
				response.statusCode = 404;
				response.end(JSON.stringify({ code: "RELEASE_NOT_FOUND" }));
			});
			const state = await fixture(port);
			const logs: string[] = [];

			await runReleaseCommand(
				"retry",
				["machine-a", "--version=1.2.3"],
				{
					paths: state.paths,
					processEnv: state.processEnv,
					log: (message) => logs.push(message),
				},
			);

			expect(requests).toContain(
				"POST /api/releases/1.2.3/clients/c1/retry",
			);
			expect(logs.join("\n")).toContain("目标版本: 1.2.3");
		});

		it("省略版本时使用当前补更目标", async () => {
			const requests: string[] = [];
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				requests.push(`${request.method} ${request.url}`);
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([clientInfo]));
					return;
				}
				if (request.url?.startsWith("/api/releases?")) {
					response.end(
						JSON.stringify({
							data: [
								{
									...release("done"),
									archives: {
										"win-x64": { sha256: "a", size: 1, fileName: "w.zip" },
										"linux-x64": { sha256: "b", size: 2, fileName: "l.zip" },
									},
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
				if (request.url === "/api/releases/1.2.3/clients/c1/retry") {
					response.end(
						JSON.stringify({ version: "1.2.3", clientId: "c1", state: "retrying" }),
					);
					return;
				}
				response.statusCode = 404;
				response.end("{}");
			});
			const state = await fixture(port);

			await runReleaseCommand("retry", ["machine-a"], {
				paths: state.paths,
				processEnv: state.processEnv,
				log: () => undefined,
			});

			expect(requests).toContain(
				"POST /api/releases/1.2.3/clients/c1/retry",
			);
		});

		it("没有补更目标且未指定版本时明确失败", async () => {
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([clientInfo]));
					return;
				}
				response.end(
					JSON.stringify({
						data: [],
						total: 0,
						page: 1,
						pageSize: 100,
						totalPages: 0,
					}),
				);
			});
			const state = await fixture(port);

			await expect(
				runReleaseCommand("retry", ["machine-a"], {
					paths: state.paths,
					processEnv: state.processEnv,
					log: () => undefined,
				}),
			).rejects.toThrow("没有可用的补更目标");
		});

		it("服务端拒绝永久失败时透出稳定错误码", async () => {
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				if (request.url === "/api/clients") {
					response.end(JSON.stringify([clientInfo]));
					return;
				}
				response.statusCode = 409;
				response.end(
					JSON.stringify({
						code: "RELEASE_RETRY_NOT_ALLOWED",
						message: "客户端 c1 属于永久失败，重试不会成功",
					}),
				);
			});
			const state = await fixture(port);

			await expect(
				runReleaseCommand("retry", ["machine-a", "--version=1.2.3"], {
					paths: state.paths,
					processEnv: state.processEnv,
					log: () => undefined,
				}),
			).rejects.toThrow(/RELEASE_RETRY_NOT_ALLOWED|永久失败/);
		});
	});
});
