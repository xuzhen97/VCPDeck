import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPiCommand } from "./pi-command.js";
import { saveCliConfig, type ConfigPaths } from "./config.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(port: number): Promise<{
	paths: ConfigPaths;
	processEnv: NodeJS.ProcessEnv;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-pi-command-"));
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

interface PiTestOptions {
	models?: Array<{ provider: string; modelId: string }>;
	sessions?: unknown;
	roots?: string[];
	stateSequence?: string[];
	contextMessages?: Array<Record<string, unknown>>;
}

/**
 * 模拟 Server Pi 命名空间：clients 解析、file.roots 探测、models/sessions、
 * agent new/prompt/state（按 stateSequence 依次返回）/context。
 */
async function listenPi(
	options: PiTestOptions = {},
): Promise<{ port: number; bodies: unknown[] }> {
	const bodies: unknown[] = [];
	let stateIndex = 0;
	const server = createServer((request, response) => {
		const url = request.url ?? "";
		const path = url.split("?")[0];
		response.setHeader("content-type", "application/json");
		if (path === "/api/clients") {
			response.end(
				JSON.stringify([
					{ clientId: "c1", name: "workstation", online: true },
				]),
			);
			return;
		}
		if (path === "/api/jobs" && request.method === "POST") {
			bodies.push({ kind: "job-create", url });
			response.end(
				JSON.stringify({ jobId: "root-job", status: "running", type: "file.roots" }),
			);
			return;
		}
		if (/^\/api\/jobs\/root-job$/.test(url)) {
			response.end(
				JSON.stringify({
					jobId: "root-job",
					status: "done",
					result: { roots: options.roots ?? ["D:\\"] },
				}),
			);
			return;
		}
		if (url.startsWith("/api/clients/c1/pi/models")) {
			response.end(JSON.stringify(options.models ?? []));
			return;
		}
		if (path === "/api/clients/c1/pi/sessions") {
			response.end(JSON.stringify(options.sessions ?? []));
			return;
		}
		if (path.endsWith("/pi/agent/new") && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (c: Buffer) => chunks.push(c));
			request.on("end", () => {
				bodies.push({
					kind: "new",
					body: JSON.parse(Buffer.concat(chunks).toString()),
				});
				response.end(
					JSON.stringify({ sessionId: "s-new", jobId: "job-new" }),
				);
			});
			return;
		}
		if (/\/pi\/agent\/(s-[a-z0-9-]+)\/open$/.test(path)) {
			response.end(JSON.stringify({ job: {} }));
			return;
		}
		if (/\/pi\/agent\/(s-[a-z0-9-]+)$/.test(path) && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (c: Buffer) => chunks.push(c));
			request.on("end", () => {
				bodies.push({
					kind: "prompt",
					body: JSON.parse(Buffer.concat(chunks).toString()),
				});
				response.end(
					JSON.stringify({ submissionId: "sub-1", accepted: true }),
				);
			});
			return;
		}
		if (/\/pi\/agent\/(s-[a-z0-9-]+)$/.test(path) && request.method === "GET") {
			const sequence =
				options.stateSequence && options.stateSequence.length > 0
					? options.stateSequence
					: ["idle"];
			const status =
				stateIndex < sequence.length ? sequence[stateIndex] : "idle";
			stateIndex += 1;
			response.end(
				JSON.stringify({
					status,
					streaming: false,
					prompting: false,
					compacting: false,
					thinkingLevel: "off",
					queuedMessages: { steering: [], followUp: [] },
				}),
			);
			return;
		}
		if (path.includes("/sessions/s-") && path.includes("/context")) {
			response.end(
				JSON.stringify({ messages: options.contextMessages ?? [] }),
			);
			return;
		}
		if (path.includes("/pi/agent/") && request.method === "POST") {
			// abort 等
			const chunks: Buffer[] = [];
			request.on("data", (c: Buffer) => chunks.push(c));
			request.on("end", () => response.end(JSON.stringify({ ok: true })));
			return;
		}
		response.end(JSON.stringify({}));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("测试 Server 未监听");
	return { port: address.port, bodies };
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

describe("pi command", () => {
	it("未知子命令与缺提示词返回用法错误", async () => {
		await expect(runPiCommand("fork", [])).rejects.toThrow("Pi 命令");
		await expect(runPiCommand(undefined, ["--help"])).resolves.toBeUndefined();
	});

	it("models 输出 provider/modelId；多根且缺省 --root 时 fail closed", async () => {
		const ok = await listenPi({
			models: [
				{ provider: "anthropic", modelId: "claude-x" },
				{ provider: "openai", modelId: "gpt-y" },
			],
		});
		const first = await fixture(ok.port);
		const lines: string[] = [];
		await runPiCommand("models", ["workstation", "--root=D:\\"], {
			paths: first.paths,
			processEnv: first.processEnv,
			log: (m) => lines.push(m),
		});
		expect(lines.join("\n")).toContain("anthropic/claude-x");

		const ambiguous = await listenPi({ roots: ["C:\\", "D:\\"] });
		const second = await fixture(ambiguous.port);
		await expect(
			runPiCommand("models", ["workstation"], {
				paths: second.paths,
				processEnv: second.processEnv,
				log: () => {},
			}),
		).rejects.toThrow("--root=<dir> 指定授权根");
	});

	it("run 自动创建会话、提交提示词、轮询至 idle 并提取助手回复", async () => {
		const { port, bodies } = await listenPi({
			stateSequence: ["running", "idle"],
			contextMessages: [
				{ role: "user", content: [{ type: "text", text: "列出文件" }] },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "目录下共有 3 个文件。" },
						{ type: "tool_call", toolName: "read" },
					],
				},
			],
		});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runPiCommand(
			"run",
			["workstation", "列出", "当前", "文件", "--cwd=proj", "--json"],
			{
				paths,
				processEnv,
				pollIntervalMs: 1,
				log: (m) => lines.push(m),
			},
		);
		const newCall = bodies.find((b) => (b as { kind?: string }).kind === "new");
		expect((newCall as { body: { rootDir: string } }).body.rootDir).toBe("D:\\");
		const promptCall = bodies.find(
			(b) => (b as { kind?: string }).kind === "prompt",
		) as { body: { prompt: string; submissionId: string } };
		expect(promptCall.body.prompt).toBe("列出 当前 文件");
		expect(promptCall.body.submissionId).toBeTruthy();
		const parsed = JSON.parse(lines.join("\n")) as {
			sessionId: string;
			reply: string;
		};
		expect(parsed.sessionId).toBe("s-new");
		expect(parsed.reply).toBe("目录下共有 3 个文件。");
	});

	it("既有会话走 open；扩展输入等待时明确报错", async () => {
		const waiting = await listenPi({ stateSequence: ["waiting_for_extension_input"] });
		const first = await fixture(waiting.port);
		await expect(
			runPiCommand(
				"run",
				["workstation", "继续", "--session=s-existing", "--root=D:\\"],
				{ paths: first.paths, processEnv: first.processEnv, pollIntervalMs: 1, log: () => {} },
			),
		).rejects.toThrow("等待扩展输入");

		const idle = await listenPi({ contextMessages: [
			{ role: "assistant", content: [{ type: "text", text: "完成" }] },
		] });
		const second = await fixture(idle.port);
		const lines: string[] = [];
		await runPiCommand(
			"run",
			["workstation", "收尾", "--session=s-exist", "--root=D:\\"],
			{ paths: second.paths, processEnv: second.processEnv, pollIntervalMs: 1, log: (m) => lines.push(m) },
		);
		expect(lines.join("\n")).toContain("已打开既有会话 s-exist");
		expect(lines.join("\n")).toContain("── Pi 回复 ──");
	});

	it("abort 提交中止请求", async () => {
		const { port } = await listenPi({});
		const { paths, processEnv } = await fixture(port);
		const lines: string[] = [];
		await runPiCommand("abort", ["workstation", "--session=s-9"], {
			paths,
			processEnv,
			log: (m) => lines.push(m),
		});
		expect(lines.join("\n")).toContain("中止请求已提交");
	});

	describe("pi attach REPL", () => {
		function makeStreams() {
			const input = new PassThrough();
			const output = new PassThrough();
			const chunks: Buffer[] = [];
			output.on("data", (c: Buffer) => chunks.push(c));
			return {
				input,
				output,
				text: () => Buffer.concat(chunks).toString("utf8"),
			};
		}

		it("多轮对话：每轮提交提示词、取回回复；/exit 退出", async () => {
			const { port, bodies } = await listenPi({
				stateSequence: ["running", "idle", "running", "idle"],
				contextMessages: [
					{ role: "assistant", content: [{ type: "text", text: "第一轮回复" }] },
				],
			});
			const { paths, processEnv } = await fixture(port);
			const streams = makeStreams();
			streams.input.write("第一问\n第二问\n/exit\n");
			streams.input.end();
			await runPiCommand("attach", ["workstation", "--root=D:\\"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				input: streams.input,
				output: streams.output,
			});
			const prompts = bodies.filter(
				(b) => (b as { kind?: string }).kind === "prompt",
			) as Array<{ body: { prompt: string } }>;
			expect(prompts.map((p) => p.body.prompt)).toEqual(["第一问", "第二问"]);
			expect(streams.text()).toContain("第一轮回复");
			expect(streams.text()).toContain("── Pi 交互会话 ──");
		});

		it("/abort 提交中止；EOF 退出；单轮失败不退出 REPL", async () => {
			const { port } = await listenPi({
				stateSequence: ["waiting_for_extension_input", "running", "idle"],
				contextMessages: [
					{ role: "assistant", content: [{ type: "text", text: "恢复后回复" }] },
				],
			});
			const { paths, processEnv } = await fixture(port);
			const streams = makeStreams();
			streams.input.write("触发扩展\n重试\n/abort\n");
			streams.input.end();
			await runPiCommand("attach", ["workstation", "--root=D:\\"], {
				paths,
				processEnv,
				pollIntervalMs: 1,
				input: streams.input,
				output: streams.output,
			});
			const text = streams.text();
			expect(text).toContain("等待扩展输入");
			expect(text).toContain("恢复后回复");
			expect(text).toContain("已提交中止请求");
		});
	});
});
