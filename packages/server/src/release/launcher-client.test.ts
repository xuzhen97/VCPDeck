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

function jsonResponse(body: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
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
			// POST 不重试：/apply 若已生效，重发会重复执行切换
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it("普通 fetch failed 错误也视为 launcher 已接管", async () => {
			fetchImpl.mockRejectedValue({ message: "fetch failed" });

			await expect(client.applyUpdate()).resolves.toBeUndefined();
		});

		it("非 2xx 响应抛错", async () => {
			fetchImpl.mockResolvedValue(errResponse(500, "切换失败"));

			await expect(client.applyUpdate()).rejects.toThrow("切换失败");
		});
	});

	describe("waitForPrepared", () => {
		it("idle/preparing 轮询到 ready 才返回", async () => {
			fetchImpl
				.mockResolvedValueOnce(jsonResponse({ state: "idle", version: null }))
				.mockResolvedValueOnce(
					jsonResponse({ state: "preparing", version: "1.2.1" }),
				)
				.mockResolvedValueOnce(
					jsonResponse({ state: "ready", version: "1.2.1" }),
				);

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 1000 }),
			).resolves.toBeUndefined();
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(fetchImpl).toHaveBeenLastCalledWith(
				"http://127.0.0.1:43123/prepare/status",
				expect.objectContaining({ method: "GET" }),
			);
		});

		it("准备失败立即抛错并带稳定错误码", async () => {
			fetchImpl.mockResolvedValue(
				jsonResponse({
					state: "failed",
					version: "1.2.1",
					errorCode: "ASSEMBLE_FAILED",
				}),
			);

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 1000 }),
			).rejects.toThrow("launcher 准备失败: ASSEMBLE_FAILED");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});

		it("超过期限抛超时错误", async () => {
			fetchImpl.mockResolvedValue(
				jsonResponse({ state: "preparing", version: "1.2.1" }),
			);

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 5 }),
			).rejects.toThrow("launcher 准备超时");
		});

		it("单次 GET 网络层失败会先重试再成功", async () => {
			fetchImpl
				.mockRejectedValueOnce(new TypeError("fetch failed"))
				.mockResolvedValueOnce(
					jsonResponse({ state: "ready", version: "1.2.1" }),
				);

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 1000 }),
			).resolves.toBeUndefined();
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		});

		it("控制通道暂时连不上时继续轮询，不就地终止发布", async () => {
			// 一次轮询用尽重试次数后仍然连不上，下一轮恢复
			fetchImpl
				.mockRejectedValueOnce(new TypeError("fetch failed"))
				.mockRejectedValueOnce(new TypeError("fetch failed"))
				.mockRejectedValueOnce(new TypeError("fetch failed"))
				.mockResolvedValueOnce(
					jsonResponse({ state: "ready", version: "1.2.1" }),
				);

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 2000 }),
			).resolves.toBeUndefined();
			expect(fetchImpl).toHaveBeenCalledTimes(4);
		});

		it("launcher 明确返回 HTTP 错误时立即失败，不当作连不上继续等", async () => {
			fetchImpl.mockResolvedValue(errResponse(500, "内部错误"));

			await expect(
				client.waitForPrepared({ intervalMs: 1, timeoutMs: 5000 }),
			).rejects.toThrow("launcher /prepare/status 失败: HTTP 500");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});

	describe("网络层错误文案", () => {
		it("把 cause 链里的 errno 带进消息，POST 不重试", async () => {
			fetchImpl.mockRejectedValue(
				Object.assign(new TypeError("fetch failed"), {
					cause: {
						code: "ECONNREFUSED",
						message: "connect ECONNREFUSED 127.0.0.1:43123",
					},
				}),
			);

			await expect(
				client.prepareUpdate({
					version: "1.2.1",
					url: "/x",
					sha256: "a".repeat(64),
				}),
			).rejects.toThrow("launcher /prepare 连不上: fetch failed / ECONNREFUSED");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});
});
