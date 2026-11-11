/**
 * Tailnet 短时密钥文件单测（ADR-0062）。
 *
 * 真实临时目录 + 注入 ACL 失败路径；不写任何真实密钥。
 */
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTailnetSecretFiles,
	withTailnetSecretFile,
	type TailnetSecretFileDeps,
} from "./secret-file.js";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vcp-tailnet-secret-test-"));
});

afterEach(async () => {
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	}).catch(() => undefined);
});

function deps(
	overrides: Partial<TailnetSecretFileDeps> = {},
): Partial<TailnetSecretFileDeps> {
	return {
		platform: process.platform,
		rootDir: root,
		now: () => Date.now(),
		staleMs: 60_000,
		...overrides,
	};
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? "NO_CODE";
	}
	return "NO_THROW";
}

describe("Tailnet 短时密钥文件", () => {
	it("成功路径写出正文并在消费结束后删除", async () => {
		let seenPath = "";
		await withTailnetSecretFile(
			"tskey-auth-fake-secret",
			async (path) => {
				seenPath = path;
				expect(await readFile(path, "utf8")).toBe("tskey-auth-fake-secret");
				if (process.platform !== "win32") {
					expect((await stat(path)).mode & 0o077).toBe(0);
				}
			},
			deps(),
		);
		await expect(access(seenPath)).rejects.toThrow();
	});

	it("消费方抛错时仍然删除文件并保留原始错误", async () => {
		let file = "";
		await expect(
			withTailnetSecretFile(
				"fake-secret",
				async (path) => {
					file = path;
					throw new Error("safe-test-failure");
				},
				deps(),
			),
		).rejects.toThrow("safe-test-failure");
		await expect(access(file)).rejects.toThrow();
	});

	it("清理失败返回固定安全 code，不虚报成功", async () => {
		const code = await codeOf(
			withTailnetSecretFile("fake-secret", async () => "done", deps({
				removeDir: async () => {
					throw new Error("busy");
				},
			})),
		);
		expect(code).toBe("TAILNET_SECRET_CLEANUP_FAILED");
	});

	it("非法密钥正文在落盘前拒绝", async () => {
		expect(await codeOf(withTailnetSecretFile("", async () => undefined, deps()))).toBe(
			"TAILNET_SECRET_DENIED",
		);
		expect(
			await codeOf(withTailnetSecretFile("a\nb", async () => undefined, deps())),
		).toBe("TAILNET_SECRET_DENIED");
		expect(
			await codeOf(
				withTailnetSecretFile("x".repeat(4097), async () => undefined, deps()),
			),
		).toBe("TAILNET_SECRET_DENIED");
	});

	it("Windows ACL 设置/验证失败时不写正文、不调用消费方", async () => {
		let called = false;
		const code = await codeOf(
			withTailnetSecretFile(
				"fake-secret",
				async () => {
					called = true;
				},
				deps({
					platform: "win32",
					restrictWindowsDirectory: async () => {
						throw new Error("acl-failed");
					},
				}),
			),
		);
		expect(code).toBe("TAILNET_SECRET_DENIED");
		expect(called).toBe(false);
	});

	it("启动清理只删除自有目录中的过期残留，跳过新目录与在途文件", async () => {
		const stale = join(root, "stale");
		const fresh = join(root, "fresh");
		await mkdir(stale, { recursive: true });
		await mkdir(fresh, { recursive: true });
		const old = new Date(Date.now() - 60 * 60_000);
		await utimes(stale, old, old);

		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let activePath = "";
		const active = withTailnetSecretFile(
			"fake-secret",
			async (path) => {
				activePath = path;
				await gate;
			},
			deps(),
		);
		for (let i = 0; i < 300 && !activePath; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(activePath).not.toBe("");

		await cleanupTailnetSecretFiles(deps());
		await expect(access(stale)).rejects.toThrow();
		await expect(access(fresh)).resolves.toBeUndefined();
		await expect(access(activePath)).resolves.toBeUndefined();

		release();
		await active;
		await expect(access(activePath)).rejects.toThrow();
	});
});
