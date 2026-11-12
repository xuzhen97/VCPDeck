/**
 * 发布构件 esbuild 单文件打包（决策见 docs/adr/0012-bundled-release-artifacts.md）。
 *
 * 策略：
 *  - 业务代码 + 纯 JS 依赖内联为少量 CJS 单文件（与 tsc 产物模块格式一致）；
 *  - 原生模块与 Prisma 运行时/CLI 外部保留，由 staging 依赖精简安装提供；
 *  - client 主进程为单文件入口（Pi worker 已随 ADR-0049 退役）；
 *  - 保留 tsc 构建作为类型检查门禁，esbuild 不负责类型检查。
 */
import { build, type BuildOptions, type Metafile } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(__dirname, "../..");

export interface BundleTarget {
	entry: string;
	outfile: string;
}

function baseOptions(tsconfig: string, external: string[]): BuildOptions {
	return {
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node24",
		tsconfig: resolve(ROOT, tsconfig),
		external,
		sourcemap: false,
		minify: false,
		logLevel: "info",
		absWorkingDir: ROOT,
	};
}

/** Server：NestJS 应用打为单文件（外部保留 Prisma 运行时与 libsql 原生绑定）。 */
export async function bundleServer(outfile: string): Promise<void> {
	await build({
		...baseOptions("packages/server/tsconfig.json", [
			"@prisma/*",
			"@libsql/*",
			// NestJS 惰性 require 的未安装可选 peer（本项目不使用；用到时运行期报错，与现状一致）
			"class-validator",
			"class-transformer",
			"@nestjs/microservices",
			"*.node",
		]),
		entryPoints: [resolve(ROOT, "packages/server/src/main.ts")],
		outfile,
	});
}

/**
 * Client 业务构件外部保留的依赖：`@lydell/node-pty` 原生平台包。
 * Pi SDK 已随 ADR-0049 退役，node-datachannel 随 ADR-0053 退役，均不再出现在发行布局。
 */
export const CLIENT_EXTERNAL = [
	"@lydell/*",
	"*.node",
];

/**
 * Client：主进程打成单文件。
 * 外部保留 @lydell/node-pty 平台包（含原生二进制）。
 */
export async function bundleClient(targets: BundleTarget[]): Promise<void> {
	const options = baseOptions("packages/client/tsconfig.json", CLIENT_EXTERNAL);
	for (const t of targets) {
		await build({
			...options,
			entryPoints: [resolve(ROOT, t.entry)],
			outfile: t.outfile,
		});
	}
}

/**
 * Launcher：独立打为单文件，安装到 app-dir/dist 后不随业务版本切换。
 *
 * `trustedPublicKeyPem` 经 esbuild `define` 注入
 * `packages/launcher/src/trusted-key.ts` 的 `__VCPDECK_RELEASE_PUBLIC_KEY_PEM__`，
 * 使包内只带公钥、不带私钥；缺公钥直接失败，绝不产出无法验签的 Launcher。
 */
export async function bundleLauncher(
	outfile: string,
	trustedPublicKeyPem: string,
): Promise<void> {
	if (trustedPublicKeyPem.trim().length === 0) {
		throw new Error("缺少可信公钥：Launcher 打包必须注入生产公钥");
	}
	await build({
		...baseOptions("packages/launcher/tsconfig.json", []),
		define: {
			__VCPDECK_RELEASE_PUBLIC_KEY_PEM__: JSON.stringify(trustedPublicKeyPem),
		},
		entryPoints: [resolve(ROOT, "packages/launcher/src/main.ts")],
		outfile,
	});
}
