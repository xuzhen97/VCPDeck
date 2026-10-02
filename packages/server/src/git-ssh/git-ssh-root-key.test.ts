/**
 * Git SSH 受管根密钥文件（Server 侧）单元测试。
 *
 * 权威边界见 docs/adr/0037：根密钥位于版本目录外的数据根，
 * 首次「生成」时自动创建；已有密文而根密钥缺失/损坏/错绑时必须 fail closed，
 * 绝不静默换钥。
 */
import { randomBytes } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGitSshRootKey,
	isExplicitGitSshRootKey,
	readGitSshRootKey,
	resolveGitSshRootKeyPath,
} from "./git-ssh-root-key.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-rootkey-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		await rm(dirs.pop()!, { recursive: true, force: true });
	}
});

const isWindows = process.platform === "win32";

describe("resolveGitSshRootKeyPath", () => {
	it("缺省受管路径位于 VCPDECK_APP_DIR 的 data 之下（版本目录外）", async () => {
		const appDir = await tempDir();
		const location = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			process.platform,
		);
		expect(location).toBe(
			join(appDir, "data", "git-ssh", "root.key"),
		);
	});

	it("无 VCPDECK_APP_DIR 时回退到 cwd", async () => {
		const cwd = await tempDir();
		expect(resolveGitSshRootKeyPath({}, cwd, process.platform)).toBe(
			join(cwd, "data", "git-ssh", "root.key"),
		);
	});

	it("显式 VCPDECK_GIT_SSH_KEY_FILE 优先，且标记为显式", async () => {
		const appDir = await tempDir();
		const explicit = join(appDir, "custom", "git.key");
		const env = { VCPDECK_APP_DIR: appDir, VCPDECK_GIT_SSH_KEY_FILE: explicit };
		expect(resolveGitSshRootKeyPath(env, appDir, process.platform)).toBe(explicit);
		expect(isExplicitGitSshRootKey(env)).toBe(true);
		expect(isExplicitGitSshRootKey({})).toBe(false);
	});
});

describe("readGitSshRootKey", () => {
	it("文件不存在返回 null，且不创建任何文件", async () => {
		const appDir = await tempDir();
		const file = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			process.platform,
		);
		expect(await readGitSshRootKey(file)).toBeNull();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("内容非法（非 32 字节 / 非规范 base64 / 乱码）一律安全失败", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		for (const content of [
			"short\n",
			`${randomBytes(31).toString("base64")}\n`,
			`${randomBytes(32).toString("base64")}!!\n`,
			"not-a-key\n",
			"",
		]) {
			await writeFile(file, content);
			await expect(readGitSshRootKey(file)).rejects.toMatchObject({
				code: "GIT_SSH_KEY_UNAVAILABLE",
			});
		}
	});

	it("错误信息不含密钥内容与路径", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		const secret = randomBytes(32).toString("base64");
		await writeFile(file, `${secret}!\n`);
		try {
			await readGitSshRootKey(file);
			throw new Error("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).not.toContain(secret);
			expect(message).not.toContain(dir);
		}
	});
});

describe("createGitSshRootKey", () => {
	it("首次创建 32 字节密钥，重复调用幂等且不改写文件", async () => {
		const appDir = await tempDir();
		const file = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			process.platform,
		);
		const first = await createGitSshRootKey(file, { platform: process.platform });
		expect(first).toHaveLength(32);
		const raw = await readFile(file, "utf8");
		expect(raw.trim()).toBe(first.toString("base64"));

		const second = await createGitSshRootKey(file, { platform: process.platform });
		expect(second.equals(first)).toBe(true);
		expect(await readFile(file, "utf8")).toBe(raw);
	});

	it("已有可读密钥时直接复用，不重建", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		const existing = randomBytes(32);
		await writeFile(file, `${existing.toString("base64")}\n`);
		const result = await createGitSshRootKey(file, { platform: process.platform });
		expect(result.equals(existing)).toBe(true);
	});

	it("已有损坏密钥时拒绝覆盖（不静默换钥）", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		await writeFile(file, "broken\n");
		await expect(
			createGitSshRootKey(file, { platform: process.platform }),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		expect(await readFile(file, "utf8")).toBe("broken\n");
	});

	it("并发创建只产生一把密钥", async () => {
		const appDir = await tempDir();
		const file = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			process.platform,
		);
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				createGitSshRootKey(file, { platform: process.platform }),
			),
		);
		for (const key of results) expect(key.equals(results[0]!)).toBe(true);
		expect((await readGitSshRootKey(file))!.equals(results[0]!)).toBe(true);
	});

	it("发布位置被占用为目录时拒绝，不覆盖也不留半成品", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		await mkdir(file);
		await expect(
			createGitSshRootKey(file, { platform: process.platform }),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
	});

	it("权限收紧失败时 fail closed，不留下可用密钥", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		await expect(
			createGitSshRootKey(file, {
				platform: process.platform,
				restrict: async () => false,
			}),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(isWindows)("POSIX 下目录 0700、文件 0600", async () => {
		const appDir = await tempDir();
		const file = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			"linux",
		);
		await createGitSshRootKey(file, { platform: "linux" });
		const rootMode = (await stat(join(appDir, "data", "git-ssh"))).mode & 0o777;
		const fileMode = (await stat(file)).mode & 0o777;
		expect(rootMode).toBe(0o700);
		expect(fileMode).toBe(0o600);
	});

	it.skipIf(!isWindows)("Windows 下 ACL 同时授权当前运行账户、SYSTEM 与 Administrators", async () => {
		const appDir = await tempDir();
		const file = resolveGitSshRootKeyPath(
			{ VCPDECK_APP_DIR: appDir },
			appDir,
			"win32",
		);
		await createGitSshRootKey(file, { platform: "win32" });
		// 收紧后当前进程必须仍可写：曾出现只授权 SYSTEM 而把运行账户锁在目录外的故障。
		const probe = join(appDir, "data", "git-ssh", ".acl-probe");
		await writeFile(probe, "x");
		await rm(probe, { force: true });
		const { execFileSync } = await import("node:child_process");
		const acl = execFileSync("icacls", [join(appDir, "data", "git-ssh")], {
			encoding: "utf8",
		});
		expect(acl).toMatch(/SYSTEM/);
		expect(acl).toMatch(/Administrators/i);
		const userName = process.env.USERNAME ?? "";
		if (userName.length > 0) {
			expect(acl.toLowerCase()).toContain(userName.toLowerCase());
		}
	});
});

describe("符号链接防护", () => {
	it("受管目录为符号链接时拒绝读写", async () => {
		const appDir = await tempDir();
		const target = await tempDir();
		const dataDir = join(appDir, "data");
		await mkdir(dataDir, { recursive: true });
		await symlink(target, join(dataDir, "git-ssh"), isWindows ? "junction" : "dir");
		const file = join(dataDir, "git-ssh", "root.key");
		await expect(readGitSshRootKey(file)).rejects.toMatchObject({
			code: "GIT_SSH_KEY_UNAVAILABLE",
		});
		await expect(
			createGitSshRootKey(file, { platform: process.platform }),
		).rejects.toMatchObject({ code: "GIT_SSH_KEY_UNAVAILABLE" });
	});

	it.skipIf(isWindows)("正式文件为符号链接时拒绝读取", async () => {
		const dir = await tempDir();
		const other = await tempDir();
		const real = join(other, "real.key");
		await writeFile(real, `${randomBytes(32).toString("base64")}\n`);
		const link = join(dir, "root.key");
		await symlink(real, link);
		await expect(readGitSshRootKey(link)).rejects.toMatchObject({
			code: "GIT_SSH_KEY_UNAVAILABLE",
		});
	});
});
