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
import { JobStatus, type JobInfo } from "@vcpdeck/shared";
import { runJobsCommand } from "./jobs-command.js";
import { saveCliConfig, type ConfigPaths } from "./config.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-jobs-command-"));
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

function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
	return {
		jobId: "job-1",
		clientId: "client-1",
		clientName: "workstation",
		type: "exec",
		status: JobStatus.ERROR,
		payload: { command: "make check" },
		result: { exitCode: 2 },
		progress: null,
		timeout: 40_000,
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-08-22T01:00:00.000Z",
		startedAt: "2026-08-22T01:00:01.000Z",
		finishedAt: "2026-08-22T01:00:05.000Z",
		createdByIdentityId: "identity-1",
		createdByName: "admin",
		createdVia: "cli",
		...overrides,
	};
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
				(server) => new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("jobs command", () => {
	it("未知子命令返回用法，--help 零开销输出用法", async () => {
		await expect(runJobsCommand("cancel", [])).rejects.toThrow("Jobs 命令");
		const lines: string[] = [];
		await runJobsCommand(undefined, ["--help"], {
			log: (message) => lines.push(message),
		});
		await runJobsCommand("get", ["-h"], {
			log: (message) => lines.push(message),
		});
		expect(
			lines.filter((line) => line.includes("vcpdeck jobs list")),
		).toHaveLength(2);
	});

	it("拒绝非法 status、page 和未知选项", async () => {
		const { port } = await listen(() => {});
		const { paths, processEnv } = await fixture(port);
		await expect(
			runJobsCommand("list", ["--status=nope"], { paths, processEnv }),
		).rejects.toThrow("--status");
		await expect(
			runJobsCommand("list", ["--page=0"], { paths, processEnv }),
		).rejects.toThrow("--page");
		await expect(
			runJobsCommand("list", ["--watch"], { paths, processEnv }),
		).rejects.toThrow("未知选项");
	});

	it("list 输出分页表格；--client 按名称解析为 clientId", async () => {
		const requests: string[] = [];
		const { port } = await listen((request, response) => {
			requests.push(request.url ?? "");
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").startsWith("/api/clients")) {
				response.end(
					JSON.stringify([
						{ clientId: "client-1", name: "workstation", online: true },
					]),
				);
				return;
			}
			response.end(
				JSON.stringify({
					data: [
						jobInfo(),
						jobInfo({
							jobId: "job-2",
							status: JobStatus.RUNNING,
							createdAt: "2026-08-22T02:00:00.000Z",
						}),
					],
					total: 2,
					page: 1,
					pageSize: 20,
					totalPages: 1,
				}),
			);
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runJobsCommand("list", ["--client=workstation"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		expect(requests).toContain("/api/clients");
		expect(
			requests.some((url) => url.startsWith("/api/jobs?clientId=client-1")),
		).toBe(true);
		const table = lines.join("\n");
		expect(table).toContain("共 2 条 · 第 1/1 页");
		expect(table).toContain("JOBID");
		expect(table.indexOf("job-2")).toBeLessThan(table.indexOf("job-1"));
		expect(table).not.toContain("vcp_test_token");
	});

	it("--client 未匹配到机器时明确报错", async () => {
		const { port } = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify([]));
		});
		const { paths, processEnv } = await fixture(port);
		await expect(
			runJobsCommand("list", ["--client=ghost"], { paths, processEnv }),
		).rejects.toThrow('未找到 Client "ghost"');
	});

	it("list 把 frp.reconcile 显示为「恢复 FRP 映射」，不泄露 raw payload 敏感字段", async () => {
		const { port } = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					data: [
						jobInfo({
							jobId: "reconcile-1",
							type: "frp.reconcile",
							status: JobStatus.DONE,
							createdVia: "system:frp-reconcile",
							createdByIdentityId: null,
							createdByName: null,
							payload: {
								attempt: 1,
								mappingCount: 2,
								connectionGeneration: "conn-1",
								expectedRuntimeGeneration: 4,
							},
							result: {
								status: "running",
								runtimeGeneration: 4,
								loadedMappingIds: ["fm_1", "fm_2"],
							},
						}),
					],
					total: 1,
					page: 1,
					pageSize: 20,
					totalPages: 1,
				}),
			);
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runJobsCommand("list", [], { paths, processEnv, log: (m) => lines.push(m) });
		const output = lines.join("\n");
		expect(output).toContain("恢复 FRP 映射");
		expect(output).toContain("reconcile-1");
		// 输出不出现 authToken 等敏感正文
		expect(output).not.toContain("SUPER_SECRET");
	});

	it("get 展示失败现场：错误摘要与 stdout/stderr spool 全文", async () => {
		const requests: string[] = [];
		const failed = jobInfo({
			errorCode: "EXEC_FAILED",
			errorMessage: "命令退出码非零",
		});
		const { port } = await listen((request, response) => {
			requests.push(request.url ?? "");
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").endsWith("/output")) {
				response.end(
					JSON.stringify({
						jobId: "job-1",
						output: "npm ERR! missing script\nexit 2\n",
					}),
				);
				return;
			}
			response.end(JSON.stringify(failed));
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runJobsCommand("get", ["job-1"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		expect(requests).toContain("/api/jobs/job-1/output");
		const detail = lines.join("\n");
		expect(detail).toContain("Status: error");
		expect(detail).toContain("Error: EXEC_FAILED — 命令退出码非零");
		expect(detail).toContain("Timeout: 40000 ms");
		expect(detail).toContain("── 输出（stdout/stderr）──");
		expect(detail).toContain("npm ERR! missing script");
	});

	it("get --json 输出含 output 字段的纯 JSON", async () => {
		const { port } = await listen((request, response) => {
			response.setHeader("content-type", "application/json");
			if ((request.url ?? "").endsWith("/output")) {
				response.end(JSON.stringify({ jobId: "job-1", output: null }));
				return;
			}
			response.end(JSON.stringify(jobInfo()));
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runJobsCommand("get", ["job-1", "--json"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		const parsed = JSON.parse(lines.join("\n")) as JobInfo & {
			output: string | null;
		};
		expect(parsed.jobId).toBe("job-1");
		expect(parsed.output).toBeNull();
	});

	it("list --json 输出原始 PaginatedResult", async () => {
		const page = {
			data: [jobInfo()],
			total: 1,
			page: 1,
			pageSize: 20,
			totalPages: 1,
		};
		const { port } = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(page));
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runJobsCommand("list", ["--json"], {
			paths,
			processEnv,
			log: (message) => lines.push(message),
		});
		expect(JSON.parse(lines.join("\n"))).toEqual(page);
	});

	describe("jobs run", () => {
		it("缺少机器或命令 token 时返回用法错误", async () => {
			await expect(runJobsCommand("run", ["workstation"])).rejects.toThrow(
				"Jobs 命令",
			);
		});

		it("拒绝非法 timeout", async () => {
			const { port } = await listen(() => {});
			const { paths, processEnv } = await fixture(port);
			await expect(
				runJobsCommand("run", ["--timeout=abc", "--", "echo", "hi"], {
					paths,
					processEnv,
				}),
			).rejects.toThrow("--timeout");
		});

		it("创建 exec Job 并把命令 token 以空格连接为 command 模式", async () => {
			const bodies: unknown[] = [];
			const { port } = await listen((request, response) => {
				if ((request.url ?? "") === "/api/clients") {
					response.setHeader("content-type", "application/json");
					response.end(
						JSON.stringify([{ clientId: "client-1", name: "ws", online: true }]),
					);
					return;
				}
				if ((request.url ?? "") === "/api/jobs" && request.method === "POST") {
					const chunks: Buffer[] = [];
					request.on("data", (chunk: Buffer) => chunks.push(chunk));
					request.on("end", () => {
						bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
						response.setHeader("content-type", "application/json");
						response.end(
							JSON.stringify({
								jobId: "job-run-1",
								status: "running",
								type: "exec",
							}),
						);
					});
					return;
				}
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({}));
			});
			const { paths, processEnv } = await fixture(port);
			const lines: string[] = [];
			await runJobsCommand(
				"run",
				["ws", "--cwd=D:\\tmp", "--timeout=60", "--", "git", "status"],
				{ paths, processEnv, log: (message) => lines.push(message) },
			);
			expect(bodies[0]).toMatchObject({
				clientId: "client-1",
				type: "exec",
				timeout: 60_000,
				payload: { mode: "command", command: "git status", cwd: "D:\\tmp" },
			});
			expect(lines.join("\n")).toContain("Job 已创建: job-run-1");
		});

		it("仅在多个 token 的空白参数边界会丢失时警告", async () => {
			const { port } = await listen((request, response) => {
				response.setHeader("content-type", "application/json");
				if ((request.url ?? "") === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "client-1", name: "ws", online: true }]),
					);
					return;
				}
				response.end(
					JSON.stringify({ jobId: "job-run-1", status: "running", type: "exec" }),
				);
			});
			const { paths, processEnv } = await fixture(port);
			const warnings: string[] = [];
			const context = {
				paths,
				processEnv,
				log: () => {},
				error: (message: string) => warnings.push(message),
			};

			await runJobsCommand("run", ["ws", "--", "sh /root/preflight.sh"], context);
			expect(warnings).toEqual([]);

			await runJobsCommand("run", ["ws", "--", "printf", "a b"], context);
			expect(warnings.join("\n")).toContain("参数边界会丢失");
		});

		it("--wait --json 的 stdout 为单一 JSON，状态提示只写 stderr", async () => {
			let created = 0;
			const reads = new Map<string, number>();
			const { port } = await listen((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "client-1", name: "ws", online: true }]),
					);
					return;
				}
				if (url === "/api/jobs" && request.method === "POST") {
					created++;
					response.end(
						JSON.stringify({ jobId: `job-json-${created}`, status: "running", type: "exec" }),
					);
					return;
				}
				if (url.endsWith("/output")) {
					response.end(JSON.stringify({ jobId: url, output: "" }));
					return;
				}
				const jobId = url.split("/").pop() ?? "";
				const count = reads.get(jobId) ?? 0;
				reads.set(jobId, count + 1);
				const failed = jobId.endsWith("-2");
				response.end(
					JSON.stringify(
						count === 0
							? jobInfo({ jobId, status: JobStatus.RUNNING, result: null })
							: jobInfo({
									jobId,
									status: failed ? JobStatus.ERROR : JobStatus.DONE,
									result: { exitCode: failed ? 2 : 0 },
								}),
					),
				);
			});
			const { paths, processEnv } = await fixture(port);

			for (const shouldFail of [false, true]) {
				const stdout: string[] = [];
				const stderr: string[] = [];
				const promise = runJobsCommand(
					"run",
					["ws", "--wait", "--json", "--", "echo", "a b"],
					{
						paths,
						processEnv,
						pollIntervalMs: 1,
						log: (message) => stdout.push(message),
						error: (message) => stderr.push(message),
					},
				);
				if (shouldFail) await expect(promise).rejects.toThrow("终态为 error");
				else await promise;

				const parsed = JSON.parse(stdout.join("\n")) as JobInfo & {
					output: string;
				};
				expect(parsed.status).toBe(shouldFail ? JobStatus.ERROR : JobStatus.DONE);
				expect(stderr.join("\n")).toContain(`Job ${parsed.jobId} 状态: running`);
				expect(stderr.join("\n")).toContain("参数边界会丢失");
			}
		});

		it("--wait 成功终态输出详情与全文；失败终态非零退出并带出失败现场", async () => {
			let phase = 0;
			const failed = jobInfo({
				jobId: "job-fail",
				status: JobStatus.ERROR,
				errorCode: null,
				errorMessage: null,
				result: { exitCode: 2 },
			});
			const { port } = await listen((request, response) => {
				const url = request.url ?? "";
				response.setHeader("content-type", "application/json");
				if (url === "/api/clients") {
					response.end(
						JSON.stringify([{ clientId: "client-1", name: "ws", online: true }]),
					);
					return;
				}
				if (url === "/api/jobs" && request.method === "POST") {
					phase++;
					response.end(
						JSON.stringify({
							jobId: `job-${phase}`,
							status: "running",
							type: "exec",
						}),
					);
					return;
				}
				if (url.endsWith("/output")) {
					response.end(
						JSON.stringify({ jobId: url, output: "fatal: not a git repo\nexit 2\n" }),
					);
					return;
				}
				// GET /api/jobs/:id：第一个 Job 直接 done，第二个返回 error
				response.end(
					JSON.stringify(
						phase === 1
							? jobInfo({
									jobId: "job-1",
									status: JobStatus.DONE,
									result: { exitCode: 0 },
								})
							: failed,
					),
				);
			});
			const { paths, processEnv } = await fixture(port);
			const okLines: string[] = [];
			await runJobsCommand("run", ["ws", "--wait", "--", "echo", "ok"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: (message) => okLines.push(message),
			});
			expect(okLines.join("\n")).toContain("Status: done");
			expect(okLines.join("\n")).toContain("fatal: not a git repo");

			const failLines: string[] = [];
			await expect(
				runJobsCommand("run", ["ws", "--wait", "--", "make", "check"], {
					paths,
					processEnv,
					pollIntervalMs: 1,
					log: (message) => failLines.push(message),
				}),
			).rejects.toThrow("终态为 error");
			expect(failLines.join("\n")).toContain("exit 2");
			expect(failLines.join("\n")).toContain("── 输出（stdout/stderr）──");
		});
	});

	describe("jobs cancel", () => {
		it("提交取消请求并展示权威状态", async () => {
			const { port } = await listen((_request, response) => {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ jobId: "job-9", status: "cancelling" }));
			});
			const { paths, processEnv } = await fixture(port);
			const lines: string[] = [];
			await runJobsCommand("cancel", ["job-9"], {
				paths,
				processEnv,
				log: (message) => lines.push(message),
			});
			expect(lines.join("\n")).toContain("cancelling");
			expect(lines.join("\n")).toContain("终态用 jobs get 核对");
		});

		it("--json 输出原始取消结果", async () => {
			const { port } = await listen((_request, response) => {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ jobId: "job-9", status: "cancelled" }));
			});
			const { paths, processEnv } = await fixture(port);
			const lines: string[] = [];
			await runJobsCommand("cancel", ["job-9", "--json"], {
				paths,
				processEnv,
				log: (message) => lines.push(message),
			});
			expect(JSON.parse(lines.join("\n"))).toEqual({
				jobId: "job-9",
				status: "cancelled",
			});
		});
	});
});
