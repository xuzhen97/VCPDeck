import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureNodeRuntime,
	normalizeNodeCacheLayout,
	parseNodeVersion,
	satisfiesConstraint,
} from "./ensure-node.js";

describe("satisfiesConstraint", () => {
	it(">=24 语义：只比较主版本", () => {
		expect(satisfiesConstraint("24.0.0", ">=24")).toBe(true);
		expect(satisfiesConstraint("v25.1.0", ">=24")).toBe(true);
		expect(satisfiesConstraint("23.9.9", ">=24")).toBe(false);
		expect(satisfiesConstraint("22.19.0", ">=24")).toBe(false);
	});

	it("非法版本/约束返回 false", () => {
		expect(satisfiesConstraint("abc", ">=24")).toBe(false);
		expect(satisfiesConstraint("24.0.0", "bogus")).toBe(false);
	});
});

describe("parseNodeVersion", () => {
	it("解析 node -v 输出", () => {
		expect(parseNodeVersion("v24.5.0")).toBe("24.5.0");
		expect(parseNodeVersion("v24.5.0\n")).toBe("24.5.0");
		expect(parseNodeVersion("not found")).toBeNull();
	});
});

describe("ensureNodeRuntime", () => {
	let dir: string;
	let cacheDir: string;
	let execNodeVersion: ReturnType<typeof vi.fn>;
	let fetchIndex: ReturnType<typeof vi.fn>;
	let downloadAndExtract: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ensure-node-"));
		cacheDir = join(dir, "node");
		execNodeVersion = vi.fn();
		fetchIndex = vi.fn();
		downloadAndExtract = vi.fn();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function run(constraint = ">=24") {
		return ensureNodeRuntime({
			constraint,
			cacheDir,
			execNodeVersion,
			fetchIndex,
			downloadAndExtract,
			platform: "linux",
			arch: "x64",
		});
	}

	it("系统 node 满足约束 → 直接用系统 node，不下载", async () => {
		execNodeVersion.mockResolvedValue("v24.5.0");

		await expect(run()).resolves.toBe("node");
		expect(fetchIndex).not.toHaveBeenCalled();
	});

	it("系统 node 版本过低 → 缓存中有满足版本 → 返回缓存路径", async () => {
		execNodeVersion.mockResolvedValue("v22.19.0");
		await mkdir(join(cacheDir, "node-24.5.0", "bin"), { recursive: true });
		await writeFile(join(cacheDir, "node-24.5.0", "bin", "node"), "x");

		const path = await run();

		expect(path).toContain("node-24.5.0");
		expect(fetchIndex).not.toHaveBeenCalled();
	});

	it("无可用系统 node → 下载 index 中满足约束的最高版本", async () => {
		execNodeVersion.mockResolvedValue(null);
		fetchIndex.mockResolvedValue([
			{ version: "v24.5.0" },
			{ version: "v25.0.0" },
			{ version: "v23.9.0" },
		]);
		downloadAndExtract.mockResolvedValue(
			join(cacheDir, "node-25.0.0", "bin", "node"),
		);

		const path = await run();

		expect(path).toContain("node-25.0.0");
		expect(downloadAndExtract).toHaveBeenCalledWith(
			"25.0.0",
			expect.stringContaining(cacheDir),
			expect.objectContaining({ platform: "linux", arch: "x64" }),
		);
	});

	it("缓存多个版本时选满足约束的最高版本", async () => {
		execNodeVersion.mockResolvedValue(null);
		await mkdir(join(cacheDir, "node-24.1.0", "bin"), { recursive: true });
		await mkdir(join(cacheDir, "node-25.3.0", "bin"), { recursive: true });
		await writeFile(join(cacheDir, "node-25.3.0", "bin", "node"), "x");

		const path = await run();

		expect(path).toContain("node-25.3.0");
	});

	it("缓存条目二进制缺失（损坏半成品）→ 跳过并回退下载", async () => {
		execNodeVersion.mockResolvedValue(null);
		// node-25.3.0 目录存在但二进制缺失（历史 bug 留下的半成品）
		await mkdir(join(cacheDir, "node-25.3.0", "bin"), { recursive: true });
		fetchIndex.mockResolvedValue([{ version: "v24.5.0" }]);
		downloadAndExtract.mockResolvedValue(
			join(cacheDir, "node-24.5.0", "bin", "node"),
		);

		const path = await run();

		expect(path).toContain("node-24.5.0");
		expect(fetchIndex).toHaveBeenCalled();
	});

	it("index 中无满足版本 → 抛错", async () => {
		execNodeVersion.mockResolvedValue(null);
		fetchIndex.mockResolvedValue([{ version: "v22.0.0" }]);

		await expect(run()).rejects.toThrow("无满足");
		expect(downloadAndExtract).not.toHaveBeenCalled();
	});
});

describe("normalizeNodeCacheLayout", () => {
	let dir: string;
	let cacheDir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ensure-node-layout-"));
		cacheDir = join(dir, "node");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("Windows zip：顶层目录归一化为 node-<version> 并返回二进制路径", async () => {
		await mkdir(join(cacheDir, "node-v26.7.0-win-x64"), { recursive: true });
		await writeFile(join(cacheDir, "node-v26.7.0-win-x64", "node.exe"), "x");

		const path = normalizeNodeCacheLayout("26.7.0", cacheDir, "win32", "x64");

		expect(path).toBe(join(cacheDir, "node-26.7.0", "node.exe"));
	});

	it("Linux tar.gz：顶层目录归一化后返回 bin/node 路径", async () => {
		await mkdir(join(cacheDir, "node-v24.5.0-linux-x64", "bin"), {
			recursive: true,
		});
		await writeFile(join(cacheDir, "node-v24.5.0-linux-x64", "bin", "node"), "x");

		const path = normalizeNodeCacheLayout("24.5.0", cacheDir, "linux", "x64");

		expect(path).toBe(join(cacheDir, "node-24.5.0", "bin", "node"));
	});

	it("标准布局已存在时直接复用，不要求解压目录存在", () => {
		// 模拟重复调用：目标布局已归一化完成
		return mkdir(join(cacheDir, "node-26.7.0"), { recursive: true })
			.then(() => writeFile(join(cacheDir, "node-26.7.0", "node.exe"), "x"))
			.then(() => {
				const path = normalizeNodeCacheLayout("26.7.0", cacheDir, "win32", "x64");
				expect(path).toBe(join(cacheDir, "node-26.7.0", "node.exe"));
			});
	});

	it("解压结果与目标布局均缺失二进制 → 抛错", async () => {
		await mkdir(cacheDir, { recursive: true });

		expect(() =>
			normalizeNodeCacheLayout("26.7.0", cacheDir, "win32", "x64"),
		).toThrow("未找到 Node 可执行文件");
	});
});
