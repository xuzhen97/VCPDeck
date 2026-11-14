import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canonicalReleaseManifestJson,
	ReleaseArtifactErrorCode,
} from "@vcpdeck/shared";
import { Updater, type UpdaterDeps } from "./updater.js";

type MockFn = ReturnType<typeof vi.fn>;

interface MockedDeps {
	root: string;
	versions: {
		exists: MockFn;
		isPrepared: MockFn;
		removeVersion: MockFn;
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
	onSuccessfulApply: MockFn;
	artifact: "server" | "client";
	probeRetries: number;
	probeIntervalMs: number;
	acceptsDelta: boolean;
	validatePreparedTarget: MockFn;
}

const ENV_KEY = "VCPDECK_RELEASE_PUBLIC_KEY_PEM";
const originalEnv = process.env[ENV_KEY];
const tempRoots: string[] = [];

function freshRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "vcpdeck-updater-"));
	tempRoots.push(root);
	return root;
}

/** 构造清单文件条目的哈希、大小与权限位。 */
function fileEntry(rel: string, content: string) {
	return {
		path: rel,
		sha256: createHash("sha256").update(content).digest("hex"),
		size: Buffer.byteLength(content),
		mode: 0o644,
	};
}

/** 旧格式六键清单（无 files[]、无签名）。 */
function legacyManifest(version: string) {
	return {
		version,
		nodeVersion: ">=24",
		launcherMinVersion: "0.0.0",
		sha256: "",
		artifacts: {
			server: { dir: "server", entry: "dist/main.js" },
			client: { dir: "client", entry: "dist/index.js" },
		},
	};
}

/** 写入旧格式包：验证迁移期直通路径。 */
function writeLegacyPackage(dir: string, version: string): void {
	mkdirSync(join(dir, "server", "dist"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify(legacyManifest(version)),
	);
	writeFileSync(join(dir, "server", "dist", "main.js"), "module.exports = 1;\n");
}

/** 写入带 .sig 的新格式 full 包。 */
function writeSignedFullPackage(
	dir: string,
	manifest: Record<string, unknown>,
	contents: Record<string, string>,
	signature: string,
): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(dir, "manifest.json.sig"), signature);
	for (const [rel, content] of Object.entries(contents)) {
		const p = join(dir, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
}

/** 测试用 Ed25519 密钥对，验签公钥通过环境变量注入。 */
function signingKey() {
	const kp = generateKeyPairSync("ed25519");
	return {
		publicPem: kp.publicKey.export({ type: "spki", format: "pem" }) as string,
		signManifest(manifest: Record<string, unknown>): string {
			return sign(
				null,
				Buffer.from(canonicalReleaseManifestJson(manifest), "utf8"),
				kp.privateKey,
			).toString("base64");
		},
	};
}

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
	const root = freshRoot();
	return {
		root,
		versions: {
			exists: vi.fn().mockReturnValue(false),
			isPrepared: vi.fn().mockResolvedValue(false),
			removeVersion: vi.fn(),
			currentVersion: vi.fn(),
			switchTo: vi.fn(),
			versionDir: vi.fn((v: string) => join(root, "apps", v)),
		},
		downloadZip: vi.fn(),
		verifySha256: vi.fn(),
		extractZip: vi.fn(async (_zip: string, destDir: string) => {
			writeLegacyPackage(destDir, "1.2.1");
		}),
		stopProcess: vi.fn(),
		startProcess: vi.fn(),
		probe: vi.fn(),
		onSuccessfulApply: vi.fn(async () => undefined),
		artifact: "server",
		probeRetries: 3,
		probeIntervalMs: 100,
		acceptsDelta: true,
		validatePreparedTarget: vi.fn(async () => undefined),
		...overrides,
	};
}

afterEach(() => {
	vi.useRealTimers();
	for (const r of tempRoots.splice(0)) {
		rmSync(r, { recursive: true, force: true });
	}
	if (originalEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = originalEnv;
});

describe("Updater", () => {
	describe("prepare", () => {
		it("下载 → 校验 → 解压 按序执行，旧格式包写入版本目录", async () => {
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
				expect.any(String),
			);
			expect(
				existsSync(
					join(deps.versions.versionDir("1.2.1"), "manifest.json"),
				),
			).toBe(true);
			// 顺序：下载先于校验，校验先于解压
			const order = [
				deps.downloadZip.mock.invocationCallOrder[0],
				deps.verifySha256.mock.invocationCallOrder[0],
				deps.extractZip.mock.invocationCallOrder[0],
			];
			expect(order).toEqual([...order].sort((a, b) => a - b));
		});

		it("只有 Launcher payload 的版本目录不得幂等跳过", async () => {
			const deps = makeDeps();
			deps.versions.isPrepared.mockResolvedValue(false);
			deps.verifySha256.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://server/release.zip",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});

			expect(deps.versions.removeVersion).toHaveBeenCalledWith("1.2.1");
			expect(deps.downloadZip).toHaveBeenCalled();
			expect(deps.extractZip).toHaveBeenCalled();
		});

		it("完整 Server 版本目录幂等跳过", async () => {
			const deps = makeDeps({ artifact: "server" });
			deps.versions.isPrepared.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://server/release.zip",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});

			expect(deps.downloadZip).not.toHaveBeenCalled();
			expect(deps.versions.removeVersion).not.toHaveBeenCalled();
		});

		it("完整 Client 版本目录幂等跳过", async () => {
			const deps = makeDeps({ artifact: "client" });
			deps.versions.isPrepared.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://server/release.zip",
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

		it("候选基线可用 → 用候选 url/sha256 下载 delta 包，硬链接共享基线文件", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const baselineDir = join(deps.root, "apps", "0.9.0");
			mkdirSync(join(baselineDir, "server", "dist"), { recursive: true });
			writeFileSync(
				join(baselineDir, "manifest.json"),
				JSON.stringify(legacyManifest("0.9.0")),
			);
			writeFileSync(
				join(baselineDir, "server", "dist", "shared.js"),
				"shared\n",
			);

			const key = signingKey();
			process.env[ENV_KEY] = key.publicPem;
			const changed = "changed\n";
			const files = [
				fileEntry("server/dist/changed.js", changed),
				fileEntry("server/dist/shared.js", "shared\n"),
			];
			const deltaManifest = {
				version: "1.2.1",
				protocolVersion: 2,
				kind: "delta",
				fromVersion: "0.9.0",
				files,
			};
			const sig = key.signManifest(deltaManifest);
			deps.extractZip.mockImplementation(
				async (_zip: string, dir: string) => {
					mkdirSync(join(dir, "server", "dist"), { recursive: true });
					writeFileSync(
						join(dir, "delta.json"),
						JSON.stringify(deltaManifest),
					);
					writeFileSync(join(dir, "delta.json.sig"), sig);
					writeFileSync(join(dir, "server", "dist", "changed.js"), changed);
					// shared.js 不在包内，应由基线硬链接补齐
				},
			);

			const updater = new Updater(deps as unknown as UpdaterDeps);
			await updater.prepare({
				version: "1.2.1",
				url: "http://server/full.zip",
				sha256: "a".repeat(64),
				candidates: [
					{
						fromVersion: "0.9.0",
						url: "http://server/delta.zip",
						sha256: "b".repeat(64),
						size: 123,
					},
				],
			});

			expect(deps.downloadZip).toHaveBeenCalledWith(
				"http://server/delta.zip",
				expect.any(String),
			);
			expect(deps.verifySha256).toHaveBeenCalledWith(
				expect.any(String),
				"b".repeat(64),
			);
			const target = join(deps.root, "apps", "1.2.1");
			expect(
				readFileSync(join(target, "server", "dist", "shared.js"), "utf8"),
			).toBe("shared\n");
			const targetManifest = JSON.parse(
				readFileSync(join(target, "manifest.json"), "utf8"),
			) as { version: string; kind?: string; files?: unknown[] };
			expect(targetManifest.version).toBe("1.2.1");
			// 目标清单记录新版本的完整文件清单，而不是基线版本的旧清单。
			expect(targetManifest.files).toEqual(files);
		});

		it("候选基线不存在 → 忽略候选，用原 url 下载 full 包", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				version: "1.2.1",
				url: "http://server/full.zip",
				sha256: "a".repeat(64),
				candidates: [
					{
						fromVersion: "0.9.0",
						url: "http://server/delta.zip",
						sha256: "b".repeat(64),
						size: 1,
					},
				],
			});

			expect(deps.downloadZip).toHaveBeenCalledWith(
				"http://server/full.zip",
				expect.any(String),
			);
			expect(deps.verifySha256).toHaveBeenCalledWith(
				expect.any(String),
				"a".repeat(64),
			);
		});

		it("签名无效 → 抛 MANIFEST_SIGNATURE_INVALID 且不写入版本目录", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const key = signingKey();
			process.env[ENV_KEY] = key.publicPem;
			const content = "app\n";
			const files = [fileEntry("server/dist/main.js", content)];
			const manifest = {
				...legacyManifest("1.2.1"),
				protocolVersion: 2,
				files,
			};
			deps.extractZip.mockImplementation(
				async (_zip: string, dir: string) => {
					writeSignedFullPackage(
						dir,
						manifest,
						{ "server/dist/main.js": content },
						Buffer.from("不是签名").toString("base64"),
					);
				},
			);

			const updater = new Updater(deps as unknown as UpdaterDeps);
			await expect(
				updater.prepare({
					version: "1.2.1",
					url: "http://server/full.zip",
					sha256: "a".repeat(64),
				}),
			).rejects.toMatchObject({
				code: ReleaseArtifactErrorCode.MANIFEST_SIGNATURE_INVALID,
			});
			expect(
				existsSync(join(deps.root, "apps", "1.2.1", "manifest.json")),
			).toBe(false);
		});

		it("delta 组装失败 → 恰好降级 full 一次，full 再失败则抛错", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const baselineDir = join(deps.root, "apps", "0.9.0");
			mkdirSync(baselineDir, { recursive: true });
			writeFileSync(
				join(baselineDir, "manifest.json"),
				JSON.stringify(legacyManifest("0.9.0")),
			);
			const key = signingKey();
			process.env[ENV_KEY] = key.publicPem;
			const missing = fileEntry("server/dist/missing.js", "x\n");
			const deltaManifest = {
				version: "1.2.1",
				protocolVersion: 2,
				kind: "delta",
				fromVersion: "0.9.0",
				files: [missing],
			};
			const deltaSig = key.signManifest(deltaManifest);
			const fullManifest = {
				...legacyManifest("1.2.1"),
				protocolVersion: 2,
				files: [missing],
			};
			const fullSig = key.signManifest(fullManifest);
			let call = 0;
			deps.extractZip.mockImplementation(
				async (_zip: string, dir: string) => {
					call += 1;
					if (call === 1) {
						mkdirSync(dir, { recursive: true });
						writeFileSync(
							join(dir, "delta.json"),
							JSON.stringify(deltaManifest),
						);
						writeFileSync(join(dir, "delta.json.sig"), deltaSig);
					} else {
						writeSignedFullPackage(dir, fullManifest, {}, fullSig);
					}
				},
			);

			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const updater = new Updater(deps as unknown as UpdaterDeps);
			await expect(
				updater.prepare({
					version: "1.2.1",
					url: "http://server/full.zip",
					sha256: "a".repeat(64),
					candidates: [
						{
							fromVersion: "0.9.0",
							url: "http://server/delta.zip",
							sha256: "b".repeat(64),
							size: 1,
						},
					],
				}),
			).rejects.toMatchObject({
				code: ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE,
			});
			expect(deps.downloadZip).toHaveBeenCalledTimes(2);
			expect(deps.downloadZip).toHaveBeenNthCalledWith(
				2,
				"http://server/full.zip",
				expect.any(String),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					`增量组装失败（${ReleaseArtifactErrorCode.DELTA_BASELINE_UNAVAILABLE}）`,
				),
			);
			warn.mockRestore();
		});

		it("并发两次 prepare 使用不同 zipPath", async () => {
			const deps = makeDeps();
			deps.verifySha256.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await Promise.all([
				updater.prepare({
					version: "1.2.1",
					url: "http://a",
					sha256: "a".repeat(64),
				}),
				updater.prepare({
					version: "1.2.1",
					url: "http://b",
					sha256: "a".repeat(64),
				}),
			]);

			const paths = deps.downloadZip.mock.calls.map((c) => c[1] as string);
			expect(paths).toHaveLength(2);
			expect(new Set(paths).size).toBe(2);
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
			deps.versions.isPrepared.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.prepare({
				url: "http://x",
				sha256: "a".repeat(64),
				version: "1.2.1",
			});
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

		it("成功路径调用顺序保持 stop → switchTo → start → probe", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.apply("1.2.1");

			const order = [
				deps.stopProcess.mock.invocationCallOrder[0],
				deps.versions.switchTo.mock.invocationCallOrder[0],
				deps.startProcess.mock.invocationCallOrder[0],
				deps.probe.mock.invocationCallOrder[0],
			];
			expect(order).toEqual([...order].sort((a, b) => a - b));
		});

		it("探活成功后通知成功切换版本和 previous", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(true);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await updater.apply("1.2.1");

			expect(deps.onSuccessfulApply).toHaveBeenCalledOnce();
			expect(deps.onSuccessfulApply).toHaveBeenCalledWith("1.2.1", "1.1.0");
		});

		it("探活失败 → 回退旧版本并重启，且不通知成功切换", async () => {
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(false);
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await expect(updater.apply("1.2.1")).rejects.toThrow("已回退");

			expect(deps.versions.switchTo).toHaveBeenNthCalledWith(1, "1.2.1");
			expect(deps.versions.switchTo).toHaveBeenNthCalledWith(2, "1.1.0");
			expect(deps.startProcess).toHaveBeenCalledTimes(2);
			expect(deps.onSuccessfulApply).not.toHaveBeenCalled();
		});

		it("保留回调失败只警告，不影响已健康切换的结果", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const deps = makeDeps();
			deps.versions.currentVersion.mockResolvedValue("1.1.0");
			deps.probe.mockResolvedValue(true);
			deps.onSuccessfulApply.mockRejectedValue(new Error("retention unavailable"));
			const updater = new Updater(deps as unknown as UpdaterDeps);

			await expect(updater.apply("1.2.1")).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("版本保留记录失败"));
			warn.mockRestore();
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

describe("目标验证钩子与 musl 拒绝 delta（Task 5）", () => {
	it("prepare 快路命中也要重新验证，验证失败不触发下载", async () => {
		const deps = makeDeps();
		deps.versions.isPrepared.mockResolvedValue(true);
		deps.validatePreparedTarget.mockRejectedValue(new Error("平台不匹配"));
		const updater = new Updater(deps as unknown as UpdaterDeps);

		await expect(
			updater.prepare({
				url: "http://server/full.zip",
				sha256: "a".repeat(64),
				version: "1.2.1",
			}),
		).rejects.toThrow("平台不匹配");
		expect(deps.downloadZip).not.toHaveBeenCalled();
	});

	it("prepare 成功收尾时对目标再验证一次", async () => {
		const deps = makeDeps();
		deps.verifySha256.mockResolvedValue(true);
		const updater = new Updater(deps as unknown as UpdaterDeps);

		await updater.prepare({
			url: "http://server/full.zip",
			sha256: "a".repeat(64),
			version: "1.2.1",
		});

		expect(deps.validatePreparedTarget).toHaveBeenCalledWith("1.2.1");
	});

	it("apply 在停旧进程前验证；验证失败时不再停进程、不切换", async () => {
		const deps = makeDeps();
		deps.versions.currentVersion.mockResolvedValue("1.1.0");
		deps.validatePreparedTarget.mockRejectedValue(new Error("runtime 不可执行"));
		const updater = new Updater(deps as unknown as UpdaterDeps);

		await expect(updater.apply("1.2.1")).rejects.toThrow("runtime 不可执行");
		expect(deps.stopProcess).not.toHaveBeenCalled();
		expect(deps.versions.switchTo).not.toHaveBeenCalled();
	});

	it("musl 目标即使给出候选 delta 也只接受同目标全量包", async () => {
		const deps = makeDeps({ acceptsDelta: false });
		const baseline = join(deps.root, "apps", "0.9.0");
		mkdirSync(baseline, { recursive: true });
		writeFileSync(
			join(baseline, "manifest.json"),
			JSON.stringify(legacyManifest("0.9.0")),
		);
		deps.verifySha256.mockResolvedValue(true);
		const updater = new Updater(deps as unknown as UpdaterDeps);

		await updater.prepare({
			url: "http://server/full.zip",
			sha256: "a".repeat(64),
			version: "1.2.1",
			candidates: [
				{
					fromVersion: "0.9.0",
					url: "http://server/delta.zip",
					sha256: "b".repeat(64),
					size: 1,
				},
			],
		});

		expect(deps.downloadZip).toHaveBeenCalledWith(
			"http://server/full.zip",
			expect.any(String),
		);
	});
});
