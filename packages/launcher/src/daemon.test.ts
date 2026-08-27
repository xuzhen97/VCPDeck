import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWithRetry } from "./daemon.js";

const tempDirs: string[] = [];

async function tempZipPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "launcher-download-"));
	tempDirs.push(dir);
	return join(dir, "x.zip");
}

describe("downloadWithRetry", () => {
	afterEach(async () => {
		await Promise.all(
			tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	it("下载收到 502 后重新请求更新入口并成功", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
			.mockResolvedValueOnce(new Response("zip", { status: 200 }));
		const dest = await tempZipPath();

		await downloadWithRetry(
			"http://server/api/releases/1.2.1/file",
			dest,
			fetchImpl,
			async () => {},
		);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(await readFile(dest, "utf8")).toBe("zip");
	});

	it("下载网络异常后重试并成功", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(new Response("zip", { status: 200 }));
		const dest = await tempZipPath();

		await downloadWithRetry(
			"http://server/api/releases/1.2.1/file",
			dest,
			fetchImpl,
			async () => {},
		);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(await readFile(dest, "utf8")).toBe("zip");
	});

	it("下载收到 404 不重试", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("missing", { status: 404 }));
		const dest = await tempZipPath();

		await expect(
			downloadWithRetry(
				"http://server/api/releases/1.2.1/file",
				dest,
				fetchImpl,
				async () => {},
			),
		).rejects.toThrow("HTTP 404");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("连续网络异常达到三次上限后失败", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		const dest = await tempZipPath();

		await expect(
			downloadWithRetry(
				"http://server/api/releases/1.2.1/file",
				dest,
				fetchImpl,
				async () => {},
			),
		).rejects.toThrow("下载失败: 网络错误");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("成功响应写盘失败时不重试", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("zip", { status: 200 }));
		const dir = await mkdtemp(join(tmpdir(), "launcher-download-"));
		tempDirs.push(dir);
		const dest = join(dir, "missing", "x.zip");

		await expect(
			downloadWithRetry(
				"http://server/api/releases/1.2.1/file",
				dest,
				fetchImpl,
				async () => {},
			),
		).rejects.toThrow();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
