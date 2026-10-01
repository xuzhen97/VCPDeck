import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildGitSshCommand,
	buildSshConfig,
	gitSshChildEnv,
	parseOpenSshVersion,
	supportsAcceptNew,
	type GitSshSshProgram,
} from "./git-ssh-env.js";
import { createGitSshStore, type GitSshStore } from "./git-ssh-store.js";

const PRIVATE_KEY = [
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
	"-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7Wv0m0vcpdecktestkey";

const created: string[] = [];

afterEach(async () => {
	while (created.length > 0) {
		await rm(created.pop()!, { recursive: true, force: true }).catch(() => {});
	}
});

async function makeStore(withKey: boolean): Promise<GitSshStore> {
	const root = await mkdtemp(join(tmpdir(), "vcp-git-ssh-env-"));
	created.push(root);
	const store = createGitSshStore({
		root,
		platform: process.platform,
		restrictPermissions: async () => true,
	});
	if (withKey) {
		await store.install({
			protocolVersion: 1,
			operationId: "op-1",
			version: 1,
			action: "install",
			privateKey: PRIVATE_KEY,
			publicKey: PUBLIC_KEY,
		});
	}
	return store;
}

const okProgram: GitSshSshProgram = {
	path: "/usr/bin/ssh",
	supportsAcceptNew: true,
};

describe("parseOpenSshVersion / supportsAcceptNew", () => {
	it("解析版本并判定 accept-new 支持（>= 7.6）", () => {
		expect(parseOpenSshVersion("OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13")).toEqual([
			9, 6,
		]);
		expect(parseOpenSshVersion("OpenSSH_7.5p1, OpenSSL 1.0.2k")).toEqual([7, 5]);
		expect(parseOpenSshVersion("not-ssh-at-all")).toBeNull();

		expect(supportsAcceptNew([9, 6])).toBe(true);
		expect(supportsAcceptNew([7, 6])).toBe(true);
		expect(supportsAcceptNew([7, 5])).toBe(false);
		expect(supportsAcceptNew([6, 9])).toBe(false);
	});
});

describe("buildSshConfig", () => {
	it("只启用受管身份与 accept-new，不污染个人配置", () => {
		const config = buildSshConfig({
			privateKeyPath: "/data/git-ssh/id_ed25519",
			knownHostsPath: "/data/git-ssh/known_hosts",
		});
		expect(config).toContain("IdentityFile /data/git-ssh/id_ed25519");
		expect(config).toContain("IdentitiesOnly yes");
		expect(config).toContain("StrictHostKeyChecking accept-new");
		expect(config).toContain("UserKnownHostsFile /data/git-ssh/known_hosts");
		expect(config).toContain("BatchMode yes");
		expect(config).not.toContain("StrictHostKeyChecking no");
		expect(config).not.toContain("BEGIN OPENSSH");
	});
});

describe("buildGitSshCommand", () => {
	it("引用 ssh 程序与受限配置路径", () => {
		const command = buildGitSshCommand("/usr/bin/ssh", "/data/git-ssh/ssh_config");
		expect(command).toContain("-F");
		expect(command).toContain("/data/git-ssh/ssh_config");
		expect(command).not.toContain("BEGIN OPENSSH");
	});

	it("路径无法被 shell 安全表示时返回 null（fail closed）", () => {
		expect(buildGitSshCommand('/usr/bin/ss"h', "/data/ssh_config")).toBeNull();
		expect(buildGitSshCommand("/usr/bin/ssh", "/data/$HOME/ssh_config")).toBeNull();
		expect(buildGitSshCommand("/usr/bin/ssh", "/data/`whoami`/ssh_config")).toBeNull();
	});
});

describe("gitSshChildEnv", () => {
	it("未安装密钥时不注入，并移除继承来的 GIT_SSH_COMMAND", async () => {
		const store = await makeStore(false);
		const env = await gitSshChildEnv(
			{ HOME: "/tmp/personal-home", GIT_SSH_COMMAND: "ssh -i /tmp/other" },
			{ store, platform: process.platform, probeSsh: async () => okProgram },
		);
		expect(env.GIT_SSH_COMMAND).toBeUndefined();
		expect("GIT_SSH_COMMAND" in env).toBe(false);
		// 不触碰个人 SSH 配置
		expect(await readFile("/tmp/personal-home/.ssh/config", "utf8").catch(() => null)).toBeNull();
	});

	it("已安装密钥时注入 -F 受限配置，且不泄露私钥正文", async () => {
		const store = await makeStore(true);
		const before = { ...process.env };
		const env = await gitSshChildEnv(
			{ HOME: "/tmp/personal-home" },
			{ store, platform: process.platform, probeSsh: async () => okProgram },
		);

		expect(env.GIT_SSH_COMMAND).toContain("-F");
		// Windows 受管路径统一使用正斜杠（避免 `\` 被 shell 当作转义前缀）。
		const expectedConfigPath = store.paths().sshConfigPath.replace(/\\/g, "/");
		expect(env.GIT_SSH_COMMAND).toContain(expectedConfigPath);
		expect(JSON.stringify(env)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
		// 写出受管 ssh_config，且不修改进程全局环境
		const config = await readFile(store.paths().sshConfigPath, "utf8");
		expect(config).toContain("StrictHostKeyChecking accept-new");
		expect(process.env.GIT_SSH_COMMAND).toBe(before.GIT_SSH_COMMAND);
	});

	it("SSH 程序缺失或不支持 accept-new 时 fail closed（不注入）", async () => {
		const store = await makeStore(true);
		const missing = await gitSshChildEnv({}, { store, probeSsh: async () => null });
		expect("GIT_SSH_COMMAND" in missing).toBe(false);

		const old = await gitSshChildEnv(
			{},
			{
				store,
				probeSsh: async () => ({ path: "/usr/bin/ssh", supportsAcceptNew: false }),
			},
		);
		expect("GIT_SSH_COMMAND" in old).toBe(false);
	});

	it("路径含 shell 元字符时 fail closed（不注入）", async () => {
		const store = await makeStore(true);
		const env = await gitSshChildEnv(
			{},
			{
				store,
				probeSsh: async () => ({ path: '/opt/ss"h', supportsAcceptNew: true }),
			},
		);
		expect("GIT_SSH_COMMAND" in env).toBe(false);
	});

	it("探测抛错时 fail closed", async () => {
		const store = await makeStore(true);
		const env = await gitSshChildEnv(
			{},
			{
				store,
				probeSsh: vi.fn(async () => {
					throw new Error("spawn failed");
				}),
			},
		);
		expect("GIT_SSH_COMMAND" in env).toBe(false);
	});
});
