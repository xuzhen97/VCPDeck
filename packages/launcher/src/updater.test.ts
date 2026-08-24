import { afterEach, describe, expect, it, vi } from "vitest";
import { Updater, type UpdaterDeps } from "./updater.js";

type MockFn = ReturnType<typeof vi.fn>;

interface MockedDeps {
	versions: {
		exists: MockFn;
		currentVersion: MockFn;
		switchTo: MockFn;
		versionDir: MockFn;
	};
	downloadZip: MockFn;
	verifySha256: MockFn;
	extractZip: MockFn;
	stopProcess: MockFn;
	startProcess: MockFn;
	probe: MockFn;
	probeRetries: number;
	probeIntervalMs: number;
}

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
	return {
		versions: {
			exists: vi.fn().mockReturnValue(false),
			currentVersion: vi.fn(),
			switchTo: vi.fn(),
			versionDir: vi.fn((v: string) => `/apps/${v}`),
		},
		downloadZip: vi.fn(),
		verifySha256: vi.fn(),
		extractZip: vi.fn(),
		stopProcess: vi.fn(),
		startProcess: vi.fn(),
		probe: vi.fn(),
		probeRetries: 3,
		probeIntervalMs: 100,
		...overrides,
	};
}

describe("Updater", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("prepare", () => {
		it("下载 → 校验 → 解压 按序执行", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://server/api/releases/1.2.1/file",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});

			expect(deps.downloadZip).toHaveBeenCalledWith(
				"http://server/api/releases/1.2.1/file",
				expect.stringContaining("1.2.1"),
			);
			expect(deps.extractZip).toHaveBeenCalledWith(
				expect.any(String),
				"/apps/1.2.1",
			);
			// 顺序：下载先于校验，校验先于解压
			const order = [
				deps.downloadZip.mock.invocationCallOrder[0],
				deps.verifySha256.mock.invocationCallOrder[0],
				deps.extractZip.mock.invocationCallOrder[0],
			];
			expect(order).toEqual([...order].sort((a, b) => a - b));
		});

		it("版本目录已存在 → 幂等跳过", async () => {
			const deps = makeDeps();
			deps.versions.exists.mockReturnValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://x",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});

			expect(deps.downloadZip).not.toHaveBeenCalled();
		});

		it("sha256 不匹配 → 抛错且不解压", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(false);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await expect(
				updater.prepare({
					url: "http://x",
					sha256: "a".repeat(64),
					version: "1.2.1",
				}),
			).rejects.toThrow("sha256");

			expect(deps.extractZip).not.toHaveBeenCalled();
		});
	});

	describe("prepare 阶段计时日志", () => {
		it("成功路径输出 下载/校验/解压/总耗时 各阶段日志", async () => {
			const logs: string[] = [];
			const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
				logs.push(a.join(" "));
			});
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://x",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});
			spy.mockRestore();

			const text = logs.join("\n");
			expect(text).toContain("prepare 1.2.1");
			expect(text).toContain("下载");
			expect(text).toContain("校验");
			expect(text).toContain("解压");
			expect(text).toContain("总耗时");
		});

		it("幂等跳过时不产生阶段日志", async () => {
			const logs: string[] = [];
			const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
				logs.push(a.join(" "));
			});
			const deps = makeDeps();
			deps.versions.exists.mockReturnValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({ url: "http://x", sha256: "a".repeat(64), version: "1.2.1" });
			spy.mockRestore();

			expect(logs.join("\n")).not.toContain("下载");
		});
	});

	describe("apply", () => {
		it("成功路径：停旧 → 切换 → 启动 → 探活通过", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.apply("1.2.1");

			expect(deps.stopProcess).toHaveBeenCalledTimes(1);
			expect(deps.versions.switchTo).toHaveBeenCalledWith("1.2.1");
			expect(deps.startProcess).toHaveBeenCalledTimes(1);
		});

		it("探活失败 → 回退旧版本并重启", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(false);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await expect(updater.apply("1.2.1")).rejects.toThrow("已回退");

			expect(deps.versions.switchTo).toHaveBeenNthCalledWith(1, "1.2.1");
			expect(deps.versions.switchTo).toHaveBeenNthCalledWith(2, "1.1.0");
			expect(deps.startProcess).toHaveBeenCalledTimes(2);
		});

		it("无旧版本（首装）→ 不回退", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue(null);
			deps.probe.mockResolvedValue(false);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await expect(updater.apply("1.2.1")).rejects.toThrow("健康检查失败");

			expect(deps.versions.switchTo).toHaveBeenCalledTimes(1);
		});

		it("探活重试：前两次失败第三次成功 → 视为健康", async () => {
			vi.useFakeTimers();
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(false)
				.mockResolvedValueOnce(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			const phase = updater.apply("1.2.1");
			await vi.advanceTimersByTimeAsync(300);
			await expect(phase).resolves.toBeUndefined();

			expect(deps.probe).toHaveBeenCalledTimes(3);
		});
	});
});
