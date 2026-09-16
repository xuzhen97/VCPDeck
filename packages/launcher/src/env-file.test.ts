import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFromEnv, loadLauncherEnvFile } from "./daemon.js";

/** ADR-0027：Windows SYSTEM 开机任务不注入环境变量，launcher 必须自行读取安装根下的 launcher.env。 */
describe("launcher.env 加载", () => {
	it("从安装根补齐缺失的 VCPDECK_* 并保留已有环境变量", () => {
		const dir = mkdtempSync(join(tmpdir(), "launcher-env-"));
		try {
			writeFileSync(
				join(dir, "launcher.env"),
				[
					"# 注释",
					"VCPDECK_ARTIFACT=client",
					"VCPDECK_SERVER=http://deck.example.com",
					"VCPDECK_CLIENT_ID=11111111-2222-4333-8444-555555555555",
					"",
					"无等号的行",
				].join("\n"),
			);
			const env: NodeJS.ProcessEnv = { VCPDECK_APP_DIR: dir, VCPDECK_ARTIFACT: "server" };
			loadLauncherEnvFile(env, dir);
			expect(env.VCPDECK_ARTIFACT).toBe("server");
			expect(env.VCPDECK_SERVER).toBe("http://deck.example.com");
			expect(env.VCPDECK_CLIENT_ID).toBe("11111111-2222-4333-8444-555555555555");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("无 launcher.env 时静默跳过，不改变任何变量", () => {
		const dir = mkdtempSync(join(tmpdir(), "launcher-env-empty-"));
		try {
			const env: NodeJS.ProcessEnv = { VCPDECK_APP_DIR: dir };
			loadLauncherEnvFile(env, dir);
			expect(env.VCPDECK_ARTIFACT).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loadConfigFromEnv 能以 cwd 为安装根启动（SYSTEM 任务只设置工作目录）", () => {
		const dir = mkdtempSync(join(tmpdir(), "launcher-env-cwd-"));
		const previous = { ...process.env };
		try {
			writeFileSync(
				join(dir, "launcher.env"),
				["VCPDECK_ARTIFACT=client", `VCPDECK_APP_DIR=${dir}`].join("\n"),
			);
			delete process.env.VCPDECK_ARTIFACT;
			delete process.env.VCPDECK_APP_DIR;
			const cwd = process.cwd();
			process.chdir(dir);
			try {
				const config = loadConfigFromEnv();
				expect(config.artifact).toBe("client");
				expect(config.appDir).toBe(dir);
			} finally {
				process.chdir(cwd);
			}
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in previous)) delete process.env[key];
			}
			Object.assign(process.env, previous);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
