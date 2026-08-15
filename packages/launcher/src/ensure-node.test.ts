import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureNodeRuntime,
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

	it("index 中无满足版本 → 抛错", async () => {
		execNodeVersion.mockResolvedValue(null);
		fetchIndex.mockResolvedValue([{ version: "v22.0.0" }]);

		await expect(run()).rejects.toThrow("无满足");
		expect(downloadAndExtract).not.toHaveBeenCalled();
	});
});
