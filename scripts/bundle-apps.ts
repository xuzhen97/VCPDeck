/**
 * 发布构件 esbuild 单文件打包（决策见 docs/adr/0012-bundled-release-artifacts.md）。
 *
 * 策略：
 *  - 业务代码 + 纯 JS 依赖内联为少量 CJS 单文件（与 tsc 产物模块格式一致）；
 *  - 原生模块、Prisma 运行时/CLI、Pi SDK 等外部保留，由 staging 依赖精简安装提供；
 *  - client 主进程会 fork 两个本地 worker（pi/worker.js、probe-worker.js），
 *    必须各自打成独立文件，否则 fork(__dirname/...) 找不到入口；
 *  - 保留 tsc 构建作为类型检查门禁，esbuild 不负责类型检查。
 */
import { build, type BuildOptions } from "esbuild";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

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
 * Client：主进程 + pi/probe 两个 fork worker 各自打包。
 * 外部保留 Pi SDK（含动态 import 与子进程加载）与 @lydell/node-pty 平台包。
 */
export async function bundleClient(targets: BundleTarget[]): Promise<void> {
	const options = baseOptions("packages/client/tsconfig.json", [
		"@earendil-works/*",
		"@lydell/*",
		"*.node",
	]);
	for (const t of targets) {
		await build({
			...options,
			entryPoints: [resolve(ROOT, t.entry)],
			outfile: t.outfile,
		});
	}
}

/** Launcher：独立打为单文件，安装到 app-dir/dist 后不随业务版本切换。 */
export async function bundleLauncher(outfile: string): Promise<void> {
	await build({
		...baseOptions("packages/launcher/tsconfig.json", []),
		entryPoints: [resolve(ROOT, "packages/launcher/src/main.ts")],
		outfile,
	});
}
