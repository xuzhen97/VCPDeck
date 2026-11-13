import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientLauncher } from "./launcher-control.js";

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

describe("ClientLauncher", () => {
	let dir: string;
	let controlFile: string;
	let fetchImpl: ReturnType<typeof vi.fn>;
	let launcher: ClientLauncher;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "client-launcher-"));
		controlFile = join(dir, "control.json");
		await writeFile(
			controlFile,
			JSON.stringify({ port: 43124, token: "client-token" }),
		);
		fetchImpl = vi.fn();
		launcher = new ClientLauncher({ controlFile, fetchImpl });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("prepareUpdate 读 control.json 并 POST /prepare（带 token）", async () => {
		fetchImpl.mockResolvedValue(okResponse());

		await launcher.prepareUpdate({
			version: "1.2.1",
			url: "http://server/api/releases/1.2.1/file",
			sha256: "a".repeat(64),
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:43124/prepare",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"x-launcher-token": "client-token",
				}),
				body: expect.stringContaining('"version":"1.2.1"'),
			}),
		);
	});

	it("prepare 非 2xx 抛错并携带响应摘要", async () => {
		fetchImpl.mockResolvedValue(errResponse(500, "校验失败"));

		await expect(
			launcher.prepareUpdate({
				version: "1.2.1",
				url: "http://x",
				sha256: "a".repeat(64),
			}),
		).rejects.toThrow("校验失败");
	});

	it("control.json 缺失时抛错", async () => {
		const missing = new ClientLauncher({
			controlFile: join(dir, "none.json"),
			fetchImpl,
		});

		await expect(
			missing.prepareUpdate({
				version: "1.2.1",
				url: "http://x",
				sha256: "a".repeat(64),
			}),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("applyUpdate：2xx 成功", async () => {
		fetchImpl.mockResolvedValue(okResponse());

		await expect(launcher.applyUpdate()).resolves.toBeUndefined();
	});

	it("applyUpdate：连接被 launcher 掐断（进程被停）视为成功", async () => {
		fetchImpl.mockRejectedValue(new TypeError("fetch failed"));

		await expect(launcher.applyUpdate()).resolves.toBeUndefined();
	});

	it("applyUpdate：普通 fetch failed 错误也视为 launcher 已接管", async () => {
		fetchImpl.mockRejectedValue({ message: "fetch failed" });

		await expect(launcher.applyUpdate()).resolves.toBeUndefined();
	});

	it("applyUpdate：非 2xx 抛错", async () => {
		fetchImpl.mockResolvedValue(errResponse(500, "切换失败"));

		await expect(launcher.applyUpdate()).rejects.toThrow("切换失败");
	});

	it("waitForPrepared：preparing 轮询到 ready 才返回", async () => {
		fetchImpl
			.mockResolvedValueOnce(
				jsonResponse({ state: "preparing", version: "1.2.1" }),
			)
			.mockResolvedValueOnce(jsonResponse({ state: "ready", version: "1.2.1" }));

		await expect(
			launcher.waitForPrepared({ intervalMs: 1, timeoutMs: 1000 }),
		).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl).toHaveBeenLastCalledWith(
			"http://127.0.0.1:43124/prepare/status",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("waitForPrepared：准备失败立即抛错并带稳定错误码", async () => {
		fetchImpl.mockResolvedValue(
			jsonResponse({
				state: "failed",
				version: "1.2.1",
				errorCode: "MANIFEST_SIGNATURE_INVALID",
			}),
		);

		await expect(
			launcher.waitForPrepared({ intervalMs: 1, timeoutMs: 1000 }),
		).rejects.toThrow("launcher 准备失败: MANIFEST_SIGNATURE_INVALID");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("waitForPrepared：超过期限抛超时错误", async () => {
		fetchImpl.mockResolvedValue(
			jsonResponse({ state: "preparing", version: "1.2.1" }),
		);

		await expect(
			launcher.waitForPrepared({ intervalMs: 1, timeoutMs: 5 }),
		).rejects.toThrow("launcher 准备超时");
	});

	it("waitForPrepared：未知 state 视为协议错误", async () => {
		fetchImpl.mockResolvedValue(jsonResponse({ state: "weird", version: null }));

		await expect(launcher.waitForPrepared({ intervalMs: 1 })).rejects.toThrow(
			"状态未知: weird",
		);
	});
});
