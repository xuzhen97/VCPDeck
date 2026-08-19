import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCliConfig } from "./config.js";
import { runReleaseCommand } from "./release-command.js";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("release upload environment integration", () => {
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
		const server = createServer((request, response) => {
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
					JSON.stringify({
						release: {
							version: "1.2.3",
							archives: {},
							status: "uploaded",
							createdAt: "2026-08-18T00:00:00.000Z",
							updatedAt: "2026-08-18T00:00:00.000Z",
							clientStates: {},
						},
					}),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("测试 Server 未监听");
			const root = await mkdtemp(join(tmpdir(), "vcpdeck-release-command-"));
			tempDirectories.push(root);
			const win = join(root, "vcpdeck-1.2.3-win-x64.zip");
			const linux = join(root, "vcpdeck-1.2.3-linux-x64.zip");
			await writeFile(win, "win-archive");
			await writeFile(linux, "linux-archive");
			const globalConfigPath = join(root, "config.json");
			await saveCliConfig(globalConfigPath, {
				version: 1,
				defaultEnvironment: "test",
				environments: {
					test: {
						server: `http://127.0.0.1:${address.port}`,
						auth: { type: "bearer", tokenEnv: "VCPDECK_TEST_TOKEN" },
					},
				},
			});
			const logs: string[] = [];

			await runReleaseCommand("upload", [win, linux], {
				paths: { globalConfigPath, cwd: root },
				processEnv: { VCPDECK_TEST_TOKEN: "vcp_test_token" },
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
				requests.every((request) =>
					request.url.startsWith("/api/releases/upload?"),
				),
			).toBe(true);
			expect(logs.join("\n")).toContain("环境: test");
			expect(logs.join("\n")).not.toContain("vcp_test_token");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
