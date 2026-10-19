import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnAcpProcess } from "./acp-process.js";

const fixture = resolve("src/acp/fixtures/fake-agent.mjs");
const cmdFixture = resolve("src/acp/fixtures/fake-agent.cmd");

describe("spawnAcpProcess", () => {
	it("按 NDJSON 关联 initialize 请求与响应", async () => {
		const acp = spawnAcpProcess({
			command: process.execPath,
			args: [fixture],
			cwd: process.cwd(),
			onNotification: () => undefined,
			onRequest: async () => ({}),
			onExit: () => undefined,
		});
		try {
			const result = (await acp.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			})) as { protocolVersion: number };
			expect(result.protocolVersion).toBe(1);
		} finally {
			await acp.kill();
		}
	});

	// Windows 上 CLI agent 普遍以 .cmd 垫片分发，spawn 不能直接执行它们
	it.skipIf(process.platform !== "win32")(
		"经 cmd.exe 包装能拉起 .cmd 垫片",
		async () => {
			const acp = spawnAcpProcess({
				command: cmdFixture,
				args: [],
				cwd: process.cwd(),
				onNotification: () => undefined,
				onRequest: async () => ({}),
				onExit: () => undefined,
			});
			try {
				const result = (await acp.request("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
				})) as { protocolVersion: number };
				expect(result.protocolVersion).toBe(1);
			} finally {
				await acp.kill();
			}
		},
	);
});
