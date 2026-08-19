import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveCliConfig, type ConfigPaths } from "./config.js";
import { resolveEnvironment } from "./environment.js";

const tempDirectories: string[] = [];

async function fixture(): Promise<{
	root: string;
	project: string;
	paths: ConfigPaths;
}> {
	const root = await mkdtemp(join(tmpdir(), "vcpdeck-cli-env-"));
	tempDirectories.push(root);
	const project = join(root, "repo", "packages", "app");
	await mkdir(join(root, "repo", ".git"), { recursive: true });
	await mkdir(project, { recursive: true });
	const paths = {
		globalConfigPath: join(root, "home", ".vcpdeck", "cli", "config.json"),
		cwd: project,
	};
	await saveCliConfig(paths.globalConfigPath, {
		version: 1,
		defaultEnvironment: "global",
		environments: {
			global: {
				server: "https://global.example",
				auth: { type: "bearer", tokenEnv: "GLOBAL_TOKEN" },
			},
			project: {
				server: "https://project.example",
				auth: {
					type: "password",
					username: "operator",
					passwordEnv: "PROJECT_PASSWORD",
				},
			},
			flag: {
				server: "https://flag.example",
				auth: { type: "bearer", tokenEnv: "FLAG_TOKEN" },
			},
			envvar: {
				server: "https://env.example",
				auth: { type: "bearer", tokenEnv: "ENV_TOKEN" },
			},
		},
	});
	return { root, project, paths };
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("resolveEnvironment", () => {
	it("按 flag > 环境变量 > 项目 > 全局默认的顺序选择", async () => {
		const { project, paths } = await fixture();
		await writeFile(
			join(project, "..", "..", ".vcpdeck.json"),
			JSON.stringify({ version: 1, environment: "project" }),
		);
		const processEnv: NodeJS.ProcessEnv = {
			VCPDECK_ENVIRONMENT: "envvar",
			FLAG_TOKEN: "flag-token",
			ENV_TOKEN: "env-token",
			PROJECT_PASSWORD: "project-password",
			GLOBAL_TOKEN: "global-token",
		};

		expect(
			await resolveEnvironment({
				environment: "flag",
				paths,
				processEnv,
			}),
		).toMatchObject({ name: "flag", server: "https://flag.example" });
		expect(await resolveEnvironment({ paths, processEnv })).toMatchObject({
			name: "envvar",
			server: "https://env.example",
		});
		delete processEnv.VCPDECK_ENVIRONMENT;
		expect(await resolveEnvironment({ paths, processEnv })).toMatchObject({
			name: "project",
			server: "https://project.example",
		});
		await rm(join(project, "..", "..", ".vcpdeck.json"));
		expect(await resolveEnvironment({ paths, processEnv })).toMatchObject({
			name: "global",
			server: "https://global.example",
		});
	});

	it("项目配置损坏或引用未知环境时 fail closed", async () => {
		const { project, paths } = await fixture();
		const path = join(project, "..", "..", ".vcpdeck.json");
		await writeFile(path, "{broken");
		await expect(
			resolveEnvironment({
				paths,
				processEnv: { GLOBAL_TOKEN: "global-token" },
			}),
		).rejects.toThrow("不是有效 JSON");
		await writeFile(path, JSON.stringify({ version: 1, environment: "missing" }));
		await expect(
			resolveEnvironment({
				paths,
				processEnv: { GLOBAL_TOKEN: "global-token" },
			}),
		).rejects.toThrow("环境不存在: missing");
	});

	it("凭据变量缺失时失败，current 模式可只解析安全摘要", async () => {
		const { paths } = await fixture();
		await expect(
			resolveEnvironment({ environment: "flag", paths, processEnv: {} }),
		).rejects.toThrow("FLAG_TOKEN");
		const summary = await resolveEnvironment({
			environment: "flag",
			paths,
			processEnv: {},
			requireCredentials: false,
		});
		expect(summary.name).toBe("flag");
		expect("credentials" in summary).toBe(false);
	});

	it("--server 与命名环境冲突，直连模式保持兼容", async () => {
		const { paths } = await fixture();
		await expect(
			resolveEnvironment({
				environment: "flag",
				server: "https://direct.example",
				paths,
			}),
		).rejects.toThrow("不能同时使用");
		expect(
			await resolveEnvironment({
				server: "https://direct.example/",
				username: "admin",
				password: "secret",
				paths,
			}),
		).toMatchObject({
			name: null,
			server: "https://direct.example",
			credentials: { type: "password", username: "admin" },
		});
	});
});
