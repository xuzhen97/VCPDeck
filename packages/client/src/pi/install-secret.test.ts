import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadOrCreateInstallSecret,
	sessionNamespaceFor,
} from "./install-secret.js";
import { projectKeyFor } from "./project-path.js";

async function tempSecretPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vcp-secret-"));
	return join(dir, "install-secret");
}

describe("install-secret 与 Session namespace", () => {
	it("首次生成 64 位 hex，第二次读取同值（等价 Client 重启）", async () => {
		const file = await tempSecretPath();
		const first = await loadOrCreateInstallSecret(file);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await loadOrCreateInstallSecret(file)).toBe(first);
	});

	it("文件权限为 0600（POSIX）", async () => {
		const file = await tempSecretPath();
		await loadOrCreateInstallSecret(file);
		if (process.platform !== "win32") {
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
	});

	it("同一 cwd 跨进程/重启得到同一 namespace，不同 cwd 不同", async () => {
		const file = await tempSecretPath();
		const secret = await loadOrCreateInstallSecret(file);
		const a1 = sessionNamespaceFor("/repo/a", secret);
		const a2 = sessionNamespaceFor("/repo/a", await loadOrCreateInstallSecret(file));
		expect(a1).toBe(a2);
		expect(sessionNamespaceFor("/repo/b", secret)).not.toBe(a1);
	});

	it("namespace 是 64 位 hex 且不泄露 cwd", async () => {
		const file = await tempSecretPath();
		const secret = await loadOrCreateInstallSecret(file);
		const ns = sessionNamespaceFor("/repo/secret-project", secret);
		expect(ns).toMatch(/^[0-9a-f]{64}$/);
		expect(ns).not.toContain("secret-project");
	});

	it("损坏的 secret 文件 fail closed，不静默重新生成", async () => {
		const file = await tempSecretPath();
		await writeFile(file, "not-a-secret");
		await expect(loadOrCreateInstallSecret(file)).rejects.toThrow(
			/install-secret/,
		);
		expect(await readFile(file, "utf8")).toBe("not-a-secret");
	});

	it("Run 锁 projectKey 仍随进程变化，与 namespace 分离", async () => {
		const file = await tempSecretPath();
		const secret = await loadOrCreateInstallSecret(file);
		const ns = sessionNamespaceFor("/repo/a", secret);
		expect(projectKeyFor("/repo/a")).not.toBe(ns);
		expect(projectKeyFor("/repo/a")).not.toBe(projectKeyFor("/repo/a", secret));
	});
});
