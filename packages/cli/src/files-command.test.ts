import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFilesCommand } from "./files-command.js";
import { saveCliConfig, type ConfigPaths } from "./config.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-files-command-"));
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
	return { paths, processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" } };
}

interface RecordedJob {
	type?: string;
	payload?: Record<string, unknown>;
}

/** 模拟 Server：解析 clientId → 创建 file Job → 立即 done 并返回 result。 */
async function listenWithJobs(
	options: {
		clientName?: string;
		roots?: string[];
		onJob?: (job: RecordedJob) => Record<string, unknown> | { fail: string };
	} = {},
): Promise<{ port: number; jobs: RecordedJob[] }> {
	const jobs: RecordedJob[] = [];
	let jobSeq = 0;
	const server = createServer((request, response) => {
		const url = request.url ?? "";
		response.setHeader("content-type", "application/json");
		if (url === "/api/clients") {
			response.end(
				JSON.stringify([
					{
						clientId: "client-1",
						name: options.clientName ?? "workstation",
						online: true,
					},
				]),
			);
			return;
		}
		if (url === "/api/jobs" && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					clientId: string;
					type: string;
					payload: Record<string, unknown>;
				};
				jobs.push({ type: body.type, payload: body.payload });
				jobSeq += 1;
				const jobId = `job-${jobSeq}`;
				let result: Record<string, unknown> | { fail: string };
				if (body.type === "file.roots") {
					result = { roots: options.roots ?? ["D:\\"] };
				} else if (options.onJob) {
					result = options.onJob({ type: body.type, payload: body.payload });
				} else {
					result = {};
				}
				if ("fail" in result) {
					const failed = {
						jobId,
						status: "error",
						errorCode: result.fail,
						errorMessage: null,
						result: { errorCode: result.fail },
					};
					failedJobs.set(jobId, failed);
					response.end(JSON.stringify(failed));
					return;
				}
				response.end(
					JSON.stringify({
						jobId,
						status: "running",
						type: body.type,
					}),
				);
				// 模拟异步终态：下一次 GET 返回 done
				pendingResults.set(jobId, result);
			});
			return;
		}
		const jobId = url.match(/\/api\/jobs\/([^/]+)/)?.[1];
		const failed = jobId ? failedJobs.get(jobId) : undefined;
		if (failed) {
			response.end(JSON.stringify(failed));
			return;
		}
		const stored = jobId ? pendingResults.get(jobId) : undefined;
		response.end(
			JSON.stringify({
				jobId,
				status: "done",
				result: stored ?? {},
			}),
		);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("测试 Server 未监听");
	return { port: address.port, jobs };
}

const pendingResults = new Map<string, Record<string, unknown>>();
const failedJobs = new Map<string, Record<string, unknown>>();

afterEach(async () => {
	pendingResults.clear();
	failedJobs.clear();
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

describe("files command", () => {
	it("未知子命令与缺 path 返回用法错误", async () => {
		await expect(runFilesCommand("write", [])).rejects.toThrow("Files 命令");
		await expect(runFilesCommand(undefined, ["--help"])).resolves.toBeUndefined();
		await expect(runFilesCommand("list", ["ws"])).rejects.toThrow("Files 命令");
	});

	it("roots 列出可用根目录", async () => {
		const { port } = await listenWithJobs({ roots: ["C:\\", "D:\\"] });
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand("roots", ["workstation"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		const output = lines.join("\n");
		expect(output).toContain("可用根目录（2）");
		expect(output).toContain("C:\\");
		expect(output).not.toContain("vcp_test_token");
	});

	it("--env 覆盖时用该环境解析 Client，不回落默认环境", async () => {
		const { port } = await listenWithJobs({ roots: ["/"] });
		const { paths, processEnv } = await fixture(port);
		await saveCliConfig(paths.globalConfigPath, {
			version: 1,
			defaultEnvironment: "dead",
			environments: {
				dead: {
					server: "http://127.0.0.1:1",
					auth: { type: "bearer", token: "vcp_dead_token" },
				},
				test: {
					server: `http://127.0.0.1:${port}`,
					auth: { type: "bearer", token: "vcp_test_token" },
				},
			},
		});
		const lines: string[] = [];
		await runFilesCommand("roots", ["workstation", "--env=test"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		expect(lines.join("\n")).toContain("可用根目录（1）");
	});

	it("list 缺省 --root 时自动探测唯一根并展示排序表格", async () => {
		const entries = [
			{
				name: "b.txt",
				kind: "file" as const,
				size: 3,
				mtime: "2026-08-22T00:00:00Z",
			},
			{
				name: "sub",
				kind: "dir" as const,
				size: 0,
				mtime: "2026-08-21T00:00:00Z",
			},
			{
				name: "a.txt",
				kind: "file" as const,
				size: 1,
				mtime: "2026-08-20T00:00:00Z",
			},
		];
		const { port, jobs } = await listenWithJobs({
			roots: ["D:\\data"],
			onJob: ({ type }) => (type === "file.list" ? { entries } : {}),
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand("list", ["workstation", "docs"], {
			paths,
			processEnv,
			pollIntervalMs: 1,
			log: (message) => lines.push(message),
		});
		const fileJob = jobs.find((job) => job.type === "file.list");
		expect(fileJob?.payload).toEqual({ rootDir: "D:\\data", path: "docs" });
		const output = lines.join("\n");
		expect(output).toContain("共 3 项 · 目录 1 · 文件 2");
		expect(output.indexOf("sub")).toBeLessThan(output.indexOf("a.txt"));
	});

	it("--root 显式指定时不探测；多根且缺省时报错要求指定", async () => {
		const explicit = await listenWithJobs({
			roots: ["C:\\", "D:\\"],
			onJob: ({ type }) => (type === "file.list" ? { entries: [] } : {}),
		});
		const first = await fixture(explicit.port);
		const lines: string[] = [];
		await runFilesCommand("list", ["workstation", "x", "--root=D:\\", "--json"], {
			paths: first.paths,
			processEnv: first.processEnv,
			pollIntervalMs: 1,
			log: (m) => lines.push(m),
		});
		const parsed = JSON.parse(lines.join("\n")) as { entries: unknown[] };
		expect(parsed.entries).toEqual([]);

		const ambiguous = await listenWithJobs({ roots: ["C:\\", "D:\\"] });
		const second = await fixture(ambiguous.port);
		await expect(
			runFilesCommand("list", ["workstation", "x"], {
				paths: second.paths,
				processEnv: second.processEnv,
				pollIntervalMs: 1,
				log: () => {},
			}),
		).rejects.toThrow("--root=<dir> 指定授权根");
	});

	it("read 输出文本内容；失败 Job 转为带错误码的异常", async () => {
		const ok = await listenWithJobs({
			onJob: ({ type }) =>
				type === "file.readText" ? { content: "hello\nworld\n", size: 13 } : {},
		});
		const first = await fixture(ok.port);
		const lines: string[] = [];
		await runFilesCommand(
			"read",
			["workstation", "notes.txt", "--max-bytes=1024"],
			{
				paths: first.paths,
				processEnv: first.processEnv,
				pollIntervalMs: 1,
				log: (message) => lines.push(message),
			},
		);
		expect(lines.join("\n")).toContain("── ");
		expect(lines.join("\n")).toContain("13 bytes");
		expect(lines.join("\n")).toContain("hello");

		const bad = await listenWithJobs({
			onJob: () => ({ fail: "PATH_NOT_FOUND" }),
		});
		const second = await fixture(bad.port);
		await expect(
			runFilesCommand("read", ["workstation", "missing.txt"], {
				paths: second.paths,
				processEnv: second.processEnv,
				pollIntervalMs: 1,
				log: () => {},
			}),
		).rejects.toThrow("PATH_NOT_FOUND");
	});

	it("stat 输出元信息；--json 输出原始结果", async () => {
		const statShape = {
			name: "big.log",
			kind: "file",
			size: 4096,
			mtime: "2026-08-22T01:00:00Z",
		};
		const { port } = await listenWithJobs({
			roots: ["D:\\"],
			onJob: ({ type }) => (type === "file.stat" ? statShape : {}),
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand("stat", ["workstation", "logs/big.log", "--json"], {
			paths,
			processEnv,
			pollIntervalMs: 1,
			log: (message) => lines.push(message),
		});
		expect(JSON.parse(lines.join("\n"))).toEqual(statShape);
	});

	describe("files 写操作", () => {
		it("write 用 --input 本地文件作为内容并覆盖写入", async () => {
			const inputPath = join(
				await mkdtemp(join(tmpdir(), "vcpdeck-files-write-")),
				"content.txt",
			);
			tempDirectories.push(inputPath); // rm 递归删除父目录即可
			await writeFile(inputPath, "hello vcpdeck\n", "utf8");
			const { port, jobs } = await listenWithJobs({
				roots: ["D:\\"],
				onJob: ({ type }) =>
					type === "file.writeText" ? { path: "D:/x.txt" } : {},
			});
			const { paths, processEnv } = await fixture(port);
			const lines: string[] = [];
			await runFilesCommand(
				"write",
				["workstation", "x.txt", "--input=" + inputPath, "--json"],
				{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
			);
			const fileJob = jobs.find((job) => job.type === "file.writeText");
			// payload 形状由 Server normalizeAndValidateExecPayload 同源约定决定
			expect(fileJob?.payload).toEqual({
				rootDir: "D:\\",
				path: "x.txt",
				content: "hello vcpdeck\n",
			});
			expect(JSON.parse(lines.join("\n"))).toEqual({
				path: "D:/x.txt",
				bytes: 14,
			});
		});

		it("delete 默认非递归；--recursive 时 payload 带 recursive=true", async () => {
			const { port, jobs } = await listenWithJobs({
				roots: ["D:\\"],
				onJob: () => ({ path: "deleted" }),
			});
			const { paths, processEnv } = await fixture(port);
			await runFilesCommand("delete", ["workstation", "tmp/old"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			});
			await runFilesCommand("delete", ["workstation", "tmp/tree", "--recursive"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			});
			const deleteJobs = jobs.filter((job) => job.type === "file.delete");
			expect(deleteJobs[0]?.payload).toEqual({ rootDir: "D:\\", path: "tmp/old" });
			expect(deleteJobs[1]?.payload).toEqual({
				rootDir: "D:\\",
				path: "tmp/tree",
				recursive: true,
			});
		});

		it("mkdir/move 的 payload 形状与覆盖语义正确", async () => {
			const { port, jobs } = await listenWithJobs({
				roots: ["D:\\"],
				onJob: () => ({ path: "ok" }),
			});
			const { paths, processEnv } = await fixture(port);
			await runFilesCommand("mkdir", ["workstation", "a/b/c"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			});
			await runFilesCommand(
				"move",
				["workstation", "a.txt", "b.txt", "--overwrite"],
				{ paths, processEnv, pollIntervalMs: 1, log: () => {} },
			);
			expect(jobs.find((job) => job.type === "file.mkdir")?.payload).toEqual({
				rootDir: "D:\\",
				path: "a/b/c",
			});
			expect(jobs.find((job) => job.type === "file.move")?.payload).toEqual({
				rootDir: "D:\\",
				source: "a.txt",
				destination: "b.txt",
				overwrite: true,
			});
		});

		it("失败 Job 转为带稳定错误码的异常（如目录非空 PATH_CONFLICT）", async () => {
			const { port } = await listenWithJobs({
				roots: ["D:\\"],
				onJob: ({ type }) =>
					type === "file.delete" ? { fail: "PATH_CONFLICT" } : { path: "ok" },
			});
			const { paths, processEnv } = await fixture(port);
			await expect(
				runFilesCommand("delete", ["workstation", "docs"], {
					paths,
					processEnv,
					pollIntervalMs: 1,
					log: () => {},
				}),
			).rejects.toThrow("PATH_CONFLICT");
		});
	});

	describe("文件传输", () => {
		it("download 经导出 Job 与签名 URL 拉取并校验 sha256", async () => {
			const content = "hello transfer";
			const sha256 = createHash("sha256").update(content).digest("hex");
			let downloadTokenRequested: unknown;
			const server = createServer((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "c1", name: "workstation", online: true }]),
					);
					return;
				}
				if (url === "/api/jobs" && request.method === "POST") {
					const chunks: Buffer[] = [];
					request.on("data", (c: Buffer) => chunks.push(c));
					request.on("end", () => {
						const body = JSON.parse(Buffer.concat(chunks).toString());
						expect(body.type).toBe("file.export");
						response.end(
							JSON.stringify({
								jobId: "exp-1",
								status: "running",
								type: "file.export",
							}),
						);
					});
					return;
				}
				if (url === "/api/jobs/exp-1") {
					response.end(
						JSON.stringify({
							jobId: "exp-1",
							status: "done",
							result: {
								fileId: "f1",
								key: "exports/f1",
								size: content.length,
								sha256,
							},
						}),
					);
					return;
				}
				if (url === "/api/storage/download-token" && request.method === "POST") {
					const chunks: Buffer[] = [];
					request.on("data", (c: Buffer) => chunks.push(c));
					request.on("end", () => {
						downloadTokenRequested = JSON.parse(Buffer.concat(chunks).toString());
						response.end(
							JSON.stringify({
								url: `http://127.0.0.1:${port}/storage-object`,
								expiresAt: Date.now() + 60_000,
							}),
						);
					});
					return;
				}
				if (url === "/storage-object") {
					response.setHeader("content-type", "application/octet-stream");
					response.end(content);
					return;
				}
				response.end(JSON.stringify({}));
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const { paths, processEnv } = await fixture(port);
			const localPath = join(
				await mkdtemp(join(tmpdir(), "vcpdeck-files-dl-")),
				"out.bin",
			);
			const lines: string[] = [];
			await runFilesCommand(
				"download",
				["workstation", "logs/app.log", localPath, "--root=D:\\"],
				{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
			);
			expect(downloadTokenRequested).toEqual({ key: "exports/f1" });
			const saved = await readFile(localPath, "utf8");
			expect(saved).toBe(content);
			expect(lines.join("\\n")).toContain("sha256 校验通过");
		});

		it("download sha256 不一致时删除本地半成品并报错", async () => {
			const server = createServer((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "c1", name: "workstation", online: true }]),
					);
					return;
				}
				if (url === "/api/jobs" && request.method === "POST") {
					response.end(
						JSON.stringify({
							jobId: "exp-1",
							status: "running",
							type: "file.export",
						}),
					);
					return;
				}
				if (url === "/api/jobs/exp-1") {
					response.end(
						JSON.stringify({
							jobId: "exp-1",
							status: "done",
							result: {
								fileId: "f1",
								key: "exports/f1",
								size: 5,
								sha256: createHash("sha256").update("right").digest("hex"),
							},
						}),
					);
					return;
				}
				if (url === "/api/storage/download-token") {
					response.end(
						JSON.stringify({
							url: `http://127.0.0.1:${port}/storage-object`,
							expiresAt: Date.now() + 60_000,
						}),
					);
					return;
				}
				if (url === "/storage-object") {
					response.setHeader("content-type", "application/octet-stream");
					response.end("wrong");
					return;
				}
				response.end(JSON.stringify({}));
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const { paths, processEnv } = await fixture(port);
			const localPath = join(
				await mkdtemp(join(tmpdir(), "vcpdeck-files-dl-")),
				"out.bin",
			);
			await expect(
				runFilesCommand(
					"download",
					["workstation", "a.log", localPath, "--root=D:\\"],
					{ paths, processEnv, pollIntervalMs: 1, log: () => {} },
				),
			).rejects.toThrow("SHA-256 不一致");
			await expect(stat(localPath)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("upload 直传分片到预签名 URL 并等待导入终态", async () => {
			const content = "abcdef";
			const sha256 = createHash("sha256").update(content).digest("hex");
			const receivedParts = new Map<number, Buffer>();
			const server = createServer((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "c1", name: "workstation", online: true }]),
					);
					return;
				}
				if (url === "/api/files/upload-sessions" && request.method === "POST") {
					const chunks: Buffer[] = [];
					request.on("data", (c: Buffer) => chunks.push(c));
					request.on("end", () => {
						const body = JSON.parse(Buffer.concat(chunks).toString());
						expect(body).toMatchObject({
							clientId: "c1",
							targetPath: "x.txt",
							size: content.length,
						});
						response.end(
							JSON.stringify({
								jobId: "up-1",
								fileId: "f1",
								status: "waiting_input",
								upload: {
									kind: "direct",
									fileId: "f1",
									uploadId: "u1",
									partSize: 4,
									parts: [
										{
											partNumber: 1,
											url: `http://127.0.0.1:${port}/oss-part-1`,
										},
										{
											partNumber: 2,
											url: `http://127.0.0.1:${port}/oss-part-2`,
										},
									],
								},
							}),
						);
					});
					return;
				}
				if (url.startsWith("/oss-part-")) {
					const partNumber = Number(url.slice("/oss-part-".length));
					const chunks: Buffer[] = [];
					request.on("data", (c: Buffer) => chunks.push(c));
					request.on("end", () => {
						receivedParts.set(partNumber, Buffer.concat(chunks));
						response.statusCode = 200;
						response.end();
					});
					return;
				}
				if (
					url === "/api/files/upload-sessions/up-1/complete" &&
					request.method === "POST"
				) {
					response.end(
						JSON.stringify({
							jobId: "imp-1",
							status: "running",
							type: "file.import",
						}),
					);
					return;
				}
				if (url === "/api/jobs/imp-1") {
					response.end(
						JSON.stringify({
							jobId: "imp-1",
							status: "done",
							result: { path: "D:/x.txt", size: content.length, sha256 },
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
			const dir = await mkdtemp(join(tmpdir(), "vcpdeck-files-up-"));
			const localPath = join(dir, "in.txt");
			await writeFile(localPath, content, "utf8");
			const lines: string[] = [];
			await runFilesCommand(
				"upload",
				["workstation", localPath, "x.txt", "--root=D:\\"],
				{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
			);
			expect(receivedParts.get(1)?.toString()).toBe("abcd");
			expect(receivedParts.get(2)?.toString()).toBe("ef");
			expect(lines.join("\\n")).toContain("已上传");
		});

		it("download 等待导出时打印进度，--timeout=0 表示不限时", async () => {
			const content = "0123456789";
			const sha256 = createHash("sha256").update(content).digest("hex");
			let polls = 0;
			const server = createServer((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([
							{ clientId: "c1", name: "workstation", online: true },
						]),
					);
					return;
				}
				if (url === "/api/jobs" && request.method === "POST") {
					request.resume();
					response.end(
						JSON.stringify({
							jobId: "exp-2",
							status: "running",
							type: "file.export",
						}),
					);
					return;
				}
				if (url === "/api/jobs/exp-2") {
					polls += 1;
					if (polls < 3) {
						response.end(
							JSON.stringify({
								jobId: "exp-2",
								status: "running",
								progress: { loaded: 5, total: 10 },
							}),
						);
						return;
					}
					response.end(
						JSON.stringify({
							jobId: "exp-2",
							status: "done",
							result: {
								fileId: "f2",
								key: "exports/f2",
								size: content.length,
								sha256,
							},
						}),
					);
					return;
				}
				if (url === "/api/storage/download-token" && request.method === "POST") {
					request.resume();
					const port = (server.address() as { port: number }).port;
					response.end(
						JSON.stringify({
							url: `http://127.0.0.1:${port}/storage-object`,
							expiresAt: Date.now() + 60_000,
						}),
					);
					return;
				}
				if (url === "/storage-object") {
					response.setHeader("content-type", "application/octet-stream");
					response.end(content);
					return;
				}
				response.end(JSON.stringify({}));
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const { paths, processEnv } = await fixture(port);
			const localPath = join(
				await mkdtemp(join(tmpdir(), "vcpdeck-files-dl2-")),
				"out.bin",
			);
			const lines: string[] = [];
			await runFilesCommand(
				"download",
				[
					"workstation",
					"logs/app.log",
					localPath,
					"--root=D:\\",
					"--timeout=0",
				],
				{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
			);
			expect(polls).toBe(3);
			expect(lines.join("\\n")).toContain("导出进度 50%（5/10 bytes）");
			expect(await readFile(localPath, "utf8")).toBe(content);
		});

		it("upload --timeout 非整数时在传输前报错", async () => {
			const requests: string[] = [];
			const server = createServer((request, response) => {
				requests.push(request.url ?? "");
				response.end(JSON.stringify({}));
			});
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			const { paths, processEnv } = await fixture(port);
			const localPath = join(
				await mkdtemp(join(tmpdir(), "vcpdeck-files-tmo-")),
				"in.txt",
			);
			await writeFile(localPath, "abc", "utf8");
			await expect(
				runFilesCommand("upload", ["workstation", localPath, "x.txt", "--timeout=abc"], {
					paths,
					processEnv,
					pollIntervalMs: 1,
					log: () => {},
				}),
			).rejects.toThrow("--timeout 必须是不小于 0 的整数秒");
			expect(requests).toEqual([]);
		});
	});
});

describe("files share", () => {
	const sha256 = "b".repeat(64);

	/** 模拟 Server：file.export 立即 done，POST /api/storage/shares 返回固定分享。 */
	async function listenWithShare(size = 16): Promise<{
		port: number;
		jobs: Record<string, unknown>[];
		shares: Record<string, unknown>[];
	}> {
		const jobs: Record<string, unknown>[] = [];
		const shares: Record<string, unknown>[] = [];
		const server = createServer((request, response) => {
			const url = request.url ?? "";
			response.setHeader("content-type", "application/json");
			if (url === "/api/clients") {
				response.end(
					JSON.stringify([
						{ clientId: "client-1", name: "workstation", online: true },
					]),
				);
				return;
			}
			if (url === "/api/jobs" && request.method === "POST") {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					jobs.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					response.end(
						JSON.stringify({
							jobId: "exp-1",
							status: "running",
							type: "file.export",
						}),
					);
				});
				return;
			}
			if (url === "/api/jobs/exp-1") {
				response.end(
					JSON.stringify({
						jobId: "exp-1",
						status: "done",
						result: { fileId: "f1", key: "exports/f1", size, sha256 },
					}),
				);
				return;
			}
			if (url === "/api/storage/shares" && request.method === "POST") {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					shares.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					response.end(
						JSON.stringify({
							id: "share-1",
							fileId: "f1",
							filename: "big.log",
							mimeType: null,
							storageKind: "local",
							status: "active",
							previewable: false,
							createdAt: new Date().toISOString(),
							revokedAt: null,
							sharePath: "/api/public/storage-shares/tok-1",
						}),
					);
				});
				return;
			}
			response.end(JSON.stringify({}));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		return { port, jobs, shares };
	}

	it("导出远程文件并打印公开下载链接", async () => {
		const { port, jobs, shares } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand(
			"share",
			["workstation", "logs/big.log", "--root=D:/"],
			{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
		);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.type).toBe("file.export");
		expect(jobs[0]?.payload).toMatchObject({
			rootDir: "D:/",
			path: "logs/big.log",
		});
		expect(shares).toEqual([{ fileId: "f1" }]);
		const output = lines.join("\n");
		expect(output).toContain(
			`http://127.0.0.1:${port}/api/public/storage-shares/tok-1`,
		);
		expect(output).toContain("分享 ID: share-1");
		// 默认基地址是本机时明确提示链接不可外部访问
		expect(output).toContain("其它机器无法访问");
	});

	it("--base-url 覆盖链接基地址且不再提示本机地址", async () => {
		const { port } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand(
			"share",
			[
				"workstation",
				"logs/big.log",
				"--root=D:/",
				"--base-url=https://deck.example",
			],
			{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
		);
		const output = lines.join("\n");
		expect(output).toContain(
			"https://deck.example/api/public/storage-shares/tok-1",
		);
		expect(output).not.toContain("其它机器无法访问");
	});

	it("--file-id 直接补建链接，不创建导出 Job", async () => {
		const { port, jobs, shares } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand("share", ["--file-id=f9"], {
			paths,
			processEnv,
			pollIntervalMs: 1,
			log: (m) => lines.push(m),
		});
		expect(jobs).toHaveLength(0);
		expect(shares).toEqual([{ fileId: "f9" }]);
		expect(lines.join("\n")).toContain("分享 ID: share-1");
	});

	it("--json 输出 fileId/shareId/url 且不含进度行", async () => {
		const { port } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runFilesCommand(
			"share",
			["workstation", "logs/big.log", "--root=D:/", "--json"],
			{ paths, processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
		);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] as string)).toMatchObject({
			fileId: "f1",
			size: 16,
			sha256,
			jobId: "exp-1",
			shareId: "share-1",
			url: `http://127.0.0.1:${port}/api/public/storage-shares/tok-1`,
		});
	});

	it("--timeout 非整数与 --file-id 混用位置参数明确失败", async () => {
		const { port } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		await expect(
			runFilesCommand("share", ["workstation", "a.log", "--root=D:/", "--timeout=abc"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			}),
		).rejects.toThrow("--timeout 必须是不小于 0 的整数秒");
		await expect(
			runFilesCommand("share", ["workstation", "a.log", "--file-id=f1"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			}),
		).rejects.toThrow("不能同时使用");
		await expect(runFilesCommand("share", [])).rejects.toThrow("Files 命令");
	});

	it("基地址不是绝对 http(s) 地址时明确失败且不创建分享", async () => {
		const { port, shares } = await listenWithShare();
		const { paths, processEnv } = await fixture(port);
		await expect(
			runFilesCommand("share", ["--file-id=f9", "--base-url=deck.example"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: () => {},
			}),
		).rejects.toThrow("分享链接基地址必须是绝对 http(s) 地址");
		expect(shares).toHaveLength(0);
	});
});
