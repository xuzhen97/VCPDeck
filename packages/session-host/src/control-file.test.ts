import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeControlFile } from "./control-file.js";

const PAYLOAD = { port: 51234, token: "a".repeat(64), hostId: "host-1" };

/**
 * 通用用例注入空 ACL 实现：单元测试不得真的改写开发机的文件 ACL，
 * 真实 icacls 行为由 Task 3 Step 5 在目标机器上人工核对。
 */
const NO_ACL = { applyWindowsAcl: async () => {} };

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "session-host-control-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("控制文件", () => {
	it("只写入 port/token/hostId 三个字段", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await writeControlFile(target, { ...PAYLOAD, extra: "should-not-appear" } as never, NO_ACL);
		const parsed = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(["hostId", "port", "token"]);
		expect(parsed.port).toBe(PAYLOAD.port);
		expect(parsed.token).toBe(PAYLOAD.token);
		expect(parsed.hostId).toBe(PAYLOAD.hostId);
	});

	it("覆盖写入后不残留临时文件", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await writeControlFile(target, PAYLOAD, NO_ACL);
		await writeControlFile(target, { ...PAYLOAD, token: "b".repeat(64) }, NO_ACL);
		const entries = await readdir(dir);
		expect(entries).toEqual(["control.json"]);
		const parsed = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
		expect(parsed.token).toBe("b".repeat(64));
	});

	it("写入被拒绝时清理临时文件且不破坏既有内容", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await writeControlFile(target, PAYLOAD, NO_ACL);
		// 以目录占位使 rename 必然失败，模拟原子替换中断。
		const blocked = path.join(dir, "blocked.json");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(path.join(blocked, "occupied"), { recursive: true });
		await expect(writeControlFile(blocked, PAYLOAD, NO_ACL)).rejects.toThrow();
		expect((await readdir(dir)).sort()).toEqual(["blocked.json", "control.json"]);
		expect((await readdir(blocked)).sort()).toEqual(["occupied"]);
	});

	it("非法负载在落盘前拒绝", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await expect(writeControlFile(target, { ...PAYLOAD, port: 0 })).rejects.toThrow();
		await expect(writeControlFile(target, { ...PAYLOAD, port: 70000 })).rejects.toThrow();
		await expect(writeControlFile(target, { ...PAYLOAD, port: 1.5 })).rejects.toThrow();
		await expect(writeControlFile(target, { ...PAYLOAD, token: "" })).rejects.toThrow();
		await expect(writeControlFile(target, { ...PAYLOAD, hostId: "" })).rejects.toThrow();
		expect(await readdir(dir)).toEqual([]);
		expect(await stat(target).catch(() => null)).toBeNull();
	});

	it.runIf(process.platform !== "win32")("POSIX 权限为 0600", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await writeControlFile(target, PAYLOAD, NO_ACL);
		const info = await stat(target);
		expect(info.mode & 0o777).toBe(0o600);
	});

	it("Windows 下必须调用 ACL 限制，不能只靠 chmod", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		const calls: Array<{ file: string; account: string }> = [];
		await writeControlFile(target, PAYLOAD, {
			platform: "win32",
			applyWindowsAcl: async (file, account) => {
				calls.push({ file, account });
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.file).toBe(target);
		expect((calls[0]?.account ?? "").length).toBeGreaterThan(0);
	});

	it("Windows ACL 失败时整体失败，不静默声称已限制", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		await expect(
			writeControlFile(target, PAYLOAD, {
				platform: "win32",
				applyWindowsAcl: async () => {
					throw new Error("icacls 失败");
				},
			}),
		).rejects.toThrow();
	});

	it("非 Windows 平台不触碰 ACL 逻辑", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "control.json");
		let called = 0;
		await writeControlFile(target, PAYLOAD, {
			platform: "linux",
			applyWindowsAcl: async () => {
				called += 1;
			},
		});
		expect(called).toBe(0);
	});
});
