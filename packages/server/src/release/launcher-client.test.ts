import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherHttpClient } from "./launcher-client.js";

function okResponse() {
	return { ok: true, status: 200, text: async () => "ok" };
}

function errResponse(status: number, body: string) {
	return { ok: false, status, text: async () => body };
}

describe("LauncherHttpClient", () => {
	let dir: string;
	let controlFile: string;
	let fetchImpl: ReturnType<typeof vi.fn>;
	let client: LauncherHttpClient;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "launcher-ctl-"));
		controlFile = join(dir, "control.json");
		await writeFile(
			controlFile,
			JSON.stringify({ port: 43123, token: "secret-token" }),
		);
		fetchImpl = vi.fn();
		client = new LauncherHttpClient({ controlFile, fetchImpl });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	describe("prepareUpdate", () => {
		it("读取 control.json 并 POST /prepare（带 token）", async () => {
			fetchImpl.mockResolvedValue(okResponse());

			await client.prepareUpdate({
				version: "1.2.1",
				url: "/api/releases/1.2.1/file",
				sha256: "a".repeat(64),
			});

			expect(fetchImpl).toHaveBeenCalledWith(
				"http://127.0.0.1:43123/prepare",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"x-launcher-token": "secret-token",
					}),
					body: expect.stringContaining('"version":"1.2.1"'),
				}),
			);
		});

		it("非 2xx 抛错并携带响应摘要", async () => {
			fetchImpl.mockResolvedValue(errResponse(500, "解压失败"));

			await expect(
				client.prepareUpdate({
					version: "1.2.1",
					url: "/x",
					sha256: "a".repeat(64),
				}),
			).rejects.toThrow("解压失败");
		});

		it("control.json 缺失时抛错", async () => {
			const missing = new LauncherHttpClient({
				controlFile: join(dir, "none.json"),
				fetchImpl,
			});

			await expect(
				missing.prepareUpdate({
					version: "1.2.1",
					url: "/x",
					sha256: "a".repeat(64),
				}),
			).rejects.toThrow();
			expect(fetchImpl).not.toHaveBeenCalled();
		});
	});

	describe("applyUpdate", () => {
		it("POST /apply 且 2xx 视为成功", async () => {
			fetchImpl.mockResolvedValue(okResponse());

			await expect(client.applyUpdate()).resolves.toBeUndefined();
			expect(fetchImpl).toHaveBeenCalledWith(
				"http://127.0.0.1:43123/apply",
				expect.objectContaining({ method: "POST" }),
			);
		});

		it("连接被 launcher 掐断（进程被停）视为成功", async () => {
			fetchImpl.mockRejectedValue(new TypeError("fetch failed"));

			await expect(client.applyUpdate()).resolves.toBeUndefined();
		});

		it("非 2xx 响应抛错", async () => {
			fetchImpl.mockResolvedValue(errResponse(500, "切换失败"));

			await expect(client.applyUpdate()).rejects.toThrow("切换失败");
		});
	});
});
