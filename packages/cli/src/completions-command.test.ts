import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCompletionsCommand } from "./completions-command.js";

const tempDirectories: string[] = [];

afterEach(async () => {
	const dirs = tempDirectories.splice(0);
	for (const dir of dirs) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function fixture(config?: unknown): Promise<{
	paths: { globalConfigPath: string; cwd: string };
}> {
	const dir = await mkdtemp(join(tmpdir(), "vcpdeck-completions-"));
	tempDirectories.push(dir);
	const globalConfigPath = join(dir, "config.json");
	if (config !== undefined) {
		await writeFile(globalConfigPath, JSON.stringify(config), "utf8");
	}
	return { paths: { globalConfigPath, cwd: dir } };
}

function capture(): { lines: string[]; log: (m: string) => void } {
	const lines: string[] = [];
	return { lines, log: (m) => lines.push(m) };
}

describe("completions command", () => {
	it("bash：包含顶层命令、子命令树与嵌入的环境名", async () => {
		const { paths } = await fixture({
			version: 1,
			defaultEnvironment: "prod",
			environments: {
				prod: {
					server: "http://localhost:3001",
					auth: { type: "bearer", tokenEnv: "VCPDECK_PROD_TOKEN" },
				},
				staging: {
					server: "http://localhost:4001",
					auth: { type: "bearer", tokenEnv: "VCPDECK_STAGING_TOKEN" },
				},
			},
		});
		const { lines, log } = capture();
		await runCompletionsCommand("bash", { log, paths });
		const text = lines.join("\n");
		expect(text).toContain("complete -F _vcpdeck vcpdeck");
		for (const cmd of [
			"env",
			"clients",
			"jobs",
			"files",
			"pi",
			"terminal",
			"frp",
			"storage",
			"release",
		]) {
			expect(text).toContain(cmd);
		}
		expect(text).toContain("--env=prod");
		expect(text).toContain("--env=staging");
		expect(text).toContain("roots list stat read");
		expect(text).toContain("models sessions new run attach abort");
	});

	it("powershell：包含 Register-ArgumentCompleter 与环境名候选", async () => {
		const { paths } = await fixture({
			version: 1,
			environments: {
				prod: {
					server: "http://localhost:3001",
					auth: { type: "bearer", tokenEnv: "VCPDECK_PROD_TOKEN" },
				},
			},
		});
		const { lines, log } = capture();
		await runCompletionsCommand("powershell", { log, paths });
		const text = lines.join("\n");
		expect(text).toContain("Register-ArgumentCompleter -CommandName vcpdeck");
		expect(text).toContain("$envNames = @('prod')");
		expect(text).toContain('"--env=$_"');
		expect(text).toContain("$wordToComplete*");
	});

	it("配置缺失时仍可生成（环境候选为空）", async () => {
		const { paths } = await fixture();
		const { lines, log } = capture();
		await runCompletionsCommand("bash", { log, paths });
		const text = lines.join("\n");
		expect(text).toContain("complete -F _vcpdeck vcpdeck");
		expect(text).not.toContain("--env=.");
	});

	it("未知类型报错；无参数输出用法", async () => {
		const { paths } = await fixture();
		await expect(
			runCompletionsCommand("fish", { log: () => {}, paths }),
		).rejects.toThrow(/未知补全类型/);
		const { lines, log } = capture();
		await runCompletionsCommand(undefined, { log, paths });
		expect(lines.join("\n")).toContain("completions bash");
	});
});
