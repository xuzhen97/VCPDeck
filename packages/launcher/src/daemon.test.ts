import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Daemon, type VersionRetentionLike } from "./daemon.js";
import { downloadWithRetry } from "./daemon.js";

const tempDirs: string[] = [];

async function tempZipPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "launcher-download-"));
	tempDirs.push(dir);
	return join(dir, "x.zip");
}

describe("Daemon 版本保留生命周期", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeRetention(): VersionRetentionLike & {
		initialize: ReturnType<typeof vi.fn>;
		recordSuccessful: ReturnType<typeof vi.fn>;
		cleanup: ReturnType<typeof vi.fn>;
	} {
		return {
			initialize: vi.fn().mockResolvedValue(undefined),
			recordSuccessful: vi.fn().mockResolvedValue(true),
			cleanup: vi.fn().mockResolvedValue({
				removed: [],
				failed: [],
				disabled: false,
			}),
		};
	}

	function internals(daemon: Daemon): {
		initializeRetention(): Promise<void>;
		scheduleRetentionStartupCleanup(): void;
		cancelRetentionStartupCleanup(): void;
		onSuccessfulApply(version: string, previous: string | null): Promise<void>;
		pendingVersion: string | null;
	} {
		return daemon as unknown as {
			initializeRetention(): Promise<void>;
			scheduleRetentionStartupCleanup(): void;
			cancelRetentionStartupCleanup(): void;
			onSuccessfulApply(version: string, previous: string | null): Promise<void>;
			pendingVersion: string | null;
		};
	}

	it("启动 current 后初始化，并在稳定延时后执行补扫", async () => {
		vi.useFakeTimers();
		const retention = makeRetention();
		const daemon = new Daemon({
			appDir: "/tmp/vcpdeck-launcher-test",
			artifact: "client",
			retention,
		});
		const methods = internals(daemon);

		await methods.initializeRetention();
		methods.scheduleRetentionStartupCleanup();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(retention.cleanup).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(retention.cleanup).toHaveBeenCalledOnce();
		expect(retention.cleanup).toHaveBeenCalledWith(undefined);
	});

	it("启动补扫执行时保护尚未 apply 的 pending target", async () => {
		vi.useFakeTimers();
		const retention = makeRetention();
		const daemon = new Daemon({
			appDir: "/tmp/vcpdeck-launcher-test",
			artifact: "client",
			retention,
		});
		const methods = internals(daemon);
		methods.pendingVersion = "1.3.0";

		methods.scheduleRetentionStartupCleanup();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(retention.cleanup).toHaveBeenCalledWith(new Set(["1.3.0"]));
	});

	it("成功 apply 记录 target，并保护 target 与 previous", async () => {
		const retention = makeRetention();
		const daemon = new Daemon({
			appDir: "/tmp/vcpdeck-launcher-test",
			artifact: "client",
			retention,
		});

		await internals(daemon).onSuccessfulApply("1.3.0", "1.2.0");

		expect(retention.recordSuccessful).toHaveBeenCalledWith("1.3.0");
		expect(retention.cleanup).toHaveBeenCalledWith(new Set(["1.3.0", "1.2.0"]));
	});

	it("shutdown 前取消尚未执行的启动补扫", async () => {
		vi.useFakeTimers();
		const retention = makeRetention();
		const daemon = new Daemon({
			appDir: "/tmp/vcpdeck-launcher-test",
			artifact: "client",
			retention,
		});
		const methods = internals(daemon);

		methods.scheduleRetentionStartupCleanup();
		methods.cancelRetentionStartupCleanup();
		await vi.advanceTimersByTimeAsync(30_000);

		expect(retention.cleanup).not.toHaveBeenCalled();
	});
});

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
