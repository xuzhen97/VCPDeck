import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCliConfig, type ConfigPaths } from "./config.js";
import { runEnvCommand } from "./env-command.js";

const tempDirectories: string[] = [];

async function context(): Promise<{
	paths: ConfigPaths;
	logs: string[];
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-env-command-"));
	tempDirectories.push(root);
	const cwd = join(root, "repo", "nested");
	await mkdir(join(root, "repo", ".git"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	return {
		paths: {
			globalConfigPath: join(root, "home", ".vcpdeck", "cli", "config.json"),
			cwd,
		},
		logs: [],
	};
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("env command", () => {
	it("添加、查看、设置全局和项目默认并删除环境", async () => {
		const state = await context();
		const commandContext = {
			paths: state.paths,
			log: (message: string) => state.logs.push(message),
		};
		await runEnvCommand(
			"add",
			[
				"dev",
				"--server=http://localhost:3001",
				"--auth=password",
				"--username=admin",
				"--password-env=VCPDECK_DEV_PASSWORD",
			],
			commandContext,
		);
		await runEnvCommand("use", ["dev", "--global"], commandContext);
		await runEnvCommand("use", ["dev", "--local"], commandContext);
		await runEnvCommand("show", ["dev"], commandContext);
		await runEnvCommand("list", [], commandContext);

		const config = await loadCliConfig(state.paths.globalConfigPath);
		expect(config.defaultEnvironment).toBe("dev");
		expect(config.environments.dev.server).toBe("http://localhost:3001");
		expect(
			JSON.parse(
				await readFile(join(state.paths.cwd, "..", ".vcpdeck.json"), "utf8"),
			),
		).toEqual({ version: 1, environment: "dev" });
		expect(state.logs.join("\n")).not.toContain("secret");

		await runEnvCommand("remove", ["dev"], commandContext);
		expect(
			(await loadCliConfig(state.paths.globalConfigPath)).environments,
		).toEqual({});
	});

	it("默认把 token-env 注册为 Bearer，并拒绝认证参数混用", async () => {
		const state = await context();
		const commandContext = { paths: state.paths, log: () => undefined };
		const args = [
			"prod",
			"--server=https://deck.example",
			"--token-env=VCPDECK_PROD_TOKEN",
		];
		await runEnvCommand("add", args, commandContext);
		await runEnvCommand(
			"add",
			[
				"legacy",
				"--server=https://legacy.example",
				"--auth=bearer",
				"--token-env=LEGACY_TOKEN",
			],
			commandContext,
		);
		const environments = (await loadCliConfig(state.paths.globalConfigPath))
			.environments;
		expect(environments.prod.auth).toEqual({
			type: "bearer",
			tokenEnv: "VCPDECK_PROD_TOKEN",
		});
		expect(environments.legacy.auth).toEqual({
			type: "bearer",
			tokenEnv: "LEGACY_TOKEN",
		});
		await expect(runEnvCommand("add", args, commandContext)).rejects.toThrow(
			"环境已存在",
		);
		await expect(
			runEnvCommand(
				"add",
				[
					"bad",
					"--server=https://deck.example",
					"--auth=bearer",
					"--username=admin",
					"--token-env=TOKEN",
				],
				commandContext,
			),
		).rejects.toThrow("不接受");
	});

	it("用 Bearer Token 检查 Server 并显示对应身份", async () => {
		let authorization: string | undefined;
		const server = createServer((request, response) => {
			authorization = request.headers.authorization;
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					id: "identity-1",
					username: "operator",
					displayName: "Operator",
					isAdmin: true,
					disabledAt: null,
					createdAt: "2026-08-20T00:00:00.000Z",
				}),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("测试 Server 未监听");
			const state = await context();
			await runEnvCommand(
				"add",
				[
					"prod",
					`--server=http://127.0.0.1:${address.port}`,
					"--token-env=VCPDECK_PROD_TOKEN",
				],
				{ paths: state.paths, log: () => undefined },
			);
			await runEnvCommand("check", ["--env=prod"], {
				paths: state.paths,
				processEnv: { VCPDECK_PROD_TOKEN: "secret-token" },
				log: (message) => state.logs.push(message),
			});
			expect(authorization).toBe("Bearer secret-token");
			expect(state.logs.join("\n")).toContain("身份: operator (Operator) [admin]");
			expect(state.logs.join("\n")).not.toContain("secret-token");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
