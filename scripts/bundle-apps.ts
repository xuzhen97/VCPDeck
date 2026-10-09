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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * Pi 运行所需的最小依赖树：SDK 已单独打成单文件（`bundlePiSdk`），
 * 其余 pi-* 包全部内联其中，因此不再作为外部依赖安装。
 */
export const PI_SDK_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi SDK 的图片链路依赖（Photon WASM）。
 *
 * 它必须**保持 external** 并作为真实包存在于发行布局：它按 `__dirname` 读取同目录的
 * `photon_rs_bg.wasm`，一旦被内联进单文件，wasm 定位失效，所有图片会被静默替换为
 * `[Image omitted: ...]`（无错误码、无审计）。两个标记用于构建期断言内联与否：
 * - `PI_PHOTON_INLINED_MARKER`：esbuild 内联模块时会写入该包的模块路径键，external 时为 0；
 * - 产物必须保留裸说明符动态 import（`PI_PHOTON_IMPORT`）。
 */
export const PI_PHOTON_PACKAGE = "@silvia-odwyer/photon-node";
/** esbuild 内联该包时会出现的模块路径片段（实测：内联 2 次 / external 0 次）。 */
export const PI_PHOTON_INLINED_MARKER = "@silvia-odwyer+photon-node";
/** 产物中必须保留的裸说明符动态 import 字面量。 */
export const PI_PHOTON_IMPORT = JSON.stringify(PI_PHOTON_PACKAGE);

/**
 * Pi SDK 单文件产物（`define PI_BUNDLED_NODE=true`）。
 *
 * 为什么必须打包（实测数据）：未打包时 Client 发布件是真 `node_modules`（14,688 文件 /
 * 162 MB），SDK 的 ESM 图约 2,400 个文件；在带实时扫描的机器上**每个文件首次打开 ~19.6ms**
 * （同为 NVMe SSD 上重读仅 0.41ms，已排除存储层），冷加载因此达 47.8s，稳定超时。
 * 打包后只付 1 次文件打开 + 解析（实测 ≈0.5s）。
 *
 * 两个关键开关：
 * - `define: { PI_BUNDLED_NODE: "true" }`：启 SDK 自带的「嵌入模块」路径（`virtual-modules.js`），
 *   使扩展（插件）运行时 `import "@earendil-works/pi-coding-agent"` 解析到内存模块，
 *   不依赖目标机 node_modules；
 * - `banner` 注入 `createRequire`：CJS 依赖（cross-spawn 等）会做动态 require，
 *   ESM 产物里必须提供 require。
 *
 * 输出目录必须自带 `package.json`（SDK 从 `import.meta.url` 上推读自身版本，
 * 用于 `VERSION` 与 Bundle 的 piSdkVersion 一致性）。
 */
export async function bundlePiSdk(outDir: string): Promise<string> {
	const clientPackagePath = resolve(ROOT, "packages/client/package.json");
	let clientPkg: { dependencies?: Record<string, string> };
	try {
		clientPkg = JSON.parse(readFileSync(clientPackagePath, "utf8")) as {
			dependencies?: Record<string, string>;
		};
	} catch (error) {
		throw new Error(
			`[bundle-apps] 无法解析 ${clientPackagePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const version = clientPkg.dependencies?.[PI_SDK_PACKAGE];
	if (!version) {
		throw new Error(
			`[bundle-apps] packages/client 未声明 ${PI_SDK_PACKAGE}`,
		);
	}
	mkdirSync(outDir, { recursive: true });
	const outfile = join(outDir, "index.mjs");
	await build({
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		tsconfig: resolve(ROOT, "packages/client/tsconfig.json"),
		absWorkingDir: ROOT,
		stdin: {
			contents: `export * from "${PI_SDK_PACKAGE}";\n`,
			resolveDir: resolve(ROOT, "packages/client"),
			loader: "ts",
			sourcefile: "pi-sdk-entry.ts",
		},
		outfile,
		define: { PI_BUNDLED_NODE: "true" },
		banner: {
			js: 'import { createRequire as __vcpCreateRequire } from "node:module"; const require = __vcpCreateRequire(import.meta.url);',
		},
		// 原生模块不在 Pi SDK 图内；显式保留以防御未来新增的绑定包。
		// photon-node 必须外部化：它按 __dirname 读取同目录的 photon_rs_bg.wasm，
		// 一旦内联进单文件，wasm 定位失效，图片会被静默替换为省略提示
		// （见 scripts/pi-image-pipeline.test.ts 的回归门禁）。
		external: ["*.node", PI_PHOTON_PACKAGE],
		sourcemap: false,
		minify: false,
		logLevel: "warning",
	});
	writeFileSync(
		join(outDir, "package.json"),
		`${JSON.stringify(
			{
				name: PI_SDK_PACKAGE,
				version,
				type: "module",
				main: "./index.mjs",
				exports: { ".": "./index.mjs" },
			},
			null,
			2,
		)}\n`,
	);
	await verifyPiSdkBundle(outfile, version);
	return outfile;
}

/**
 * 构建期自检：分两次失败都很贵（探测误判、插件加载断裂），因此在打包现场就验证。
 * 断言三件与 SDK 升级强相关的事实：
 * 1. `VERSION` 可从 `import.meta.url` 上推的 `package.json` 读到（与 Bundle manifest 比对用）；
 * 2. 会话/模型/扩展加载入口确实导出（树摇或环境分支变化会在此暴露）；
 * 3. 扩展（插件）运行时 `import "<SDK 包名>"` 能解析——这是 `PI_BUNDLED_NODE` 嵌入模块分支
 *    生效的直接证据，也是「插件系统不受影响」的唯一可自动验证点；
 * 4. 图片链路依赖 `PI_PHOTON_PACKAGE` 未被内联（内联会让图片静默失效，见该常量注释）。
 */
async function verifyPiSdkBundle(
	outfile: string,
	expectedVersion: string,
): Promise<void> {
	const mod = (await import(pathToFileURL(outfile).href)) as Record<
		string,
		unknown
	>;
	if (mod.VERSION !== expectedVersion) {
		throw new Error(
			`[bundle-apps] Pi SDK 产物 VERSION=${String(mod.VERSION)} 与声明 ${expectedVersion} 不一致（package.json 定位失败？）`,
		);
	}
	for (const name of [
		"ModelRuntime",
		"SessionManager",
		"SettingsManager",
		"createAgentSessionServices",
		"createAgentSessionFromServices",
		"discoverAndLoadExtensions",
	]) {
		if (typeof mod[name] !== "function") {
			throw new Error(`[bundle-apps] Pi SDK 产物缺少导出 ${name}`);
		}
	}
	const probe = join(dirname(outfile), ".plugin-probe.mjs");
	writeFileSync(
		probe,
		`import * as sdk from ${JSON.stringify(PI_SDK_PACKAGE)};\n` +
			`import * as typebox from "typebox";\n` +
			`export default function () {\n` +
			`\tglobalThis.__vcpPiSdkProbe = { sdk: typeof sdk.VERSION === "string", typebox: typeof typebox.Type === "object" };\n` +
			`}\n`,
	);
	try {
		// 必须经 SDK 自己的扩展加载器：它才是把 SDK 包名与 typebox 映射到嵌入模块的那一层。
		// 直接 import 探针文件会因磁盘上不存在这些包而失败（这正是本决策要验证的反面）。
		interface ProbeGlobal {
			__vcpPiSdkProbe?: { sdk?: boolean; typebox?: boolean };
		}
		const globals = globalThis as ProbeGlobal;
		delete globals.__vcpPiSdkProbe;
		const loader = mod.discoverAndLoadExtensions as (
			paths: string[],
			cwd: string,
		) => Promise<{ extensions: unknown[] }>;
		const loaded = await loader([probe], process.cwd());
		// `delete` 会让 TS 把该属性窄化为 undefined，因此显式取回声明类型，
		// 否则下面的 observed?.sdk 会被报为「property does not exist on never」。
		const observed = globals.__vcpPiSdkProbe as ProbeGlobal["__vcpPiSdkProbe"];
		if (loaded.extensions.length === 0 || observed?.sdk !== true || observed?.typebox !== true) {
			throw new Error(
				`探针未在嵌入模块下解析（扩展数=${loaded.extensions.length}, sdk=${String(observed?.sdk)}, typebox=${String(observed?.typebox)}）`,
			);
		}
	} catch (error) {
		throw new Error(
			`[bundle-apps] 插件运行时无法从内存模块解析 ${PI_SDK_PACKAGE} / typebox（PI_BUNDLED_NODE 嵌入模块分支失效？）：${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		rmSync(probe, { force: true });
	}

	// 图片链路：Photon 必须保持 external。内联后它的 wasm 定位路径失效，图片会被静默
	// 替换为省略提示（无错误码），因此把该回归拦在构建期，而不是等人去跑手动门禁。
	const bundleText = readFileSync(outfile, "utf8");
	if (bundleText.includes(PI_PHOTON_INLINED_MARKER)) {
		throw new Error(
			`[bundle-apps] ${PI_PHOTON_PACKAGE} 被内联进单文件产物（出现 ${PI_PHOTON_INLINED_MARKER}），图片链路会静默失效；请检查 bundlePiSdk 的 external 列表`,
		);
	}
	if (!bundleText.includes(PI_PHOTON_IMPORT)) {
		throw new Error(
			`[bundle-apps] 单文件产物未保留 ${PI_PHOTON_PACKAGE} 的动态 import，图片链路会静默失效`,
		);
	}
}

/**
 * Client 业务构件外部保留的依赖：`@lydell/node-pty` 与 node-datachannel 原生平台包、
 * 以及 Pi SDK（其产物为单文件 `dist/pi-sdk/`，运行时按包名解析到那里）。
 */
export const CLIENT_EXTERNAL = [
	"@earendil-works/*",
	"@lydell/*",
	"*.node",
	"node-datachannel",
	"node-datachannel/*",
];

/**
 * Pi Resource Bundle 策略扩展：打成**自包含 ESM 单文件**。
 *
 * 两个约束（都来自实测）：
 * - 必须 ESM：Pi 的扩展加载器用 `jiti.import(path, { default: true })` 取工厂，
 *   esbuild 的 CJS 包装（`exports.default`）在该取法下取不到工厂，而 `export default` 可以；
 * - 必须自包含：不 external 任何依赖，避免依赖目标机上 node_modules 的布局。
 */
export async function bundlePiExtension(
	outfile: string,
	/** 入口源码路径（相对仓库根）；默认受信工具策略扩展。 */
	entry = "packages/client/src/pi-bundle/tool-policy/index.ts",
): Promise<void> {
	await build({
		...baseOptions("packages/client/tsconfig.json", []),
		format: "esm",
		entryPoints: [resolve(ROOT, entry)],
		outfile,
	});
}

/**
 * Client：主进程 + pi/probe 两个 fork worker 各自打包。
 * 外部保留 Pi SDK（含动态 import 与子进程加载）与 @lydell/node-pty / node-datachannel 平台包。
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

/** Launcher：独立打为单文件，安装到 app-dir/dist 后不随业务版本切换。 */
export async function bundleLauncher(outfile: string): Promise<void> {
	await build({
		...baseOptions("packages/launcher/tsconfig.json", []),
		entryPoints: [resolve(ROOT, "packages/launcher/src/main.ts")],
		outfile,
	});
}
