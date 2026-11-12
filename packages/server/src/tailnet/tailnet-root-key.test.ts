/**
 * Tailnet 受管根密钥文件（Server 侧）单元测试。
 *
 * 权威边界见 ADR-0062：根密钥位于版本目录外的数据根，只有数据库中没有历史
 * Tailnet 凭据时才允许首次自动创建；已有密文而根密钥缺失/损坏/错绑必须
 * fail closed，绝不静默换钥。
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTailnetRootKey,
	isExplicitTailnetRootKey,
	readTailnetRootKey,
	resolveTailnetRootKeyPath,
} from "./tailnet-root-key.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-tailnet-rootkey-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		await rm(dirs.pop()!, { recursive: true, force: true });
	}
});

const unavailable = { code: "TAILNET_KEY_UNAVAILABLE" };

describe("resolveTailnetRootKeyPath", () => {
	it("缺省受管路径位于 VCPDECK_APP_DIR 的 data 之下（版本目录外）", async () => {
		const appDir = await tempDir();
		expect(resolveTailnetRootKeyPath({ VCPDECK_APP_DIR: appDir }, appDir)).toBe(
			join(appDir, "data", "tailnet", "root.key"),
		);
	});

	it("无 VCPDECK_APP_DIR 时回退到 cwd", async () => {
		const cwd = await tempDir();
		expect(resolveTailnetRootKeyPath({}, cwd)).toBe(
			join(cwd, "data", "tailnet", "root.key"),
		);
	});

	it("显式 VCPDECK_TAILNET_KEY_FILE 优先，且标记为显式", async () => {
		const appDir = await tempDir();
		const explicit = join(appDir, "custom", "tailnet.key");
		const env = {
			VCPDECK_APP_DIR: appDir,
			VCPDECK_TAILNET_KEY_FILE: explicit,
		};
		expect(resolveTailnetRootKeyPath(env, appDir)).toBe(explicit);
		expect(isExplicitTailnetRootKey(env)).toBe(true);
		expect(isExplicitTailnetRootKey({})).toBe(false);
	});

});

describe("readTailnetRootKey", () => {
	it("文件不存在返回 null，且不创建任何文件", async () => {
		const appDir = await tempDir();
		const file = resolveTailnetRootKeyPath({ VCPDECK_APP_DIR: appDir }, appDir);
		expect(await readTailnetRootKey(file)).toBeNull();
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("合法 32 字节 base64 可读回同一密钥", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		const key = randomBytes(32);
		await writeFile(file, `${key.toString("base64")}\n`);
		expect(await readTailnetRootKey(file)).toEqual(key);
	});

	it("内容非法（非 32 字节 / 非规范 base64 / 乱码 / 空）一律安全失败", async () => {
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
			await expect(readTailnetRootKey(file)).rejects.toMatchObject(unavailable);
		}
	});

	it("符号链接一律拒绝，不跟随目标", async () => {
		const dir = await tempDir();
		const target = join(dir, "real.key");
		const linkPath = join(dir, "root.key");
		await writeFile(target, `${randomBytes(32).toString("base64")}\n`);
		try {
			await symlink(target, linkPath);
		} catch {
			// Windows 未开开发者模式时会拒绝建符号链接，跳过该断言。
			return;
		}
		await expect(readTailnetRootKey(linkPath)).rejects.toMatchObject(unavailable);
	});

	it("错误信息不含密钥内容与路径", async () => {
		const dir = await tempDir();
		const file = join(dir, "root.key");
		const secret = randomBytes(32).toString("base64");
		await writeFile(file, `${secret}!\n`);
		try {
			await readTailnetRootKey(file);
			throw new Error("should have thrown");
		} catch (error) {
			const message = (error as Error).message;
			expect(message).not.toContain(secret);
			expect(message).not.toContain(dir);
		}
	});
});

describe("createTailnetRootKey", () => {
	const posixOnly = process.platform !== "win32";

	it("首次创建 32 字节密钥，重复调用幂等且不改写文件", async () => {
		const dir = await tempDir();
		const file = join(dir, "data", "tailnet", "root.key");
		const first = await createTailnetRootKey(file);
		expect(first).toHaveLength(32);
		const second = await createTailnetRootKey(file);
		expect(second).toEqual(first);
		if (posixOnly) {
			const dirInfo = await stat(join(dir, "data", "tailnet"));
			const fileInfo = await stat(file);
			expect(dirInfo.mode & 0o777).toBe(0o700);
			expect(fileInfo.mode & 0o777).toBe(0o600);
		}
	});

	it("目录权限收紧失败时 fail closed，且不落盘密钥", async () => {
		const dir = await tempDir();
		const file = join(dir, "data", "tailnet", "root.key");
		await expect(
			createTailnetRootKey(file, { restrict: async () => false }),
		).rejects.toMatchObject(unavailable);
		await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("并发首次创建只有一个赢家，所有调用拿到同一密钥", async () => {
		const dir = await tempDir();
		const file = join(dir, "data", "tailnet", "root.key");
		const keys = await Promise.all(
			Array.from({ length: 5 }, () => createTailnetRootKey(file)),
		);
		const hex = new Set(keys.map((key) => key.toString("hex")));
		expect(hex.size).toBe(1);
	});

	it("已存在损坏密钥时不覆盖重建，保持 fail closed", async () => {
		const dir = await tempDir();
		const file = join(dir, "data", "tailnet", "root.key");
		await mkdir(join(dir, "data", "tailnet"), { recursive: true });
		await writeFile(file, "broken\n");
		await expect(createTailnetRootKey(file)).rejects.toMatchObject(unavailable);
		expect(await readTailnetRootKey(file).catch(() => null)).toBeNull();
	});
});
