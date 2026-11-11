import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VcpDeckClient } from "@vcpdeck/sdk";
import { saveCliConfig, type ConfigPaths } from "./config.js";
import { runTailnetCommand } from "./tailnet-command.js";

const tempDirectories: string[] = [];
const servers: Server[] = [];

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
	paths: ConfigPaths;
}> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("测试 Server 未监听");
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-tailnet-cli-"));
	tempDirectories.push(root);
	const paths = { globalConfigPath: join(root, "config.json"), cwd: root };
	await saveCliConfig(paths.globalConfigPath, {
		version: 1,
		defaultEnvironment: "test",
		environments: {
			test: {
				server: `http://127.0.0.1:${address.port}`,
				auth: { type: "bearer", token: "vcp_test_token" },
			},
		},
	});
	return { paths };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const KEY_INFO = {
	id: "key-1",
	name: "home",
	declaredReuse: "single",
	declaredExpiresAt: null,
	use: "available",
	createdAt: "2026-11-11T10:00:00.000Z",
};

function clientInfo() {
	return {
		clientId: "client-1",
		name: "workstation",
		hostname: "WORKSTATION",
		os: "win32",
		cpuModel: "CPU",
		totalMemMB: 1024,
		clientVersion: "0.2.5",
		capabilities: ["exec", "tailnet.manage"],
		capabilityDetails: { tailnet: { protocolVersion: 1 } },
		online: false,
		cpuPercent: 0,
		memPercent: 0,
		disks: [],
		lastHeartbeatAt: "2026-11-11T10:00:00.000Z",
	};
}

function jobInfo(stage: string): Record<string, unknown> {
	return {
		jobId: "job-1",
		clientId: "client-1",
		clientName: "workstation",
		type: "tailnet.manage",
		status: "done",
		payload: { action: "ensure", credentialId: "key-1", installIfMissing: false },
		result: {
			stage,
			snapshot: {
				installed: "yes",
				version: "1.104.5",
				service: "running",
				backend: stage === "joined" ? "running" : "needs-approval",
				nodeName: null,
				ipv4: [],
				ipv6: [],
				observedAt: "2026-11-11T10:05:00.000Z",
				errorCode: null,
			},
		},
		progress: null,
		errorCode: null,
		errorMessage: null,
		createdAt: "2026-11-11T10:00:00.000Z",
		startedAt: "2026-11-11T10:00:01.000Z",
		finishedAt: "2026-11-11T10:00:05.000Z",
		createdByIdentityId: null,
		createdByName: null,
		createdVia: null,
	};
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	for (const directory of tempDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
	}
});

describe("tailnet CLI", () => {
	it("拒绝明文 --auth-key 且不回显密钥", async () => {
		const output: string[] = [];
		let failure: unknown;
		try {
			await runTailnetCommand(
				"keys",
				["import", "--auth-key=fake-secret"],
				{ log: (line) => output.push(line) },
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeTruthy();
		expect(String(failure)).not.toContain("fake-secret");
		expect(output.join("\n")).not.toContain("fake-secret");
	});

	it("拒绝终端 stdin", async () => {
		await expect(
			runTailnetCommand(
				"keys",
				["import", "--name=home", "--key-stdin"],
				{ stdin: Readable.from([]), stdinIsTTY: true, log: () => {} },
			),
		).rejects.toThrow(/拒绝终端/);
	});

	it("拒绝空 stdin 与超过 4096 字节的输入", async () => {
		await expect(
			runTailnetCommand(
				"keys",
				["import", "--name=home", "--key-stdin"],
				{ stdin: Readable.from(["\n"]), log: () => {} },
			),
		).rejects.toThrow(/未提供密钥/);
		await expect(
			runTailnetCommand(
				"keys",
				["import", "--name=home", "--key-stdin"],
				{ stdin: Readable.from(["x".repeat(4097)]), log: () => {} },
			),
		).rejects.toThrow(/4096/);
	});

	it("stdin 导入成功且输出不含密钥", async () => {
		let received: unknown;
		const { paths } = await fixture(async (request, response) => {
			received = await readBody(request);
			json(response, KEY_INFO);
		});
		const output: string[] = [];
		await runTailnetCommand(
			"keys",
			["import", "--name=home", "--key-stdin", "--reuse=single"],
			{
				paths,
				stdin: Readable.from(["tskey-auth-secret\n"]),
				stdinIsTTY: false,
				log: (line) => output.push(line),
			},
		);
		expect(received).toEqual({
			name: "home",
			authKey: "tskey-auth-secret",
			declaredReuse: "single",
			declaredExpiresAt: null,
		});
		expect(output.join("\n")).toContain("key-1");
		expect(output.join("\n")).not.toContain("tskey-auth-secret");
	});

	it("status 把缺失历史摘要显示为未知而不是未入网，离线带历史标记", async () => {
		const { paths } = await fixture((request, response) => {
			if (request.url === "/api/clients") {
				json(response, [clientInfo()]);
				return;
			}
			if (request.url === "/api/tailnet/clients/client-1") {
				json(response, {
					clientId: "client-1",
					online: false,
					supported: true,
					snapshot: null,
				});
				return;
			}
			json(response, { message: "not found" }, 404);
		});
		const output: string[] = [];
		await runTailnetCommand("status", ["workstation"], {
			paths,
			log: (line) => output.push(line),
		});
		const text = output.join("\n");
		expect(text).toContain("未知 / 未报告");
		expect(text).not.toContain("未入网");
	});

	it("status --json 在 stdout 只输出一个 JSON 对象", async () => {
		const { paths } = await fixture((request, response) => {
			if (request.url === "/api/clients") {
				json(response, [clientInfo()]);
				return;
			}
			json(response, {
				clientId: "client-1",
				online: false,
				supported: true,
				snapshot: {
					installed: "yes",
					version: "1.104.5",
					service: "stopped",
					backend: "stopped",
					nodeName: "node.tailnet.ts.net",
					ipv4: ["100.64.0.1"],
					ipv6: [],
					observedAt: "2026-11-11T10:00:00.000Z",
					errorCode: null,
				},
			});
		});
		const output: string[] = [];
		await runTailnetCommand("status", ["workstation", "--json"], {
			paths,
			log: (line) => output.push(line),
		});
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toMatchObject({
			clientId: "client-1",
			online: false,
			supported: true,
		});
	});

	it("ensure 无 batch：第二个位置参数直接拒绝", async () => {
		const client = {
			clients: { list: vi.fn() },
			tailnet: { manage: vi.fn() },
		} as unknown as VcpDeckClient;
		await expect(
			runTailnetCommand("ensure", ["a", "b", "--key-id=key-1"], {
				client,
				log: () => {},
			}),
		).rejects.toThrow(/单台机器/);
		expect(client.tailnet.manage).not.toHaveBeenCalled();
	});

	it("ensure --wait 把 awaiting-approval 与 joined 区分显示", async () => {
		const client = {
			clients: { list: vi.fn().mockResolvedValue([clientInfo()]) },
			tailnet: {
				manage: vi.fn().mockResolvedValue({
					jobId: "job-1",
					status: "pending",
					type: "tailnet.manage",
				}),
			},
			jobs: { get: vi.fn().mockResolvedValue(jobInfo("awaiting-approval")) },
		} as unknown as VcpDeckClient;
		const output: string[] = [];
		await runTailnetCommand(
			"ensure",
			["workstation", "--key-id=key-1", "--wait"],
			{ client, pollIntervalMs: 1, log: (line) => output.push(line) },
		);
		const text = output.join("\n");
		expect(text).toContain("awaiting-approval");
		expect(text).toContain("等待 Tailscale 管理端批准");
		expect(text).not.toContain("已加入 Tailnet");
	});
});
