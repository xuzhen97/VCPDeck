/**
 * Pi 扩展资源选择与 Bundle 构建的行为测试（ADR-0042）。
 *
 * 覆盖三条容易静默失效的契约：
 * 1. 标准社区包只贡献自己声明的 extension 资源，其他资源类型与自动发现不得混入；
 * 2. 资源身份（ID/版本/路径/摘要）在同一输入下确定，且失败不得留下旧 manifest；
 * 3. dev 与 release 共用同一 builder，公共资源逐字节一致。
 *
 * 运行：`pnpm exec tsx --test scripts/pi-resource-bundle.test.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PiBundleManifest } from "../packages/shared/src/pi-bundle.js";
import { PI_EXTENSION_SOURCES } from "./pi-extension-sources.js";
import {
	buildPiResourceBundle,
	resolveLocalPiPackage,
	resolvePiExtensionSources,
} from "./pi-resource-bundle.js";

const ROOT = resolve(__dirname, "..");

/** 极简合法扩展：只注册一个命令，用于验证打包与资源身份。 */
const MINIMAL_EXTENSION = `export default function (pi) {
  pi.registerCommand("probe", { description: "probe", handler: async () => {} });
}
`;

async function makeScratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "vcp-pi-res-"));
}

interface FixturePackageOptions {
	version?: string;
	/** `package.json` 的 `pi` 字段；省略表示走约定目录发现。 */
	pi?: Record<string, unknown>;
	/** 相对路径 → 内容。 */
	files?: Record<string, string>;
}

/** 造一个标准 Pi 包目录；返回其绝对路径。 */
async function makePackage(
	options: FixturePackageOptions = {},
): Promise<string> {
	const root = await makeScratch();
	const pkg: Record<string, unknown> = {
		name: "fixture-pi-package",
		version: options.version ?? "1.0.0",
	};
	if (options.pi) pkg.pi = options.pi;
	await writeFile(join(root, "package.json"), JSON.stringify(pkg, null, 2));
	for (const [relative, content] of Object.entries(options.files ?? {})) {
		const absolute = join(root, relative);
		await mkdir(join(absolute, ".."), { recursive: true });
		await writeFile(absolute, content);
	}
	return root;
}

const cleanups: string[] = [];
async function makeScratchTracked(): Promise<string> {
	const dir = await makeScratch();
	cleanups.push(dir);
	return dir;
}

test.after(async () => {
	for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

test("标准 pi.extensions 只返回 extension 入口，skills 不混入", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { extensions: ["src/index.ts"], skills: ["skills"], prompts: ["p.md"] },
		files: {
			"src/index.ts": MINIMAL_EXTENSION,
			"skills/demo/SKILL.md": "# demo\n",
			"p.md": "prompt\n",
		},
	});

	const entries = await resolveLocalPiPackage(root, "1.0.0", scratch);

	assert.deepEqual(entries, [join(root, "src", "index.ts")]);
});

test("包版本与期望不一致时拒绝，不静默接受", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		version: "1.0.0",
		pi: { extensions: ["src/index.ts"] },
		files: { "src/index.ts": MINIMAL_EXTENSION },
	});

	await assert.rejects(
		() => resolveLocalPiPackage(root, "2.0.0", scratch),
		/版本/,
	);
});

test("没有 pi 清单时按约定 extensions/ 目录发现", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		files: { "extensions/hello.ts": MINIMAL_EXTENSION },
	});

	const entries = await resolveLocalPiPackage(root, "1.0.0", scratch);

	assert.deepEqual(entries, [join(root, "extensions", "hello.ts")]);
});

test("包没有任何 extension 资源时拒绝，不把包根当扩展", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { skills: ["skills"] },
		files: { "skills/demo/SKILL.md": "# demo\n" },
	});

	await assert.rejects(
		() => resolveLocalPiPackage(root, "1.0.0", scratch),
		/未声明任何 extension/,
	);
});

test("同一包声明多个启用入口时拒绝，不任意挑选", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { extensions: ["a.ts", "b.ts"] },
		files: { "a.ts": MINIMAL_EXTENSION, "b.ts": MINIMAL_EXTENSION },
	});

	await assert.rejects(
		() => resolveLocalPiPackage(root, "1.0.0", scratch),
		/多个 extension 入口/,
	);
});

test("入口经相对路径穿越到包外时拒绝", async () => {
	const scratch = await makeScratchTracked();
	const outside = await makeScratchTracked();
	await writeFile(join(outside, "outside.ts"), MINIMAL_EXTENSION);
	const root = await makePackage({
		pi: { extensions: ["../outside.ts"] },
		files: { "keep.txt": "x" },
	});

	await assert.rejects(
		() => resolveLocalPiPackage(root, "1.0.0", scratch),
		/逃出包目录|未声明任何 extension/,
	);
});

test("入口经符号链接逃出包目录时拒绝", async (context) => {
	const scratch = await makeScratchTracked();
	const outside = await makeScratchTracked();
	await writeFile(join(outside, "evil.ts"), MINIMAL_EXTENSION);
	const root = await makePackage({ files: { "keep.txt": "x" } });
	await mkdir(join(root, "extensions"), { recursive: true });
	try {
		await symlink(
			join(outside, "evil.ts"),
			join(root, "extensions", "evil.ts"),
		);
	} catch (error) {
		// Windows 未开启开发者模式时普通用户无法创建符号链接（与 pi-web 渲染层用例同因）。
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			context.skip("当前环境不允许创建符号链接，跳过该平台覆盖");
			return;
		}
		throw error;
	}

	await assert.rejects(
		() => resolveLocalPiPackage(root, "1.0.0", scratch),
		/逃出包目录/,
	);
});

test("默认来源包含自有策略扩展与固定版本的社区包", async () => {
	const scratch = await makeScratchTracked();

	const resolved = await resolvePiExtensionSources(PI_EXTENSION_SOURCES, scratch);

	assert.deepEqual(
		resolved.map((item) => item.id),
		["community.pi-simplify", "vcp.tool-policy"],
	);
	const community = resolved.find(
		(item) => item.id === "community.pi-simplify",
	);
	assert.equal(community?.version, "0.2.3");
	assert.ok(community?.licenseFile && existsSync(community.licenseFile));
	const policy = resolved.find((item) => item.id === "vcp.tool-policy");
	assert.equal(policy?.version, "3");
});

test("重复资源 ID 直接拒绝", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { extensions: ["src/index.ts"] },
		files: { "src/index.ts": MINIMAL_EXTENSION },
	});
	const entry = join(root, "src", "index.ts");

	await assert.rejects(
		() =>
			resolvePiExtensionSources(
				[
					{ kind: "local", id: "dup.one", version: "1", entry },
					{ kind: "local", id: "dup.one", version: "1", entry },
				],
				scratch,
			),
		/重复/,
	);
});

test("同一输入产生确定性 manifest，且 sha256 与产物一致", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { extensions: ["src/index.ts"] },
		files: { "src/index.ts": MINIMAL_EXTENSION },
	});
	const sources = [
		{
			kind: "local" as const,
			id: "fixture.one",
			version: "7",
			entry: join(root, "src", "index.ts"),
		},
	];
	const rootA = join(scratch, "a");
	const rootB = join(scratch, "b");

	const first = await buildPiResourceBundle({
		root: rootA,
		bundleVersion: "test",
		piSdkVersion: "1.1.0",
		sources,
	});
	const second = await buildPiResourceBundle({
		root: rootB,
		bundleVersion: "test",
		piSdkVersion: "1.1.0",
		sources,
	});

	assert.deepEqual(first, second);
	assert.deepEqual(
		first.resources.map((resource) => resource.id),
		["fixture.one"],
	);
	for (const resource of first.resources) {
		const content = await readFile(join(rootA, resource.path));
		assert.equal(
			createHash("sha256").update(content).digest("hex"),
			resource.sha256,
		);
	}
	// manifest 是构建产物的一部分，且与内存对象一致
	const written = JSON.parse(
		await readFile(join(rootA, "manifest.json"), "utf8"),
	) as unknown;
	assert.deepEqual(written, first);
});

test("真实默认来源可产出 Bundle 并复制许可原文", async () => {
	const scratch = await makeScratchTracked();
	const root = join(scratch, "pi-resources");

	const manifest = await buildPiResourceBundle({
		root,
		bundleVersion: "0.0.0-test",
		piSdkVersion: "1.1.0",
	});

	assert.deepEqual(
		manifest.resources.map((resource) => resource.id),
		["community.pi-simplify", "vcp.tool-policy"],
	);
	for (const resource of manifest.resources) {
		assert.equal(resource.kind, "extension");
		assert.ok(existsSync(join(root, resource.path)));
	}
	const license = join(root, "licenses", "community.pi-simplify-LICENSE.txt");
	assert.ok(existsSync(license), "社区包许可必须随 Bundle 复制");
	assert.match(await readFile(license, "utf8"), /MIT License/);
});

test("许可文件缺失时拒绝，不生成伪成功的 Bundle", async () => {
	const scratch = await makeScratchTracked();
	const root = await makePackage({
		pi: { extensions: ["src/index.ts"] },
		files: { "src/index.ts": MINIMAL_EXTENSION },
	});

	await assert.rejects(
		() =>
			buildPiResourceBundle({
				root: join(scratch, "out"),
				bundleVersion: "test",
				piSdkVersion: "1.1.0",
				sources: [
					{
						kind: "package",
						id: "fixture.bad",
						packageName: "fixture-pi-package",
						version: "1.0.0",
						licenseFile: join(root, "MISSING-LICENSE.txt"),
					},
				],
			}),
		/许可/,
	);
});

test("构建失败时移除旧 manifest，不用陈旧摘要掩盖失败", async () => {
	const scratch = await makeScratchTracked();
	const root = join(scratch, "out");
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "manifest.json"),
		JSON.stringify({ stale: true }),
	);

	await assert.rejects(() =>
		buildPiResourceBundle({
			root,
			bundleVersion: "test",
			piSdkVersion: "1.1.0",
			sources: [
				{
					kind: "local",
					id: "fixture.missing",
					version: "1",
					entry: join(scratch, "not-here.ts"),
				},
			],
		}),
	);

	assert.equal(
		existsSync(join(root, "manifest.json")),
		false,
		"失败后不得留下可被校验通过的旧 manifest",
	);
});

test("local 源也复制许可原文，供 vendor 第三方源码时保留版权声明", async () => {
	const scratch = await makeScratchTracked();
	const entry = join(scratch, "vendored-plugin.ts");
	await writeFile(entry, MINIMAL_EXTENSION);
	const licenseSource = join(scratch, "VENDOR-LICENSE.txt");
	await writeFile(licenseSource, "MIT License\n\nCopyright (c) 2026 Vendor\n");
	const root = join(scratch, "out");

	const manifest = await buildPiResourceBundle({
		root,
		bundleVersion: "test",
		piSdkVersion: "1.1.0",
		sources: [
			{
				kind: "local",
				id: "fixture.vendored",
				version: "1",
				entry,
				licenseFile: licenseSource,
			},
		],
	});

	assert.deepEqual(
		manifest.resources.map((resource) => resource.id),
		["fixture.vendored"],
	);
	assert.equal(
		await readFile(
			join(root, "licenses", "fixture.vendored-LICENSE.txt"),
			"utf8",
		),
		"MIT License\n\nCopyright (c) 2026 Vendor\n",
	);
});

test("local 源声明的许可文件缺失时拒绝", async () => {
	const scratch = await makeScratchTracked();
	const entry = join(scratch, "vendored-plugin.ts");
	await writeFile(entry, MINIMAL_EXTENSION);

	await assert.rejects(
		() =>
			buildPiResourceBundle({
				root: join(scratch, "out"),
				bundleVersion: "test",
				piSdkVersion: "1.1.0",
				sources: [
					{
						kind: "local",
						id: "fixture.vendored",
						version: "1",
						entry,
						licenseFile: join(scratch, "MISSING-LICENSE.txt"),
					},
				],
			}),
		/许可/,
	);
});

test("dev 与 release 公共资源逐字节一致，夹具只存在于 dev", async () => {
	const scratch = await makeScratchTracked();

	// release 路径：真实发布入口（pack-release 只在直接执行时才跑 main）。
	const { buildPiResourceBundle: buildReleaseBundle } = (await import(
		"./pack-release.js"
	)) as {
		buildPiResourceBundle: (
			versionDir: string,
			releaseVersion: string,
		) => Promise<void>;
	};
	const versionDir = join(scratch, "apps", "9.9.9");
	await mkdir(versionDir, { recursive: true });
	await buildReleaseBundle(versionDir, "9.9.9");
	const releaseManifest = JSON.parse(
		await readFile(join(versionDir, "pi-resources", "manifest.json"), "utf8"),
	) as PiBundleManifest;

	// dev 路径：真实 dev 脚本（输出到 gitignored 的 packages/client/pi-resources）。
	execFileSync(
		process.execPath,
		["--import", "tsx", "scripts/build-dev-pi-bundle.ts"],
		{ cwd: ROOT, stdio: "pipe" },
	);
	const devManifest = JSON.parse(
		await readFile(
			join(ROOT, "packages", "client", "pi-resources", "manifest.json"),
			"utf8",
		),
	) as PiBundleManifest;

	const common = (manifest: PiBundleManifest) =>
		manifest.resources.filter((resource) => resource.id !== "vcp.dev-fixture");

	assert.deepEqual(
		common(devManifest),
		releaseManifest.resources,
		"dev 与 release 的公共资源（ID/版本/路径/sha256）必须完全一致",
	);
	assert.equal(
		releaseManifest.resources.some(
			(resource) => resource.id === "vcp.dev-fixture",
		),
		false,
		"验收夹具不得进入发布产物",
	);
	assert.equal(
		devManifest.resources.filter(
			(resource) => resource.id === "vcp.dev-fixture",
		).length,
		1,
	);
});
