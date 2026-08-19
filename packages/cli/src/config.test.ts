import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	findProjectConfig,
	localProjectConfigTarget,
	parseCliConfig,
	parseProjectConfig,
	saveCliConfig,
} from "./config.js";

const tempDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "vcpdeck-cli-config-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("CLI config parser", () => {
	it("接受仅引用环境变量的 password/bearer 环境", () => {
		expect(
			parseCliConfig({
				version: 1,
				defaultEnvironment: "dev",
				environments: {
					dev: {
						server: "http://localhost:3001/",
						auth: {
							type: "password",
							username: "admin",
							passwordEnv: "VCPDECK_DEV_PASSWORD",
						},
					},
					prod: {
						server: "https://deck.example.com",
						auth: { type: "bearer", tokenEnv: "VCPDECK_PROD_TOKEN" },
					},
				},
			}),
		).toMatchObject({
			defaultEnvironment: "dev",
			environments: {
				dev: { server: "http://localhost:3001" },
				prod: { server: "https://deck.example.com" },
			},
		});
	});

	it("拒绝保留环境名", () => {
		expect(() =>
			parseCliConfig({
				version: 1,
				environments: {
					constructor: {
						server: "https://deck.example.com",
						auth: { type: "bearer", tokenEnv: "TOKEN" },
					},
				},
			}),
		).toThrow("保留名称");
	});

	it("拒绝未知字段、明文秘密和项目内 Server", () => {
		expect(() =>
			parseCliConfig({
				version: 1,
				environments: {
					prod: {
						server: "https://deck.example.com",
						auth: {
							type: "bearer",
							tokenEnv: "TOKEN",
							token: "secret",
						},
					},
				},
			}),
		).toThrow("未知字段");
		expect(() =>
			parseProjectConfig({
				version: 1,
				environment: "prod",
				server: "https://evil.example",
			}),
		).toThrow("未知字段");
	});
});

describe("CLI config files", () => {
	it("查找最近父目录配置并在 Git 根停止", async () => {
		const root = await tempDirectory();
		const nested = join(root, "packages", "app");
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(nested, { recursive: true });
		await writeFile(
			join(root, ".vcpdeck.json"),
			JSON.stringify({ version: 1, environment: "dev" }),
		);
		expect(await findProjectConfig(nested)).toBe(join(root, ".vcpdeck.json"));
		expect(await localProjectConfigTarget(nested)).toBe(
			join(root, ".vcpdeck.json"),
		);
	});

	it("没有现存选择器时将 --local 写到 Git 根", async () => {
		const root = await tempDirectory();
		const nested = join(root, "packages", "app");
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(nested, { recursive: true });
		expect(await localProjectConfigTarget(nested)).toBe(
			join(root, ".vcpdeck.json"),
		);
	});

	it("原子保存全局配置且 POSIX 权限为 0600", async () => {
		const root = await tempDirectory();
		const path = join(root, ".vcpdeck", "cli", "config.json");
		await saveCliConfig(path, {
			version: 1,
			defaultEnvironment: "dev",
			environments: {
				dev: {
					server: "http://localhost:3001",
					auth: {
						type: "password",
						username: "admin",
						passwordEnv: "VCPDECK_DEV_PASSWORD",
					},
				},
			},
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			defaultEnvironment: "dev",
		});
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
	});
});
