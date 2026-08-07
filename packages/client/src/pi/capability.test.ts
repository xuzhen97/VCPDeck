import { describe, expect, it } from "vitest";
import { probePiCapability, type ProbeEnv } from "./capability.js";

function fakeEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
	return {
		nodeVersion: "22.19.0",
		platform: "win32",
		homedir: "C:\\Users\\test",
		readSettingsShellPath: async () => null,
		existsGitBash: async () => false,
		findBashInPath: async () => false,
		forkProbeWorker: async () => ({
			sdkVersion: "0.84.0",
			modelCount: 2,
			error: null,
		}),
		readAgentDir: async () => true,
		...overrides,
	};
}

describe("probePiCapability", () => {
	it("Windows 全满足时返回 available + git-bash 来源", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
			}),
		);
		expect(result).toMatchObject({
			available: true,
			sdkVersion: "0.84.0",
			nodeVersion: "22.19.0",
			shellKind: "git-bash",
		});
	});

	it("配置 shellPath 优先于 Git Bash", async () => {
		const result = await probePiCapability(
			fakeEnv({
				readSettingsShellPath: async () => "C:\\tools\\bash.exe",
				existsGitBash: async () => true,
			}),
		);
		expect(result).toMatchObject({ available: true, shellKind: "configured" });
	});

	it("PATH bash 作为最后来源", async () => {
		const result = await probePiCapability(
			fakeEnv({ findBashInPath: async () => true }),
		);
		expect(result).toMatchObject({ available: true, shellKind: "path" });
	});

	it("Linux 使用 system bash", async () => {
		const result = await probePiCapability(
			fakeEnv({
				platform: "linux",
				existsGitBash: async () => true,
			}),
		);
		expect(result).toMatchObject({ available: true, shellKind: "system" });
	});

	it("Node 过旧返回 PI_NODE_UNSUPPORTED", async () => {
		const result = await probePiCapability(fakeEnv({ nodeVersion: "22.18.99" }));
		expect(result).toMatchObject({
			available: false,
			code: "PI_NODE_UNSUPPORTED",
			nodeVersion: "22.18.99",
		});
	});

	it("Windows 找不到 Bash 返回 PI_BASH_NOT_FOUND", async () => {
		const result = await probePiCapability(fakeEnv({}));
		expect(result).toMatchObject({
			available: false,
			code: "PI_BASH_NOT_FOUND",
		});
	});

	it("Worker 失败返回 PI_RUNTIME_UNAVAILABLE", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				forkProbeWorker: async () => ({
					sdkVersion: "",
					modelCount: 0,
					error: { code: "PI_RUNTIME_UNAVAILABLE", message: "sdk load failed" },
				}),
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
		});
	});

	it("无已认证模型返回 PI_AUTH_UNAVAILABLE", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				forkProbeWorker: async () => ({
					sdkVersion: "0.84.0",
					modelCount: 0,
					error: null,
				}),
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_AUTH_UNAVAILABLE",
		});
	});

	it("Agent 目录不可读返回 PI_RUNTIME_UNAVAILABLE", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				readAgentDir: async () => false,
			}),
		);
		expect(result).toMatchObject({
			available: false,
			code: "PI_RUNTIME_UNAVAILABLE",
		});
	});

	it("结果不包含路径或凭据", async () => {
		const result = await probePiCapability(
			fakeEnv({
				existsGitBash: async () => true,
				readSettingsShellPath: async () => "C:\\Users\\test\\AppData\\Roaming\\npm\\bash.exe",
			}),
		);
		expect(JSON.stringify(result)).not.toContain("Users");
		expect(JSON.stringify(result)).not.toContain("AppData");
	});
});
