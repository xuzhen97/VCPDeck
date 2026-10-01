import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createGitSshStore,
	resolveGitSshRoot,
	resolveWindowsGitSshUser,
	verifyGitSshRootWritable,
	windowsGitSshGrantArgs,
} from "./git-ssh-store.js";

const PRIVATE_KEY = [
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
	"-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const PUBLIC_KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7Wv0m0vcpdecktestkey";

const created: string[] = [];

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-git-ssh-store-"));
	created.push(dir);
	return dir;
}

afterEach(async () => {
	while (created.length > 0) {
		const dir = created.pop()!;
		// Windows ACL 收紧后当前测试账户可能无权删除，清理失败不得掩盖测试结果。
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

/**
 * 测试用 store：注入确定性权限收紧。
 *
 * 真实 Windows ACL（icacls 限 SYSTEM/Administrators）只适用于以 SYSTEM 运行的
 * 生产 Client，非 SYSTEM 的测试进程会被锁在外，因此平台验验收在实机进行。
 */
function makeStore(root: string, restrictPermissions = async () => true) {
	return createGitSshStore({ root, platform: process.platform, restrictPermissions });
}

describe("Windows 受管目录 ACL", () => {
	it("授权参数除 SYSTEM 与 Administrators 外必须带上当前运行账户", () => {
		// 少授权当前账户会让非 SYSTEM 运行的 Client 在收紧瞬间失去目录访问权，
		// 后续写版本指针必然 EACCES（真实集成测试在 Windows 普通账户上复现过）。
		const args = windowsGitSshGrantArgs("DEV\\xuzhe");
		expect(args.slice(0, 2)).toEqual(["/inheritance:r", "/grant:r"]);
		expect(args).toContain("SYSTEM:(OI)(CI)F");
		expect(args).toContain("Administrators:(OI)(CI)F");
		expect(args).toContain("DEV\\xuzhe:(OI)(CI)F");
	});

	it("解析不出账户名时不追加授权（不猜测账户）", () => {
		expect(windowsGitSshGrantArgs(null)).toEqual([
			"/inheritance:r",
			"/grant:r",
			"SYSTEM:(OI)(CI)F",
			"Administrators:(OI)(CI)F",
		]);
		expect(resolveWindowsGitSshUser({ whoami: () => null, env: {} })).toBeNull();
	});

	it("账户名优先取 whoami，其次环境变量", () => {
		expect(
			resolveWindowsGitSshUser({ whoami: () => "DEV\\xuzhe", env: { USERNAME: "other" } }),
		).toBe("DEV\\xuzhe");
		expect(
			resolveWindowsGitSshUser({ whoami: () => null, env: { USERNAME: "u", USERDOMAIN: "D" } }),
		).toBe("D\\u");
		expect(
			resolveWindowsGitSshUser({ whoami: () => null, env: { USERNAME: "u" } }),
		).toBe("u");
	});

	it("含会破坏 icacls 参数解析的字符时按解析不出处理", () => {
		expect(
			resolveWindowsGitSshUser({ whoami: () => 'bad"name', env: { USERNAME: "u" } }),
		).toBe("u");
		expect(windowsGitSshGrantArgs('bad"name')).toHaveLength(4);
	});

	it("可写性回读：可写目录通过且不残留探针，缺失目录不通过", async () => {
		const dir = await tempRoot();
		expect(await verifyGitSshRootWritable(dir)).toBe(true);
		expect(await readFile(join(dir, ".acl-probe")).catch(() => null)).toBeNull();
		expect(await verifyGitSshRootWritable(join(dir, "missing"))).toBe(false);
	});
});

function installCommand(version: number, overrides: Record<string, unknown> = {}) {
	return {
		protocolVersion: 1 as const,
		operationId: `op-${version}`,
		version,
		action: "install" as const,
		privateKey: PRIVATE_KEY,
		publicKey: PUBLIC_KEY,
		...overrides,
	};
}

describe("resolveGitSshRoot", () => {
	it("VCPDECK_CLIENT_DATA_DIR 优先，且落在版本目录之外", () => {
		const root = resolveGitSshRoot({
			platform: "linux",
			cwd: "/work",
			env: {
				VCPDECK_CLIENT_DATA_DIR: "/var/lib/vcpdeck-client",
				VCPDECK_APP_DIR: "/opt/vcpdeck/client",
			},
		});
		expect(root).toBe("/var/lib/vcpdeck-client/git-ssh");
	});

	it("未配置数据根时回退到 APP_DIR/data，并按平台拼接", () => {
		expect(
			resolveGitSshRoot({
				platform: "win32",
				cwd: "C:\\other",
				env: { VCPDECK_APP_DIR: "C:\\ProgramData\\VCPDeck\\Client" },
			}),
		).toBe("C:\\ProgramData\\VCPDeck\\Client\\data\\git-ssh");
	});

	it("数据根位于版本目录内时 fail closed", () => {
		expect(() =>
			resolveGitSshRoot({
				platform: "linux",
				cwd: "/work",
				env: {
					VCPDECK_CLIENT_DATA_DIR: "/opt/vcpdeck/client/apps/0.13.2/data",
					VCPDECK_APP_DIR: "/opt/vcpdeck/client",
				},
			}),
		).toThrow(/版本目录/);
	});
});

describe("GitSshStore 安装与清理", () => {
	it("安装后写入私钥/公钥/版本，activeVersion 与 hasKey 生效", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(1));

		const paths = store.paths();
		expect(await store.activeVersion()).toBe(1);
		expect(await store.hasKey()).toBe(true);
		expect(await readFile(paths.privateKeyPath, "utf8")).toBe(`${PRIVATE_KEY}\n`);
		expect(await readFile(paths.publicKeyPath, "utf8")).toBe(`${PUBLIC_KEY}\n`);
	});

	it("拒绝更旧的版本（防滚转），且不破坏当前版本", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(2));
		await expect(store.install(installCommand(1))).rejects.toMatchObject({
			code: "GIT_SSH_INSTALL_FAILED",
		});
		expect(await store.activeVersion()).toBe(2);
		expect(await store.hasKey()).toBe(true);
	});

	it("同版本重复下发视为幂等成功（重连对账不得把健康机器判为失败）", async () => {
		// Server 在每次重连、重复保存分发范围时都会重发 install（用于自愈本地被删的副本）；
		// 若 Client 把同版本当失败，一台密钥完好的机器会在每次重连后变成 failed 且不自愈。
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(2));

		await expect(store.install(installCommand(2))).resolves.toBeUndefined();
		expect(await store.activeVersion()).toBe(2);
		expect(await store.hasKey()).toBe(true);
		expect(await readFile(store.paths().privateKeyPath, "utf8")).toBe(`${PRIVATE_KEY}\n`);
	});

	it("版本指针在但私钥缺失时按重写处理（本地副本被删后自愈）", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(2));
		await rm(store.paths().privateKeyPath, { force: true });
		expect(await store.hasKey()).toBe(false);

		await store.install(installCommand(2));
		expect(await store.hasKey()).toBe(true);
		expect(await readFile(store.paths().privateKeyPath, "utf8")).toBe(`${PRIVATE_KEY}\n`);
	});

	it("先收紧目录权限再落盘私钥（收紧前不得存在密钥文件）", async () => {
		// 收紧前落盘会让私钥在窗口内继承父目录默认 ACL（可能含宽松主体）。
		const root = await tempRoot();
		const paths = createGitSshStore({
			root,
			platform: process.platform,
			restrictPermissions: async () => true,
		}).paths();
		let existedAtRestrictTime: boolean | null = null;
		const store = makeStore(root, async () => {
			existedAtRestrictTime = await readFile(paths.privateKeyPath, "utf8").then(
				() => true,
				() => false,
			);
			return true;
		});

		await store.install(installCommand(1));
		expect(existedAtRestrictTime).toBe(false);
	});

	it("权限收紧失败时不留下可用私钥（fail closed）", async () => {
		const root = await tempRoot();
		const restrict = vi.fn(async () => false);
		const store = makeStore(root, restrict);

		await expect(store.install(installCommand(1))).rejects.toMatchObject({
			code: "GIT_SSH_INSTALL_FAILED",
		});
		expect(restrict).toHaveBeenCalled();
		expect(await store.activeVersion()).toBeNull();
		expect(await store.hasKey()).toBe(false);
		const paths = store.paths();
		await expect(readFile(paths.privateKeyPath, "utf8")).rejects.toThrow();
	});

	it("安装不残留临时文件", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(1));
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(store.paths().root);
		expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	it("clear 只清理匹配版本，不匹配时保持现状", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await store.install(installCommand(3));

		await store.clear(2); // 过期清理：必须 no-op
		expect(await store.activeVersion()).toBe(3);
		expect(await store.hasKey()).toBe(true);

		await store.clear(3);
		expect(await store.activeVersion()).toBeNull();
		expect(await store.hasKey()).toBe(false);
		await expect(readFile(store.paths().privateKeyPath, "utf8")).rejects.toThrow();
	});

	it("clear 幂等：未安装时重复清理不抛错", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await expect(store.clear(1)).resolves.toBeUndefined();
		await expect(store.clear(1)).resolves.toBeUndefined();
	});

	it("版本指针内容非法时 fail closed", async () => {
		const root = await tempRoot();
		const store = makeStore(root);
		await mkdir(store.paths().root, { recursive: true });
		await writeFile(store.paths().versionPath, "not-a-version\n", "utf8");
		await expect(store.activeVersion()).rejects.toMatchObject({
			code: "GIT_SSH_UNAVAILABLE",
		});
	});

	it("根目录为符号链接时拒绝安装（越界防护）", async () => {
		if (process.platform === "win32") return; // Windows junction 需要特权，平台覆盖在实机验收
		const outside = await tempRoot();
		const root = join(outside, "git-ssh");
		const store = makeStore(root);
		await mkdir(root, { recursive: true });
		const real = join(outside, "real-target");
		await mkdir(real, { recursive: true });
		await rm(root, { recursive: true, force: true });
		const { symlink } = await import("node:fs/promises");
		await symlink(real, root);

		await expect(store.install(installCommand(1))).rejects.toMatchObject({
			code: "GIT_SSH_INSTALL_FAILED",
		});
	});

	it("POSIX 下私钥权限为 0600、目录为 0700", async () => {
		if (process.platform === "win32") return;
		const root = await tempRoot();
		// 此处刻意使用默认权限收紧（POSIX chmod），Windows 分支在实机验收。
		const store = createGitSshStore({ root, platform: process.platform });
		await store.install(installCommand(1));
		const paths = store.paths();
		expect((await stat(paths.privateKeyPath)).mode & 0o777).toBe(0o600);
		expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
	});
});
