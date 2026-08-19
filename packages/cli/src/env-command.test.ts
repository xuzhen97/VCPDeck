import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

	it("拒绝重复环境和认证参数混用", async () => {
		const state = await context();
		const commandContext = { paths: state.paths, log: () => undefined };
		const args = [
			"prod",
			"--server=https://deck.example",
			"--auth=bearer",
			"--token-env=VCPDECK_PROD_TOKEN",
		];
		await runEnvCommand("add", args, commandContext);
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
});
